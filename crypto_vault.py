import os
import base64
import hashlib
import secrets
import string
import urllib.request
import urllib.error
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
import pyotp
import qrcode
import qrcode.image.svg

PBKDF2_ITERATIONS = 600000
KEY_LENGTH = 32 # 256 bits
NONCE_LENGTH = 12 # 96 bits for GCM

# Common wordlist for Diceware style passphrases
PASSPHRASE_WORDS = [
    "amber", "beacon", "cipher", "delta", "echo", "falcon", "glacier", "horizon",
    "island", "jasper", "knight", "lunar", "matrix", "nexus", "orbit", "prism",
    "quantum", "radar", "shadow", "titan", "umbra", "vortex", "zenith", "aurora",
    "breeze", "cascade", "dragon", "enigma", "forest", "galaxy", "harbor", "iron",
    "jungle", "kinetic", "legacy", "meteor", "nebula", "ocean", "phoenix", "quest",
    "river", "summit", "thunder", "unity", "valley", "wizard", "xenon", "yield"
]

def generate_salt(length: int = 32) -> bytes:
    """Generate cryptographically secure random salt."""
    return os.urandom(length)

def derive_key(password: str, salt: bytes, iterations: int = PBKDF2_ITERATIONS) -> bytes:
    """Derive a 256-bit symmetric encryption key using PBKDF2-HMAC-SHA256."""
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=KEY_LENGTH,
        salt=salt,
        iterations=iterations,
    )
    return kdf.derive(password.encode('utf-8'))

def hash_password(password: str, salt: bytes = None) -> tuple[str, str]:
    """
    Hash master password with PBKDF2-HMAC-SHA256.
    Returns (hex_hash, base64_salt).
    """
    if salt is None:
        salt = generate_salt(32)
    key = derive_key(password, salt)
    hash_hex = hashlib.sha256(key).hexdigest()
    salt_b64 = base64.b64encode(salt).decode('utf-8')
    return hash_hex, salt_b64

def verify_password(password: str, salt_b64: str, expected_hash_hex: str) -> bool:
    """Verify master password using constant-time comparison."""
    try:
        salt = base64.b64decode(salt_b64.encode('utf-8'))
        derived_key = derive_key(password, salt)
        calculated_hash_hex = hashlib.sha256(derived_key).hexdigest()
        return secrets.compare_digest(calculated_hash_hex, expected_hash_hex)
    except Exception:
        return False

def encrypt_data(plaintext: str, key: bytes) -> str:
    """
    Encrypt plaintext with AES-256-GCM authenticated cipher.
    Payload format: Base64(nonce [12 bytes] + ciphertext_with_tag).
    """
    if plaintext is None or plaintext == '':
        return ''
    
    aesgcm = AESGCM(key)
    nonce = os.urandom(NONCE_LENGTH)
    # encrypt returns ciphertext + tag appended
    ciphertext = aesgcm.encrypt(nonce, plaintext.encode('utf-8'), None)
    payload = nonce + ciphertext
    return base64.b64encode(payload).decode('utf-8')

def decrypt_data(encrypted_b64: str, key: bytes) -> str:
    """
    Decrypt base64-encoded payload encrypted with AES-256-GCM.
    Returns '' if encrypted_b64 is empty or corrupted.
    """
    if not encrypted_b64:
        return ''
    
    try:
        payload = base64.b64decode(encrypted_b64.encode('utf-8'))
        if len(payload) < NONCE_LENGTH + 16:
            return ''
        
        nonce = payload[:NONCE_LENGTH]
        ciphertext = payload[NONCE_LENGTH:]
        
        aesgcm = AESGCM(key)
        plaintext_bytes = aesgcm.decrypt(nonce, ciphertext, None)
        return plaintext_bytes.decode('utf-8')
    except Exception:
        return ''

def generate_secure_password(length: int = 20, 
                             use_upper: bool = True, 
                             use_lower: bool = True, 
                             use_digits: bool = True, 
                             use_symbols: bool = True, 
                             avoid_ambiguous: bool = True) -> str:
    """Industrial-grade cryptographically secure password generator."""
    length = max(8, min(128, length))
    
    chars = ''
    pools = []
    
    upper_chars = string.ascii_uppercase
    lower_chars = string.ascii_lowercase
    digit_chars = string.digits
    symbol_chars = "!@#$%^&*()_+-=[]{}|;:,.<>?"
    
    if avoid_ambiguous:
        # Avoid 0, O, o, 1, l, I, |
        ambiguous = set('0Oo1lI|')
        upper_chars = ''.join(c for c in upper_chars if c not in ambiguous)
        lower_chars = ''.join(c for c in lower_chars if c not in ambiguous)
        digit_chars = ''.join(c for c in digit_chars if c not in ambiguous)
        symbol_chars = ''.join(c for c in symbol_chars if c not in ambiguous)
        
    if use_upper and upper_chars:
        chars += upper_chars
        pools.append(upper_chars)
    if use_lower and lower_chars:
        chars += lower_chars
        pools.append(lower_chars)
    if use_digits and digit_chars:
        chars += digit_chars
        pools.append(digit_chars)
    if use_symbols and symbol_chars:
        chars += symbol_chars
        pools.append(symbol_chars)
        
    if not chars:
        chars = string.ascii_letters + string.digits
        pools = [string.ascii_letters, string.digits]
        
    # Guarantee at least one character from each selected pool
    password_list = [secrets.choice(pool) for pool in pools]
    
    # Fill remainder
    for _ in range(length - len(password_list)):
        password_list.append(secrets.choice(chars))
        
    # Shuffle cryptographically
    shuffled = []
    while password_list:
        idx = secrets.randbelow(len(password_list))
        shuffled.append(password_list.pop(idx))
        
    return ''.join(shuffled)

def generate_passphrase(word_count: int = 4, separator: str = '-') -> str:
    """Generate a Diceware-style memorable passphrase."""
    word_count = max(3, min(8, word_count))
    words = [secrets.choice(PASSPHRASE_WORDS) for _ in range(word_count)]
    # Capitalize one word randomly
    cap_idx = secrets.randbelow(word_count)
    words[cap_idx] = words[cap_idx].capitalize()
    # Append a 2-digit number
    num = secrets.randbelow(90) + 10
    return separator.join(words) + str(num)

def calculate_password_entropy(password: str) -> dict:
    """
    Calculate Shannon-like entropy and NIST rating for password strength.
    """
    if not password:
        return {"entropy": 0, "score": 0, "rating": "Empty", "color": "#ef4444"}
        
    pool_size = 0
    has_lower = any(c.islower() for c in password)
    has_upper = any(c.isupper() for c in password)
    has_digit = any(c.isdigit() for c in password)
    has_symbol = any(c in string.punctuation for c in password)
    
    if has_lower: pool_size += 26
    if has_upper: pool_size += 26
    if has_digit: pool_size += 10
    if has_symbol: pool_size += 33
    
    if pool_size == 0:
        pool_size = 26
        
    import math
    entropy = len(password) * math.log2(pool_size)
    
    # Evaluate score (0 to 4)
    if len(password) < 8 or entropy < 30:
        score = 0
        rating = "Very Weak"
        color = "#ef4444"
    elif entropy < 50 or len(password) < 12:
        score = 1
        rating = "Weak"
        color = "#f97316"
    elif entropy < 70 or not (has_lower and has_upper and (has_digit or has_symbol)):
        score = 2
        rating = "Moderate"
        color = "#eab308"
    elif entropy < 90:
        score = 3
        rating = "Strong"
        color = "#10b981"
    else:
        score = 4
        rating = "Military Grade"
        color = "#00f0ff"
        
    return {
        "entropy": round(entropy, 1),
        "score": score,
        "rating": rating,
        "color": color,
        "length": len(password)
    }

def check_pwned_password(password: str) -> int:
    """
    Check if a password has appeared in data breaches using HaveIBeenPwned API.
    Uses k-Anonymity: sends ONLY the first 5 characters of SHA-1 hash over HTTPS.
    The rest of the hash is verified locally. Zero plaintext password disclosure!
    Returns count of breaches found (0 if safe).
    """
    if not password:
        return 0
    try:
        sha1_hash = hashlib.sha1(password.encode('utf-8')).hexdigest().upper()
        prefix = sha1_hash[:5]
        suffix = sha1_hash[5:]
        
        url = f"https://api.pwnedpasswords.com/range/{prefix}"
        req = urllib.request.Request(
            url, 
            headers={'User-Agent': 'SentinelVault-SecurityAuditor-v2'}
        )
        with urllib.request.urlopen(req, timeout=3.0) as response:
            lines = response.read().decode('utf-8').splitlines()
            for line in lines:
                parts = line.split(':')
                if len(parts) == 2 and parts[0].strip() == suffix:
                    return int(parts[1].strip())
        return 0
    except Exception:
        # In case of no internet or rate limit, fail safe with 0
        return 0

def generate_totp_secret() -> str:
    """Generate standard Base32 secret for 2FA TOTP."""
    return pyotp.random_base32()

def get_totp_uri(secret: str, username: str, issuer: str = "SentinelVault") -> str:
    """Generate otpauth:// URI for authenticator apps."""
    totp = pyotp.TOTP(secret)
    return totp.provisioning_uri(name=username, issuer_name=issuer)

def generate_qr_svg(uri: str) -> str:
    """Generate an inline SVG QR code for TOTP pairing."""
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=2,
        image_factory=qrcode.image.svg.SvgPathImage
    )
    qr.add_data(uri)
    qr.make(fit=True)
    img = qr.make_image()
    return img.to_string().decode('utf-8')

def get_current_totp_code(secret: str) -> dict:
    """Generate current 6-digit TOTP code and remaining seconds in 30s period."""
    import time
    totp = pyotp.TOTP(secret)
    code = totp.now()
    remaining = 30 - (int(time.time()) % 30)
    return {
        "code": code,
        "remaining": remaining,
        "period": 30
    }

def verify_totp_code(secret: str, code: str) -> bool:
    """Verify TOTP code with standard 1-step window (valid for +/- 30s)."""
    if not secret or not code:
        return False
    try:
        totp = pyotp.TOTP(secret)
        return totp.verify(code.strip(), valid_window=1)
    except Exception:
        return False

def generate_recovery_codes(count: int = 8) -> list[str]:
    """Generate single-use backup recovery codes formatted as XXXX-XXXX."""
    codes = []
    for _ in range(count):
        part1 = secrets.token_hex(2).upper()
        part2 = secrets.token_hex(2).upper()
        codes.append(f"{part1}-{part2}")
    return codes
