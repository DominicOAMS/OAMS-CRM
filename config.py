"""
Central configuration. Everything runs locally with zero accounts by default.
Each value can be overridden with an environment variable (handy for deployment).
"""

import os
import secrets

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Hash of the app's default login password. Safe to keep in source - a hash can't be
# reversed back into the password it came from. Override via CRM_LOGIN_PASSWORD_HASH
# to change the password without touching code (see README).
_DEFAULT_LOGIN_HASH = (
    "scrypt:32768:8:1$f94ZOk6orcnl5Oxb$6a5b0d955184335bfe3142833c73136af8b1085e"
    "45da2e021188f03b43ddade475a587239be825bd27bccc09d148e3d99ec67a260dbd3a6dec"
    "f954e9922fa186"
)


def _load_dotenv():
    """Load KEY=VALUE lines from a local .env into the environment (no dependency).
    Real environment variables (e.g. Vercel's) always win over the file."""
    path = os.path.join(BASE_DIR, ".env")
    if not os.path.exists(path):
        return
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except Exception:
        pass


_load_dotenv()

# Database. SQLite (a local file) by default — no server, no setup. To move to a real
# host later, set CRM_DATABASE_URL to a Postgres URL; nothing else changes.
DATABASE_URL = os.environ.get(
    "CRM_DATABASE_URL", "sqlite:///" + os.path.join(BASE_DIR, "crm.db")
)

# Brand logo. Drop an image here (e.g. logo.png). If missing, the UI shows an "O" badge.
LOGO_PATH = os.environ.get("CRM_LOGO_PATH", os.path.join(BASE_DIR, "static", "logo.png"))

# Only used by the optional one-time importer (import_from_sheets.py) that pulls your
# existing data from the Google Sheet's public CSV export — no login/API key needed.
SPREADSHEET_ID = os.environ.get(
    "CRM_SPREADSHEET_ID", "1hQPB46xP9lVSo-YFmNCt85yd5aAIDCgdiPi3NkWK2A8"
).strip()

# Single shared login for the whole app. The password is never stored in plain text -
# only its hash lives here (see README for how to change it: generate a new hash with
# werkzeug.security.generate_password_hash and set it as CRM_LOGIN_PASSWORD_HASH). A
# hash is safe to keep in source since it can't be reversed back into the password.
LOGIN_USERNAME = os.environ.get("CRM_LOGIN_USERNAME", "OAMS")
LOGIN_PASSWORD_HASH = os.environ.get("CRM_LOGIN_PASSWORD_HASH", _DEFAULT_LOGIN_HASH)

# Signs the login session cookie. Unlike the password hash above, this is a real secret
# (anyone who has it can forge a logged-in session) so it must never be committed to
# git - it's read only from the environment, with a random per-process fallback for
# local dev (meaning local sessions reset whenever the dev server restarts unless you
# set CRM_SECRET_KEY yourself in .env). Set CRM_SECRET_KEY on Vercel for production.
SECRET_KEY = os.environ.get("CRM_SECRET_KEY") or secrets.token_hex(32)
