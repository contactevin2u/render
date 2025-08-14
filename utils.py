import hashlib, re

def sha256_text(s: str) -> str:
    return hashlib.sha256(s.encode('utf-8')).hexdigest()

def norm_phone(p: str | None) -> str | None:
    if not p: return p
    digits = re.sub(r'\D+', '', p)
    if digits.startswith('0'):
        digits = '6' + digits  # assume Malaysia if starting with 0
    if not digits.startswith('6'):
        digits = '60' + digits  # best-effort
    return '+' + digits
