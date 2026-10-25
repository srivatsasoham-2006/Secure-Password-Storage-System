import sqlite3
import os
import json
from datetime import datetime, timezone
from config import Config

def get_db_path():
    return Config.DATABASE_PATH

def get_connection():
    db_path = get_db_path()
    # Ensure directory exists
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=15)
    conn.row_factory = sqlite3.Row
    # Enable WAL mode for high performance concurrency
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def init_db():
    """Initialize database tables with indexes."""
    with get_connection() as conn:
        cursor = conn.cursor()
        
        # User Table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                salt TEXT NOT NULL,
                encryption_salt TEXT NOT NULL,
                two_factor_secret TEXT,
                two_factor_enabled BOOLEAN DEFAULT 0,
                recovery_codes TEXT,
                failed_attempts INTEGER DEFAULT 0,
                locked_until TEXT,
                theme TEXT DEFAULT 'dark',
                sound_enabled BOOLEAN DEFAULT 1,
                sound_volume REAL DEFAULT 0.6,
                auto_lock_minutes INTEGER DEFAULT 15,
                created_at TEXT NOT NULL,
                last_login TEXT
            )
        """)
        
        # Vault Items Table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS vault_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                category TEXT NOT NULL,
                title TEXT NOT NULL,
                encrypted_username TEXT,
                encrypted_password TEXT,
                encrypted_url TEXT,
                encrypted_notes TEXT,
                encrypted_totp_secret TEXT,
                encrypted_extra_json TEXT,
                folder TEXT DEFAULT 'Personal',
                tags TEXT DEFAULT '',
                is_favorite BOOLEAN DEFAULT 0,
                is_deleted BOOLEAN DEFAULT 0,
                deleted_at TEXT,
                strength_score INTEGER DEFAULT 0,
                is_compromised BOOLEAN DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            )
        """)
        
        # Password History Table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS password_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                item_id INTEGER NOT NULL,
                encrypted_password TEXT NOT NULL,
                changed_at TEXT NOT NULL,
                FOREIGN KEY (item_id) REFERENCES vault_items (id) ON DELETE CASCADE
            )
        """)
        
        # Audit Logs Table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS audit_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                action TEXT NOT NULL,
                item_title TEXT,
                ip_address TEXT,
                user_agent TEXT,
                status TEXT DEFAULT 'SUCCESS',
                timestamp TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
            )
        """)
        
        # Create indexes
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_vault_user_id ON vault_items(user_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_vault_category ON vault_items(category)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_vault_is_deleted ON vault_items(is_deleted)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_audit_user_id ON audit_logs(user_id)")
        
        conn.commit()

# --- User Repository ---

def get_user_by_id(user_id: int):
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return dict(row) if row else None

def get_user_by_username(username: str):
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM users WHERE LOWER(username) = LOWER(?)", (username.strip(),)).fetchone()
        return dict(row) if row else None

def get_user_by_email(email: str):
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM users WHERE LOWER(email) = LOWER(?)", (email.strip(),)).fetchone()
        return dict(row) if row else None

def create_user(username: str, email: str, password_hash: str, salt: str, encryption_salt: str, recovery_codes: list[str]):
    now = datetime.now(timezone.utc).isoformat()
    recovery_json = json.dumps(recovery_codes)
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO users (username, email, password_hash, salt, encryption_salt, recovery_codes, created_at, last_login)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (username.strip(), email.strip().lower(), password_hash, salt, encryption_salt, recovery_json, now, now))
        conn.commit()
        return cursor.lastrowid

def update_user_login(user_id: int, reset_failed: bool = True):
    now = datetime.now(timezone.utc).isoformat()
    with get_connection() as conn:
        if reset_failed:
            conn.execute("UPDATE users SET last_login = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?", (now, user_id))
        else:
            conn.execute("UPDATE users SET last_login = ? WHERE id = ?", (now, user_id))
        conn.commit()

def record_failed_login(user_id: int, max_attempts: int = 5, lockout_minutes: int = 15):
    with get_connection() as conn:
        row = conn.execute("SELECT failed_attempts FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            return
        attempts = (row['failed_attempts'] or 0) + 1
        locked_until = None
        if attempts >= max_attempts:
            from datetime import timedelta
            lock_time = datetime.now(timezone.utc) + timedelta(minutes=lockout_minutes)
            locked_until = lock_time.isoformat()
        conn.execute("UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?", (attempts, locked_until, user_id))
        conn.commit()

def update_user_preferences(user_id: int, theme: str = None, sound_enabled: bool = None, sound_volume: float = None, auto_lock_minutes: int = None):
    fields = []
    values = []
    if theme is not None:
        fields.append("theme = ?")
        values.append(theme)
    if sound_enabled is not None:
        fields.append("sound_enabled = ?")
        values.append(1 if sound_enabled else 0)
    if sound_volume is not None:
        fields.append("sound_volume = ?")
        values.append(float(sound_volume))
    if auto_lock_minutes is not None:
        fields.append("auto_lock_minutes = ?")
        values.append(int(auto_lock_minutes))
    
    if not fields:
        return
    
    values.append(user_id)
    with get_connection() as conn:
        conn.execute(f"UPDATE users SET {', '.join(fields)} WHERE id = ?", tuple(values))
        conn.commit()

def update_master_password(user_id: int, new_password_hash: str, new_salt: str, new_encryption_salt: str):
    with get_connection() as conn:
        conn.execute("""
            UPDATE users 
            SET password_hash = ?, salt = ?, encryption_salt = ? 
            WHERE id = ?
        """, (new_password_hash, new_salt, new_encryption_salt, user_id))
        conn.commit()

def set_user_2fa(user_id: int, secret: str, enabled: bool):
    with get_connection() as conn:
        conn.execute("""
            UPDATE users SET two_factor_secret = ?, two_factor_enabled = ? WHERE id = ?
        """, (secret, 1 if enabled else 0, user_id))
        conn.commit()

# --- Vault Items Repository ---

def create_vault_item(user_id: int, category: str, title: str, 
                      encrypted_username: str = '', encrypted_password: str = '', 
                      encrypted_url: str = '', encrypted_notes: str = '', 
                      encrypted_totp_secret: str = '', encrypted_extra_json: str = '',
                      folder: str = 'Personal', tags: str = '', is_favorite: bool = False,
                      strength_score: int = 0):
    now = datetime.now(timezone.utc).isoformat()
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO vault_items (
                user_id, category, title, encrypted_username, encrypted_password, 
                encrypted_url, encrypted_notes, encrypted_totp_secret, encrypted_extra_json,
                folder, tags, is_favorite, is_deleted, strength_score, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
        """, (user_id, category, title.strip(), encrypted_username, encrypted_password,
              encrypted_url, encrypted_notes, encrypted_totp_secret, encrypted_extra_json,
              folder, tags, 1 if is_favorite else 0, strength_score, now, now))
        item_id = cursor.lastrowid
        
        # Record initial password history if password exists
        if encrypted_password:
            cursor.execute("""
                INSERT INTO password_history (item_id, encrypted_password, changed_at)
                VALUES (?, ?, ?)
            """, (item_id, encrypted_password, now))
            
        conn.commit()
        return item_id

def get_vault_item(item_id: int, user_id: int):
    with get_connection() as conn:
        row = conn.execute("SELECT * FROM vault_items WHERE id = ? AND user_id = ?", (item_id, user_id)).fetchone()
        return dict(row) if row else None

def get_user_vault_items(user_id: int, category: str = None, folder: str = None, 
                         is_favorite: bool = None, is_deleted: bool = False, search: str = None):
    query = "SELECT * FROM vault_items WHERE user_id = ?"
    params = [user_id]
    
    if is_deleted is not None:
        query += " AND is_deleted = ?"
        params.append(1 if is_deleted else 0)
        
    if category and category != 'all':
        query += " AND category = ?"
        params.append(category)
        
    if folder and folder != 'all':
        query += " AND folder = ?"
        params.append(folder)
        
    if is_favorite is True:
        query += " AND is_favorite = 1"
        
    if search:
        search_pattern = f"%{search.strip().lower()}%"
        query += " AND (LOWER(title) LIKE ? OR LOWER(folder) LIKE ? OR LOWER(tags) LIKE ?)"
        params.extend([search_pattern, search_pattern, search_pattern])
        
    query += " ORDER BY is_favorite DESC, updated_at DESC"
    
    with get_connection() as conn:
        rows = conn.execute(query, tuple(params)).fetchall()
        return [dict(r) for r in rows]

def update_vault_item(item_id: int, user_id: int, category: str, title: str,
                      encrypted_username: str, encrypted_password: str,
                      encrypted_url: str, encrypted_notes: str,
                      encrypted_totp_secret: str, encrypted_extra_json: str,
                      folder: str, tags: str, is_favorite: bool, strength_score: int):
    now = datetime.now(timezone.utc).isoformat()
    with get_connection() as conn:
        cursor = conn.cursor()
        # Check if password changed to record in history
        old = cursor.execute("SELECT encrypted_password FROM vault_items WHERE id = ? AND user_id = ?", (item_id, user_id)).fetchone()
        if old and old['encrypted_password'] != encrypted_password and encrypted_password:
            cursor.execute("""
                INSERT INTO password_history (item_id, encrypted_password, changed_at)
                VALUES (?, ?, ?)
            """, (item_id, encrypted_password, now))
            
        cursor.execute("""
            UPDATE vault_items SET
                category = ?, title = ?, encrypted_username = ?, encrypted_password = ?,
                encrypted_url = ?, encrypted_notes = ?, encrypted_totp_secret = ?,
                encrypted_extra_json = ?, folder = ?, tags = ?, is_favorite = ?,
                strength_score = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
        """, (category, title.strip(), encrypted_username, encrypted_password,
              encrypted_url, encrypted_notes, encrypted_totp_secret, encrypted_extra_json,
              folder, tags, 1 if is_favorite else 0, strength_score, now, item_id, user_id))
        conn.commit()

def toggle_favorite(item_id: int, user_id: int):
    with get_connection() as conn:
        conn.execute("""
            UPDATE vault_items SET is_favorite = CASE WHEN is_favorite = 1 THEN 0 ELSE 1 END
            WHERE id = ? AND user_id = ?
        """, (item_id, user_id))
        conn.commit()

def soft_delete_vault_item(item_id: int, user_id: int):
    now = datetime.now(timezone.utc).isoformat()
    with get_connection() as conn:
        conn.execute("""
            UPDATE vault_items SET is_deleted = 1, deleted_at = ?
            WHERE id = ? AND user_id = ?
        """, (now, item_id, user_id))
        conn.commit()

def restore_vault_item(item_id: int, user_id: int):
    with get_connection() as conn:
        conn.execute("""
            UPDATE vault_items SET is_deleted = 0, deleted_at = NULL
            WHERE id = ? AND user_id = ?
        """, (item_id, user_id))
        conn.commit()

def permanently_delete_vault_item(item_id: int, user_id: int):
    with get_connection() as conn:
        conn.execute("DELETE FROM password_history WHERE item_id = ?", (item_id,))
        conn.execute("DELETE FROM vault_items WHERE id = ? AND user_id = ?", (item_id, user_id))
        conn.commit()

def empty_trash(user_id: int):
    with get_connection() as conn:
        rows = conn.execute("SELECT id FROM vault_items WHERE user_id = ? AND is_deleted = 1", (user_id,)).fetchall()
        for r in rows:
            conn.execute("DELETE FROM password_history WHERE item_id = ?", (r['id'],))
        conn.execute("DELETE FROM vault_items WHERE user_id = ? AND is_deleted = 1", (user_id,))
        conn.commit()

def get_password_history(item_id: int, limit: int = 10):
    with get_connection() as conn:
        rows = conn.execute("""
            SELECT * FROM password_history WHERE item_id = ? ORDER BY changed_at DESC LIMIT ?
        """, (item_id, limit)).fetchall()
        return [dict(r) for r in rows]

# --- Audit Logs Repository ---

def log_audit_event(user_id: int, action: str, item_title: str = None, 
                    ip_address: str = None, user_agent: str = None, status: str = 'SUCCESS'):
    now = datetime.now(timezone.utc).isoformat()
    with get_connection() as conn:
        conn.execute("""
            INSERT INTO audit_logs (user_id, action, item_title, ip_address, user_agent, status, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (user_id, action, item_title, ip_address, user_agent, status, now))
        conn.commit()

def get_user_audit_logs(user_id: int, limit: int = 50):
    with get_connection() as conn:
        rows = conn.execute("""
            SELECT * FROM audit_logs WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?
        """, (user_id, limit)).fetchall()
        return [dict(r) for r in rows]

def clear_user_audit_logs(user_id: int):
    with get_connection() as conn:
        conn.execute("DELETE FROM audit_logs WHERE user_id = ?", (user_id,))
        conn.commit()
