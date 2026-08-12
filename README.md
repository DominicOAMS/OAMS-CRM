# OAMS CRM — Python / Flask (local, no accounts needed)

A self-contained Python version of the OAMS CRM. It uses a **local database**
(SQLAlchemy → SQLite by default) and stores files **in that same database**, so it runs
with **no Google account, service account, or API key** — and, once deployed, uploads
persist instead of disappearing between requests.

```
app.py                 Flask app (run this) — also the login gate
config.py              paths + database URL + session secret (overridable via env vars)
sheets.py              data store (SQLAlchemy) — the "spreadsheet" model + file blobs + users
drive.py               attachments + Documents (stored as DB blobs) + logo
logic.py               all CRM logic
users.py               user accounts (list/add/delete/reset password)
import_from_sheets.py  optional one-time import of your old Google Sheet data
templates/ static/     the web UI
```

---

## Run it (about a minute)

```bash
pip install -r requirements.txt
```
```bash
python app.py
```

Open <http://localhost:5000>. Check <http://localhost:5000/health> — it should say
`{"ok": true, "status": "database ready (sqlite)"}`.

That's it. On first run it creates `crm.db` — your database (a single local file,
including any uploaded attachments/Documents, stored as blobs in it).

The tabs (Leads, Contacts, Accounts, Deals, Visits, Documents) work immediately; they
start empty and fill in as you add records or import.

You'll land on a **login page** first — see [Logging in](#logging-in) below for the
default credentials and how to change them.

## Add your logo (optional)

Drop your logo image at **`static/logo.png`**. It appears top-left; if it's missing the
UI just shows an "O" badge. (Override the path with `CRM_LOGO_PATH` if you prefer.)

## Bring over your existing Google Sheet data (optional)

No login or key — it reads the Sheet's public CSV export. One-time setup:

1. In Google Sheets: **Share → General access → "Anyone with the link" → Viewer.**
2. Make sure the id in `config.py` (`SPREADSHEET_ID`) matches your sheet.
3. Run:
   ```bash
   python import_from_sheets.py
   ```

It replaces each local tab (Leads, Contacts, Accounts, Deals, Visits) with the Sheet's
contents. Re-run anytime to re-sync. If a tab is skipped with "login page", the sharing
in step 1 isn't set yet.

*(Alternatively, use the in-app **Import Data** button with a CSV you download from any
tab — File → Download → CSV in Google Sheets.)*

---

## Deploy to Vercel with a TiDB Cloud database

Local uses SQLite; on Vercel the disk resets between requests, so the database moves to
**TiDB Cloud Serverless** (free tier, MySQL-compatible). The app already supports it —
it's just a connection string.

1. **Create the database.** Sign up at TiDB Cloud, create a **Serverless** cluster, and
   open **Connect**. Copy the host, port (4000), user, password, and database name.
2. **Build the URL** in this form (note `mysql+pymysql`):
   ```
   mysql+pymysql://<USER>:<PASSWORD>@<HOST>:4000/<DATABASE>
   ```
   The app enables TLS automatically (TiDB requires it). If your password has special
   characters, URL-encode them.
3. **Load your data into TiDB** (run once, locally):
   ```bash
   set CRM_DATABASE_URL=mysql+pymysql://<USER>:<PASSWORD>@<HOST>:4000/<DATABASE>
   python import_from_sheets.py
   ```
   (PowerShell: `$env:CRM_DATABASE_URL="..."`.) This creates the tables in TiDB and
   fills them — same importer as before, just pointed at the cloud DB.
4. **Deploy.** Push this folder to a Git repo, import it in Vercel, and add these
   Environment Variables:
   - `CRM_DATABASE_URL` = the same `mysql+pymysql://…` string.
   - `CRM_SECRET_KEY` = a random value (see [Logging in](#logging-in)) — required for
     login sessions to stay stable across deployments.
   Vercel runs `app.py` via `vercel.json`. Done — your live site reads/writes TiDB.

**Files persist too.** Attachments and Documents uploads are stored as blobs in the same
database (TiDB in production, SQLite locally) — not on disk — so they survive Vercel's
per-request filesystem resets along with everything else.

---

## Logging in

Accounts are real rows in the database (`sheets.User`) rather than one shared password —
each person gets their own username/password, and admins manage everyone else from the
**User Settings** tab (only visible to admins).

On first run, one admin account is seeded automatically:
- **Username:** `Admin`
- **Password:** set at setup time — ask whoever configured this deployment.

**To change your own password, or add/remove other accounts**, log in as an admin and
use the **User Settings** tab — no code or redeploy needed. Passwords are hashed
(`werkzeug.security`) before they're stored; nothing is ever kept in plain text, in the
database or in source.

**`CRM_SECRET_KEY`** signs the login session cookie - this one really is a secret
(anyone who has it can forge a logged-in session for *any* user), so it's read only from
the environment and never has a real default baked into the code. Locally, one is
already in your `.env` (generated automatically). **On Vercel, set `CRM_SECRET_KEY`** to
a random value too, e.g.:
```bash
python -c "import secrets; print(secrets.token_hex(32))"
```
Without it, Vercel falls back to a random key generated per cold start, which logs
everyone out unpredictably.

If you ever lock yourself out of every admin account, reset one directly:
```bash
python -c "
from werkzeug.security import generate_password_hash
from sheets import SessionLocal, User
with SessionLocal() as s:
    u = s.query(User).filter(User.username == 'Admin').first()
    u.password_hash = generate_password_hash('a-new-password')
    s.commit()
"
```

---

## Notes

- **Your data is local (until you deploy).** `crm.db` holds everything, including
  uploaded files and user accounts; back it up by copying that one file. It's gitignored
  so it won't be committed.
- **No Google dependency.** Attachments, Documents, and user accounts all live in the
  database; the logo is the one thing still served from a local file.
- **Env overrides:** `CRM_DATABASE_URL`, `CRM_LOGO_PATH`, `CRM_SPREADSHEET_ID` (importer
  only), `CRM_SECRET_KEY` (see [Logging in](#logging-in)).
