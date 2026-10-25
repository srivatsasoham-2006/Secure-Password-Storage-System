import os
import csv
import io
import json
import base64
from functools import wraps
from flask import (
    Flask, render_template, request, jsonify, session,
    redirect, url_for, send_file, make_response
)
from config import Config
import crypto_vault
import models

app = Flask(__name__)
app.config.from_object(Config)

# Ensure database tables exist
models.init_db()

# --- Security Headers & Response Middleware ---

@app.after_request
def apply_security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['X-XSS-Protection'] = '1; mode=block'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    response.headers['Content-Security-Policy'] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data:; "
        "connect-src 'self' https://api.pwnedpasswords.com;"
    )
    return response

# --- Auth Decorator ---

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user_id' not in session or 'vault_key' not in session:
            if request.is_json or request.path.startswith('/api/'):
                return jsonify({"success": False, "error": "Unauthorized"}), 401
            return redirect(url_for('login_view'))
        return f(*args, **kwargs)
    return decorated_function

def get_session_vault_key() -> bytes:
    """Retrieve the per-session symmetric AES-256 encryption key."""
    key_b64 = session.get('vault_key')
    if not key_b64:
        raise ValueError("Vault key not found in session")
    return base64.b64decode(key_b64.encode('utf-8'))

def get_client_ip():
    return request.headers.get('X-Forwarded-For', request.remote_addr or '127.0.0.1').split(',')[0].strip()

# --- Page Routes ---

@app.route('/')
def index():
    if 'user_id' not in session or 'vault_key' not in session:
        return redirect(url_for('login_view'))
    return render_template('index.html')

@app.route('/login')
def login_view():
    if 'user_id' in session and 'vault_key' in session:
        return redirect(url_for('index'))
    return render_template('auth.html')

@app.route('/logout')
def logout_view():
    user_id = session.get('user_id')
    if user_id:
        models.log_audit_event(user_id, 'USER_LOGOUT', ip_address=get_client_ip())
    session.clear()
    return redirect(url_for('login_view'))

# --- Auth APIs ---

@app.route('/api/auth/register', methods=['POST'])
def api_register():
    data = request.get_json() or {}
    username = data.get('username', '').strip()
    email = data.get('email', '').strip().lower()
    password = data.get('password', '')

    if not username or not email or not password:
        return jsonify({"success": False, "error": "Username, email, and master password are required."}), 400

    if len(password) < 12:
        return jsonify({"success": False, "error": "Master password must be at least 12 characters."}), 400

    if models.get_user_by_username(username):
        return jsonify({"success": False, "error": "Username is already registered."}), 409

    if models.get_user_by_email(email):
        return jsonify({"success": False, "error": "Email is already registered."}), 409

    # Generate distinct salts for auth hash and vault symmetric key
    auth_salt = crypto_vault.generate_salt(32)
    enc_salt = crypto_vault.generate_salt(32)

    password_hash, auth_salt_b64 = crypto_vault.hash_password(password, auth_salt)
    enc_salt_b64 = base64.b64encode(enc_salt).decode('utf-8')
    recovery_codes = crypto_vault.generate_recovery_codes(8)

    user_id = models.create_user(
        username=username,
        email=email,
        password_hash=password_hash,
        salt=auth_salt_b64,
        encryption_salt=enc_salt_b64,
        recovery_codes=recovery_codes
    )

    # Derive symmetric vault key and initialize session
    vault_key = crypto_vault.derive_key(password, enc_salt)
    session['user_id'] = user_id
    session['username'] = username
    session['vault_key'] = base64.b64encode(vault_key).decode('utf-8')
    session.permanent = True

    models.log_audit_event(user_id, 'VAULT_INITIALIZED', ip_address=get_client_ip())

    # Create helpful starter items for new user
    starter_key = vault_key
    models.create_vault_item(
        user_id=user_id,
        category='login',
        title='Welcome to SentinelVault',
        encrypted_username=crypto_vault.encrypt_data(username, starter_key),
        encrypted_password=crypto_vault.encrypt_data('Welcome#To#Sentinel2026!', starter_key),
        encrypted_url=crypto_vault.encrypt_data('https://sentinelvault.io', starter_key),
        encrypted_notes=crypto_vault.encrypt_data('Your industrial-grade zero-knowledge password vault is active with AES-256-GCM encryption.', starter_key),
        folder='Personal',
        tags='welcome, security',
        strength_score=4
    )

    return jsonify({
        "success": True,
        "message": "Vault created successfully.",
        "recovery_codes": recovery_codes
    })

@app.route('/api/auth/login', methods=['POST'])
def api_login():
    data = request.get_json() or {}
    identifier = data.get('username', '').strip()
    password = data.get('password', '')
    token = data.get('token', '').strip()

    if not identifier or not password:
        return jsonify({"success": False, "error": "Please provide credentials."}), 400

    user = models.get_user_by_username(identifier) or models.get_user_by_email(identifier)
    if not user:
        return jsonify({"success": False, "error": "Invalid master credentials."}), 401

    # Check lockout
    if user['locked_until']:
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc)
        lock_until = datetime.fromisoformat(user['locked_until'])
        if now < lock_until:
            rem_mins = int((lock_until - now).total_seconds() / 60) + 1
            return jsonify({
                "success": False, 
                "error": f"Account locked due to consecutive failed attempts. Try again in {rem_mins} minutes."
            }), 403

    # Verify PBKDF2 hash
    valid_password = crypto_vault.verify_password(password, user['salt'], user['password_hash'])
    if not valid_password:
        models.record_failed_login(user['id'])
        models.log_audit_event(user['id'], 'LOGIN_FAILED', ip_address=get_client_ip(), status='FAILED')
        return jsonify({"success": False, "error": "Invalid master credentials."}), 401

    # Check 2FA if enabled
    if user['two_factor_enabled']:
        if not token:
            return jsonify({"success": False, "requires_2fa": True}), 200
        
        # Verify either TOTP code or Emergency Recovery code
        totp_valid = crypto_vault.verify_totp_code(user['two_factor_secret'], token)
        recovery_valid = False

        if not totp_valid and user['recovery_codes']:
            rec_codes = json.loads(user['recovery_codes'])
            if token in rec_codes:
                recovery_valid = True
                # Remove used recovery code
                rec_codes.remove(token)
                with models.get_connection() as conn:
                    conn.execute("UPDATE users SET recovery_codes = ? WHERE id = ?", (json.dumps(rec_codes), user['id']))
                    conn.commit()

        if not totp_valid and not recovery_valid:
            return jsonify({"success": False, "error": "Invalid 2FA code or recovery key."}), 401

    # Successful login: derive vault symmetric key
    enc_salt = base64.b64decode(user['encryption_salt'].encode('utf-8'))
    vault_key = crypto_vault.derive_key(password, enc_salt)

    session['user_id'] = user['id']
    session['username'] = user['username']
    session['vault_key'] = base64.b64encode(vault_key).decode('utf-8')
    session.permanent = True

    models.update_user_login(user['id'], reset_failed=True)
    models.log_audit_event(user['id'], 'LOGIN_SUCCESS', ip_address=get_client_ip())

    return jsonify({"success": True, "message": "Vault unlocked."})

@app.route('/api/auth/me')
@login_required
def api_me():
    user = models.get_user_by_id(session['user_id'])
    if not user:
        return jsonify({"success": False, "error": "User not found"}), 404
    return jsonify({
        "success": True,
        "user": {
            "id": user['id'],
            "username": user['username'],
            "email": user['email'],
            "two_factor_enabled": bool(user['two_factor_enabled']),
            "theme": user['theme'],
            "sound_enabled": bool(user['sound_enabled']),
            "sound_volume": user['sound_volume'],
            "auto_lock_minutes": user['auto_lock_minutes'],
            "created_at": user['created_at'],
            "last_login": user['last_login']
        }
    })

@app.route('/api/auth/unlock', methods=['POST'])
@login_required
def api_unlock():
    data = request.get_json() or {}
    password = data.get('password', '')
    user = models.get_user_by_id(session['user_id'])

    if not user or not crypto_vault.verify_password(password, user['salt'], user['password_hash']):
        return jsonify({"success": False, "error": "Invalid master password"}), 401

    # Refresh session vault key
    enc_salt = base64.b64decode(user['encryption_salt'].encode('utf-8'))
    vault_key = crypto_vault.derive_key(password, enc_salt)
    session['vault_key'] = base64.b64encode(vault_key).decode('utf-8')

    models.log_audit_event(user['id'], 'VAULT_UNLOCKED', ip_address=get_client_ip())
    return jsonify({"success": True})

@app.route('/api/auth/2fa/setup', methods=['POST'])
@login_required
def api_2fa_setup():
    user = models.get_user_by_id(session['user_id'])
    secret = crypto_vault.generate_totp_secret()
    uri = crypto_vault.get_totp_uri(secret, user['email'])
    qr_svg = crypto_vault.generate_qr_svg(uri)

    session['pending_2fa_secret'] = secret

    return jsonify({
        "success": True,
        "secret": secret,
        "qr_svg": qr_svg
    })

@app.route('/api/auth/2fa/verify', methods=['POST'])
@login_required
def api_2fa_verify():
    data = request.get_json() or {}
    code = data.get('code', '').strip()
    secret = session.get('pending_2fa_secret')

    if not secret:
        return jsonify({"success": False, "error": "No pending 2FA setup found."}), 400

    if not crypto_vault.verify_totp_code(secret, code):
        return jsonify({"success": False, "error": "Invalid verification code."}), 400

    models.set_user_2fa(session['user_id'], secret, enabled=True)
    session.pop('pending_2fa_secret', None)
    models.log_audit_event(session['user_id'], '2FA_ENABLED', ip_address=get_client_ip())

    return jsonify({"success": True, "message": "2FA successfully enabled."})

@app.route('/api/auth/change-master-password', methods=['POST'])
@login_required
def api_change_master_password():
    data = request.get_json() or {}
    cur_pass = data.get('current_password', '')
    new_pass = data.get('new_password', '')

    user = models.get_user_by_id(session['user_id'])
    if not crypto_vault.verify_password(cur_pass, user['salt'], user['password_hash']):
        return jsonify({"success": False, "error": "Current master password incorrect."}), 400

    if len(new_pass) < 12:
        return jsonify({"success": False, "error": "New master password must be at least 12 characters."}), 400

    old_key = get_session_vault_key()

    # Generate new salts and derive new keys
    new_auth_salt = crypto_vault.generate_salt(32)
    new_enc_salt = crypto_vault.generate_salt(32)

    new_hash, new_salt_b64 = crypto_vault.hash_password(new_pass, new_auth_salt)
    new_enc_salt_b64 = base64.b64encode(new_enc_salt).decode('utf-8')
    new_key = crypto_vault.derive_key(new_pass, new_enc_salt)

    # Re-encrypt all user vault items
    items = models.get_user_vault_items(session['user_id'], is_deleted=None)
    for itm in items:
        dec_user = crypto_vault.decrypt_data(itm['encrypted_username'], old_key)
        dec_pass = crypto_vault.decrypt_data(itm['encrypted_password'], old_key)
        dec_url = crypto_vault.decrypt_data(itm['encrypted_url'], old_key)
        dec_notes = crypto_vault.decrypt_data(itm['encrypted_notes'], old_key)
        dec_totp = crypto_vault.decrypt_data(itm['encrypted_totp_secret'], old_key)
        dec_extra = crypto_vault.decrypt_data(itm['encrypted_extra_json'], old_key)

        models.update_vault_item(
            item_id=itm['id'],
            user_id=session['user_id'],
            category=itm['category'],
            title=itm['title'],
            encrypted_username=crypto_vault.encrypt_data(dec_user, new_key),
            encrypted_password=crypto_vault.encrypt_data(dec_pass, new_key),
            encrypted_url=crypto_vault.encrypt_data(dec_url, new_key),
            encrypted_notes=crypto_vault.encrypt_data(dec_notes, new_key),
            encrypted_totp_secret=crypto_vault.encrypt_data(dec_totp, new_key),
            encrypted_extra_json=crypto_vault.encrypt_data(dec_extra, new_key),
            folder=itm['folder'],
            tags=itm['tags'],
            is_favorite=bool(itm['is_favorite']),
            strength_score=itm['strength_score']
        )

    models.update_master_password(session['user_id'], new_hash, new_salt_b64, new_enc_salt_b64)
    session['vault_key'] = base64.b64encode(new_key).decode('utf-8')
    models.log_audit_event(session['user_id'], 'MASTER_PASSWORD_CHANGED', ip_address=get_client_ip())

    return jsonify({"success": True, "message": "Master Password updated and all items re-encrypted."})

# --- Vault CRUD APIs ---

@app.route('/api/vault', methods=['GET'])
@login_required
def api_get_vault():
    user_id = session['user_id']
    key = get_session_vault_key()

    category = request.args.get('category', 'all')
    folder = request.args.get('folder', 'all')
    is_deleted = request.args.get('deleted', '0') == '1'
    search = request.args.get('search')

    raw_items = models.get_user_vault_items(
        user_id=user_id,
        category=category,
        folder=folder,
        is_deleted=is_deleted,
        search=search
    )

    decrypted_items = []
    for itm in raw_items:
        try:
            extra_raw = crypto_vault.decrypt_data(itm['encrypted_extra_json'], key)
            extra_obj = json.loads(extra_raw) if extra_raw else {}
        except Exception:
            extra_obj = {}

        decrypted_items.append({
            "id": itm['id'],
            "category": itm['category'],
            "title": itm['title'],
            "username": crypto_vault.decrypt_data(itm['encrypted_username'], key),
            "password": crypto_vault.decrypt_data(itm['encrypted_password'], key),
            "url": crypto_vault.decrypt_data(itm['encrypted_url'], key),
            "notes": crypto_vault.decrypt_data(itm['encrypted_notes'], key),
            "totp_secret": crypto_vault.decrypt_data(itm['encrypted_totp_secret'], key),
            "extra": extra_obj,
            "folder": itm['folder'],
            "tags": itm['tags'],
            "is_favorite": bool(itm['is_favorite']),
            "is_deleted": bool(itm['is_deleted']),
            "strength_score": itm['strength_score'],
            "created_at": itm['created_at'],
            "updated_at": itm['updated_at']
        })

    return jsonify({"success": True, "items": decrypted_items})

@app.route('/api/vault', methods=['POST'])
@login_required
def api_create_vault_item():
    data = request.get_json() or {}
    user_id = session['user_id']
    key = get_session_vault_key()

    category = data.get('category', 'login')
    title = data.get('title', '').strip()
    if not title:
        return jsonify({"success": False, "error": "Title is required"}), 400

    username = data.get('username', '')
    password = data.get('password', '')
    url = data.get('url', '')
    notes = data.get('notes', '')
    totp_secret = data.get('totp_secret', '')
    extra_dict = data.get('extra', {})
    extra_str = json.dumps(extra_dict) if extra_dict else ''
    folder = data.get('folder', 'Personal')
    tags = data.get('tags', '')

    strength_info = crypto_vault.calculate_password_entropy(password) if password else {"score": 0}

    item_id = models.create_vault_item(
        user_id=user_id,
        category=category,
        title=title,
        encrypted_username=crypto_vault.encrypt_data(username, key),
        encrypted_password=crypto_vault.encrypt_data(password, key),
        encrypted_url=crypto_vault.encrypt_data(url, key),
        encrypted_notes=crypto_vault.encrypt_data(notes, key),
        encrypted_totp_secret=crypto_vault.encrypt_data(totp_secret, key),
        encrypted_extra_json=crypto_vault.encrypt_data(extra_str, key),
        folder=folder,
        tags=tags,
        strength_score=strength_info.get('score', 0)
    )

    models.log_audit_event(user_id, 'ITEM_CREATED', item_title=title, ip_address=get_client_ip())

    return jsonify({"success": True, "item_id": item_id})

@app.route('/api/vault/<int:item_id>', methods=['GET'])
@login_required
def api_get_vault_item(item_id):
    user_id = session['user_id']
    key = get_session_vault_key()

    itm = models.get_vault_item(item_id, user_id)
    if not itm:
        return jsonify({"success": False, "error": "Item not found"}), 404

    extra_raw = crypto_vault.decrypt_data(itm['encrypted_extra_json'], key)
    extra_obj = json.loads(extra_raw) if extra_raw else {}

    # Get password history
    history_raw = models.get_password_history(item_id)
    history = []
    for h in history_raw:
        history.append({
            "password": crypto_vault.decrypt_data(h['encrypted_password'], key),
            "changed_at": h['changed_at']
        })

    models.log_audit_event(user_id, 'ITEM_ACCESSED', item_title=itm['title'], ip_address=get_client_ip())

    return jsonify({
        "success": True,
        "item": {
            "id": itm['id'],
            "category": itm['category'],
            "title": itm['title'],
            "username": crypto_vault.decrypt_data(itm['encrypted_username'], key),
            "password": crypto_vault.decrypt_data(itm['encrypted_password'], key),
            "url": crypto_vault.decrypt_data(itm['encrypted_url'], key),
            "notes": crypto_vault.decrypt_data(itm['encrypted_notes'], key),
            "totp_secret": crypto_vault.decrypt_data(itm['encrypted_totp_secret'], key),
            "extra": extra_obj,
            "folder": itm['folder'],
            "tags": itm['tags'],
            "is_favorite": bool(itm['is_favorite']),
            "is_deleted": bool(itm['is_deleted']),
            "strength_score": itm['strength_score'],
            "created_at": itm['created_at'],
            "updated_at": itm['updated_at'],
            "history": history
        }
    })

@app.route('/api/vault/<int:item_id>', methods=['PUT'])
@login_required
def api_update_vault_item(item_id):
    data = request.get_json() or {}
    user_id = session['user_id']
    key = get_session_vault_key()

    title = data.get('title', '').strip()
    if not title:
        return jsonify({"success": False, "error": "Title is required"}), 400

    category = data.get('category', 'login')
    username = data.get('username', '')
    password = data.get('password', '')
    url = data.get('url', '')
    notes = data.get('notes', '')
    totp_secret = data.get('totp_secret', '')
    extra = json.dumps(data.get('extra', {}))
    folder = data.get('folder', 'Personal')
    tags = data.get('tags', '')
    is_favorite = bool(data.get('is_favorite', False))

    strength_info = crypto_vault.calculate_password_entropy(password) if password else {"score": 0}

    models.update_vault_item(
        item_id=item_id,
        user_id=user_id,
        category=category,
        title=title,
        encrypted_username=crypto_vault.encrypt_data(username, key),
        encrypted_password=crypto_vault.encrypt_data(password, key),
        encrypted_url=crypto_vault.encrypt_data(url, key),
        encrypted_notes=crypto_vault.encrypt_data(notes, key),
        encrypted_totp_secret=crypto_vault.encrypt_data(totp_secret, key),
        encrypted_extra_json=crypto_vault.encrypt_data(extra, key),
        folder=folder,
        tags=tags,
        is_favorite=is_favorite,
        strength_score=strength_info.get('score', 0)
    )

    models.log_audit_event(user_id, 'ITEM_UPDATED', item_title=title, ip_address=get_client_ip())

    return jsonify({"success": True})

@app.route('/api/vault/<int:item_id>/favorite', methods=['POST'])
@login_required
def api_toggle_favorite(item_id):
    models.toggle_favorite(item_id, session['user_id'])
    return jsonify({"success": True})

@app.route('/api/vault/<int:item_id>', methods=['DELETE'])
@login_required
def api_delete_vault_item(item_id):
    permanent = request.args.get('permanent', '0') == '1'
    user_id = session['user_id']

    if permanent:
        models.permanently_delete_vault_item(item_id, user_id)
        models.log_audit_event(user_id, 'ITEM_PURGED', ip_address=get_client_ip())
    else:
        models.soft_delete_vault_item(item_id, user_id)
        models.log_audit_event(user_id, 'ITEM_TRASHED', ip_address=get_client_ip())

    return jsonify({"success": True})

@app.route('/api/vault/<int:item_id>/restore', methods=['POST'])
@login_required
def api_restore_vault_item(item_id):
    models.restore_vault_item(item_id, session['user_id'])
    models.log_audit_event(session['user_id'], 'ITEM_RESTORED', ip_address=get_client_ip())
    return jsonify({"success": True})

@app.route('/api/vault/trash/empty', methods=['POST'])
@login_required
def api_empty_trash():
    models.empty_trash(session['user_id'])
    models.log_audit_event(session['user_id'], 'TRASH_EMPTIED', ip_address=get_client_ip())
    return jsonify({"success": True})

# --- Security Tools APIs ---

@app.route('/api/tools/totp/<int:item_id>')
@login_required
def api_get_totp(item_id):
    key = get_session_vault_key()
    itm = models.get_vault_item(item_id, session['user_id'])
    if not itm:
        return jsonify({"success": False, "error": "Item not found"}), 404

    secret = crypto_vault.decrypt_data(itm['encrypted_totp_secret'], key)
    if not secret:
        return jsonify({"success": False, "error": "No TOTP secret configured"}), 400

    try:
        totp_data = crypto_vault.get_current_totp_code(secret)
        return jsonify({
            "success": True,
            "code": f"{totp_data['code'][:3]} {totp_data['code'][3:]}",
            "remaining": totp_data['remaining']
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400

@app.route('/api/tools/audit-vault', methods=['POST'])
@login_required
def api_audit_vault():
    user_id = session['user_id']
    key = get_session_vault_key()
    items = models.get_user_vault_items(user_id, is_deleted=False)

    total_items = len(items)
    passwords = []
    flagged = []
    weak_count = 0
    reused_count = 0
    pwned_count = 0

    password_map = {}

    for itm in items:
        p = crypto_vault.decrypt_data(itm['encrypted_password'], key)
        if not p:
            continue
        
        passwords.append(p)
        password_map.setdefault(p, []).append(itm)

        # Check entropy & weakness
        strength = crypto_vault.calculate_password_entropy(p)
        if strength['score'] < 2:
            weak_count += 1
            flagged.append({
                "id": itm['id'],
                "title": itm['title'],
                "reason": f"Weak password ({strength['rating']}, {strength['entropy']} bits entropy)"
            })

        # Check HIBP breach status (k-anonymity)
        breaches = crypto_vault.check_pwned_password(p)
        if breaches > 0:
            pwned_count += 1
            flagged.append({
                "id": itm['id'],
                "title": itm['title'],
                "reason": f"Exposed in {breaches:,} public data breaches"
            })

    # Detect reused passwords
    for p, itm_list in password_map.items():
        if len(itm_list) > 1:
            reused_count += len(itm_list)
            titles = ', '.join([i['title'] for i in itm_list])
            for i in itm_list:
                flagged.append({
                    "id": i['id'],
                    "title": i['title'],
                    "reason": f"Reused across: {titles}"
                })

    # Calculate overall security health score (0-100)
    score = 100
    if total_items > 0:
        score -= min(35, weak_count * 15)
        score -= min(35, reused_count * 10)
        score -= min(40, pwned_count * 25)
    score = max(10, min(100, score))

    if score >= 90: grade = 'A+'
    elif score >= 80: grade = 'A'
    elif score >= 70: grade = 'B'
    elif score >= 50: grade = 'C'
    else: grade = 'F'

    return jsonify({
        "success": True,
        "audit": {
            "score": score,
            "grade": grade,
            "total_items": total_items,
            "weak_count": weak_count,
            "reused_count": reused_count,
            "pwned_count": pwned_count,
            "flagged": flagged
        }
    })

# --- Import & Export APIs ---

@app.route('/api/vault/export')
@login_required
def api_export_vault():
    user = models.get_user_by_id(session['user_id'])
    verify_pass = request.args.get('password', '')
    fmt = request.args.get('format', 'json').lower()

    if not crypto_vault.verify_password(verify_pass, user['salt'], user['password_hash']):
        return jsonify({"success": False, "error": "Master Password verification failed."}), 401

    key = get_session_vault_key()
    items = models.get_user_vault_items(user['id'], is_deleted=None)

    export_records = []
    for itm in items:
        extra_raw = crypto_vault.decrypt_data(itm['encrypted_extra_json'], key)
        extra_obj = json.loads(extra_raw) if extra_raw else {}
        export_records.append({
            "category": itm['category'],
            "title": itm['title'],
            "username": crypto_vault.decrypt_data(itm['encrypted_username'], key),
            "password": crypto_vault.decrypt_data(itm['encrypted_password'], key),
            "url": crypto_vault.decrypt_data(itm['encrypted_url'], key),
            "notes": crypto_vault.decrypt_data(itm['encrypted_notes'], key),
            "totp_secret": crypto_vault.decrypt_data(itm['encrypted_totp_secret'], key),
            "extra": extra_obj,
            "folder": itm['folder'],
            "tags": itm['tags'],
            "created_at": itm['created_at']
        })

    models.log_audit_event(user['id'], 'VAULT_EXPORTED', ip_address=get_client_ip())

    if fmt == 'csv':
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(['folder', 'favorite', 'type', 'name', 'notes', 'fields', 'reprompt', 'login_uri', 'login_username', 'login_password', 'login_totp'])
        for r in export_records:
            writer.writerow([
                r['folder'],
                0,
                r['category'],
                r['title'],
                r['notes'],
                json.dumps(r['extra']),
                0,
                r['url'],
                r['username'],
                r['password'],
                r['totp_secret']
            ])
        mem = io.BytesIO()
        mem.write(output.getvalue().encode('utf-8'))
        mem.seek(0)
        return send_file(mem, mimetype='text/csv', as_attachment=True, download_name='sentinel-vault.csv')
    else:
        # JSON export
        content = json.dumps({"generator": "SentinelVault", "version": Config.APP_VERSION, "items": export_records}, indent=2)
        mem = io.BytesIO()
        mem.write(content.encode('utf-8'))
        mem.seek(0)
        return send_file(mem, mimetype='application/json', as_attachment=True, download_name='sentinel-vault.json')

@app.route('/api/vault/import', methods=['POST'])
@login_required
def api_import_vault():
    data = request.get_json() or {}
    fmt = data.get('format', 'json').lower()
    raw_content = data.get('content', '')
    user_id = session['user_id']
    key = get_session_vault_key()

    if not raw_content:
        return jsonify({"success": False, "error": "No content provided to import"}), 400

    imported_count = 0

    try:
        if fmt == 'csv':
            reader = csv.DictReader(io.StringIO(raw_content))
            for row in reader:
                title = row.get('name') or row.get('title') or 'Imported Item'
                username = row.get('login_username') or row.get('username') or ''
                password = row.get('login_password') or row.get('password') or ''
                url = row.get('login_uri') or row.get('url') or ''
                notes = row.get('notes') or ''
                totp = row.get('login_totp') or ''
                folder = row.get('folder') or 'Imported'

                models.create_vault_item(
                    user_id=user_id,
                    category='login',
                    title=title,
                    encrypted_username=crypto_vault.encrypt_data(username, key),
                    encrypted_password=crypto_vault.encrypt_data(password, key),
                    encrypted_url=crypto_vault.encrypt_data(url, key),
                    encrypted_notes=crypto_vault.encrypt_data(notes, key),
                    encrypted_totp_secret=crypto_vault.encrypt_data(totp, key),
                    folder=folder
                )
                imported_count += 1
        else:
            # JSON format
            parsed = json.loads(raw_content)
            items = parsed.get('items', parsed) if isinstance(parsed, dict) else parsed
            for itm in items:
                title = itm.get('title', 'Imported Secret')
                category = itm.get('category', 'login')
                username = itm.get('username', '')
                password = itm.get('password', '')
                url = itm.get('url', '')
                notes = itm.get('notes', '')
                totp = itm.get('totp_secret', '')
                extra = json.dumps(itm.get('extra', {}))
                folder = itm.get('folder', 'Imported')
                tags = itm.get('tags', '')

                models.create_vault_item(
                    user_id=user_id,
                    category=category,
                    title=title,
                    encrypted_username=crypto_vault.encrypt_data(username, key),
                    encrypted_password=crypto_vault.encrypt_data(password, key),
                    encrypted_url=crypto_vault.encrypt_data(url, key),
                    encrypted_notes=crypto_vault.encrypt_data(notes, key),
                    encrypted_totp_secret=crypto_vault.encrypt_data(totp, key),
                    encrypted_extra_json=crypto_vault.encrypt_data(extra, key),
                    folder=folder,
                    tags=tags
                )
                imported_count += 1

        models.log_audit_event(user_id, f'VAULT_IMPORTED_{imported_count}_ITEMS', ip_address=get_client_ip())
        return jsonify({"success": True, "imported_count": imported_count})
    except Exception as e:
        return jsonify({"success": False, "error": f"Failed to parse import data: {str(e)}"}), 400

# --- Settings & Logs APIs ---

@app.route('/api/settings', methods=['POST'])
@login_required
def api_update_settings():
    data = request.get_json() or {}
    user_id = session['user_id']
    models.update_user_preferences(
        user_id=user_id,
        theme=data.get('theme'),
        sound_enabled=data.get('sound_enabled'),
        sound_volume=data.get('sound_volume'),
        auto_lock_minutes=data.get('auto_lock_minutes')
    )
    return jsonify({"success": True})

@app.route('/api/audit-logs')
@login_required
def api_get_audit_logs():
    logs = models.get_user_audit_logs(session['user_id'], limit=50)
    return jsonify({"success": True, "logs": logs})

@app.route('/api/audit-logs/clear', methods=['POST'])
@login_required
def api_clear_audit_logs():
    models.clear_user_audit_logs(session['user_id'])
    return jsonify({"success": True})

# --- Admin Audit Dashboard ---

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        admin_email = os.environ.get("ADMIN_EMAIL", "").strip().lower()

        if not admin_email:
            return jsonify({
                "success": False,
                "error": "Admin access is not configured."
            }), 403

        if "user_id" not in session or "vault_key" not in session:
            return jsonify({
                "success": False,
                "error": "Unauthorized"
            }), 401

        user = models.get_user_by_id(session["user_id"])

        if not user or user.get("email", "").strip().lower() != admin_email:
            return jsonify({
                "success": False,
                "error": "Forbidden"
            }), 403

        return f(*args, **kwargs)

    return decorated_function


@app.route("/admin")
@login_required
def admin_dashboard():
    admin_email = os.environ.get("ADMIN_EMAIL", "").strip().lower()
    user = models.get_user_by_id(session["user_id"])

    if (
        not admin_email
        or not user
        or user.get("email", "").strip().lower() != admin_email
    ):
        return "Forbidden", 403

    return render_template("admin.html")


@app.route("/api/admin/audit-logs")
@admin_required
def api_admin_audit_logs():
    with models.get_connection() as conn:
        rows = conn.execute("""
            SELECT
                a.id,
                u.username,
                u.email,
                a.action,
                a.ip_address,
                a.status,
                a.timestamp
            FROM audit_logs AS a
            JOIN users AS u ON u.id = a.user_id
            ORDER BY a.id DESC
            LIMIT 200
        """).fetchall()

    return jsonify({
        "success": True,
        "logs": [dict(row) for row in rows]
    })
# --- Main Entrypoint for Local and Azure Deployment ---

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
