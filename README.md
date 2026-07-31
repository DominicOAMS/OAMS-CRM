# OAMS CRM — Python / Flask (local, no accounts needed)

A self-contained Python version of the OAMS CRM. It uses a **local database**
(SQLAlchemy → SQLite by default) and stores files **on disk**, so it runs with **no
Google account, service account, or API key**.

```
app.py                 Flask app (run this)
config.py              paths + database URL (all overridable via env vars)
sheets.py              local data store (SQLAlchemy) — the "spreadsheet" model
drive.py               local file storage (attachments + Documents) + logo
logic.py               all CRM logic
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

That's it. On first run it creates:
- `crm.db` — your database (a single local file).
- `storage/` — where attachments and Documents files are saved.

The tabs (Leads, Contacts, Accounts, Deals, Visits, Documents) work immediately; they
start empty and fill in as you add records or import.

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
4. **Deploy.** Push this folder to a Git repo, import it in Vercel, and add one
   Environment Variable:
   - `CRM_DATABASE_URL` = the same `mysql+pymysql://…` string.
   Vercel runs `app.py` via `vercel.json`. Done — your live site reads/writes TiDB.

**Heads-up about files.** The database persists on TiDB, but **uploaded files**
(Lead attachments + Documents) are still written to local disk, which Vercel wipes.
So on Vercel those uploads won't stick. Everything else works. When you want persistent
files too, tell me and I'll wire attachments/Documents to a blob store (Vercel Blob or
S3) — it's a contained change to `drive.py`.

---

## Notes

- **Your data is local (until you deploy).** `crm.db` and `storage/` hold everything;
  back them up by copying those. They're gitignored so they won't be committed.
- **No Google dependency.** Attachments and Documents are saved under `storage/` and
  served by the app; the logo is a local file.
- **Env overrides:** `CRM_DATABASE_URL`, `CRM_STORAGE_DIR`, `CRM_LOGO_PATH`,
  `CRM_SPREADSHEET_ID` (importer only).
