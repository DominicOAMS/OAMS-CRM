"""
Central configuration. Everything runs locally with zero accounts by default.
Each value can be overridden with an environment variable (handy for deployment).
"""

import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


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
