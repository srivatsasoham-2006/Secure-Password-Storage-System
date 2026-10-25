import os
import secrets

class Config:
    SECRET_KEY = os.environ.get('SECRET_KEY') or secrets.token_hex(32)
    DATABASE_PATH = os.environ.get('DATABASE_PATH') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vault.db')
    DATABASE_URL = os.environ.get('DATABASE_URL') or f"sqlite:///{DATABASE_PATH}"
    
    # Session Security
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = 'Lax'
    SESSION_COOKIE_SECURE = os.environ.get('SESSION_COOKIE_SECURE', 'False').lower() in ('true', '1')
    PERMANENT_SESSION_LIFETIME = 3600 * 12 # 12 hours max
    
    # Vault Security Defaults
    PBKDF2_ITERATIONS = 600000  # OWASP standard
    AES_KEY_SIZE_BYTES = 32     # AES-256
    GCM_NONCE_SIZE_BYTES = 12   # Standard 96-bit GCM nonce
    
    # Rate Limiting & Lockout
    MAX_LOGIN_ATTEMPTS = 5
    LOCKOUT_DURATION_MINUTES = 15
    
    # Version & System metadata
    APP_NAME = "SentinelVault"
    APP_VERSION = "2.4.0-industrial"
