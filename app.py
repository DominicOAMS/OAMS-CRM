"""
OAMS CRM — Python/Flask app backed by a local database (SQLAlchemy) and local files.

`/`                    renders the single-page UI (login required).
`/login`, `/logout`    the app's single shared login.
`/api/rpc`             mirrors the old google.script.run: {fn, args[]} -> function(*args).
`/health`              confirms the database is reachable.
`/logo`                serves the local brand logo (falls back to an "O" badge).
`/files/blob/<id>`     streams a stored attachment (DB blob, login required).
`/files/doc/<id>`      streams a stored Documents-manager file (DB blob, login required).
`/webhook`             optional lead intake.

Run locally:  pip install -r requirements.txt  &&  python app.py   (no accounts needed)
"""

import traceback
from flask import Flask, request, jsonify, render_template, Response, abort, session, redirect, url_for
from werkzeug.security import check_password_hash

import config
import logic
import drive
import sheets
from sheets import SessionLocal, Blob, DocNode

app = Flask(__name__, static_folder="static", template_folder="templates")
app.secret_key = config.SECRET_KEY
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

# Endpoints reachable without being logged in: the login page itself, static assets and
# the logo (both needed to render the login page), and /health + /webhook, which are hit
# by monitoring/external services rather than a browser with a session.
_PUBLIC_ENDPOINTS = {"login", "static", "logo", "health", "webhook"}


@app.before_request
def require_login():
    if request.endpoint in _PUBLIC_ENDPOINTS or request.endpoint is None:
        return None
    if session.get("authenticated"):
        return None
    # /api/rpc and /files/* are fetched by JS, not navigated to - a redirect response
    # would just show up as a broken JSON parse, so tell them plainly instead.
    if request.path.startswith("/api/") or request.path.startswith("/files/"):
        return jsonify({"ok": False, "error": "Not authenticated"}), 401
    return redirect(url_for("login"))


@app.route("/login", methods=["GET", "POST"])
def login():
    if session.get("authenticated"):
        return redirect(url_for("index"))
    error = None
    if request.method == "POST":
        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        if username == config.LOGIN_USERNAME and check_password_hash(config.LOGIN_PASSWORD_HASH, password):
            session["authenticated"] = True
            session.permanent = True
            return redirect(url_for("index"))
        error = "Invalid username or password."
    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))

# Allow-list of RPC-callable functions (name -> callable). Only these can be invoked
# from the browser, exactly the set the front-end's google.script.run shim calls.
RPC = {}


def _register(module, names):
    for n in names:
        fn = getattr(module, n, None)
        if callable(fn):
            RPC[n] = fn


_register(logic, [
    "getSheetData", "addRecordData", "updateCellData", "deleteRecordRow",
    "syncColumns", "importSpreadsheetData",
    "convertLeadToAccount", "addContactToAccount",
    "getDealsBoard", "addNewDeal", "updateDealStage", "updateDealFields", "deleteDealById",
    "logVisit", "listVisits", "deleteVisit",
    "listAttachments", "uploadAttachments", "deleteAttachment",
    "getHomeData", "getAnalyticsData",
    "findDuplicateGroups", "mergeRecords",
])
_register(drive, [
    "getDocuments", "createDocFolder", "uploadDocuments", "renameDocItem", "deleteDocItem",
])


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/logo")
def logo():
    """Serve the brand logo image; 404 lets the page fall back to the 'O' monogram."""
    try:
        data, mime = drive.get_logo_info()
    except Exception:
        data, mime = None, None
    if not data:
        return ("", 404)
    return Response(data, mimetype=mime or "image/png")


@app.route("/api/rpc", methods=["POST"])
def rpc():
    payload = request.get_json(silent=True) or {}
    fn_name = payload.get("fn")
    args = payload.get("args", []) or []
    fn = RPC.get(fn_name)
    if fn is None:
        return jsonify({"ok": False, "error": "Unknown action: %s" % fn_name}), 400
    try:
        result = fn(*args)
        return jsonify({"ok": True, "result": result})
    except Exception as e:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(e)}), 200  # 200 so the shim shows the message


@app.route("/files/blob/<int:blob_id>")
def files_blob(blob_id):
    """Stream a stored attachment from the database."""
    with SessionLocal() as s:
        b = s.get(Blob, blob_id)
        if not b:
            abort(404)
        return Response(b.data, mimetype=b.mime_type or "application/octet-stream",
                         headers={"Content-Disposition": 'inline; filename="%s"' % (b.name or "file")})


@app.route("/files/doc/<int:node_id>")
def files_doc(node_id):
    """Stream a stored Documents-manager file from the database."""
    with SessionLocal() as s:
        n = s.get(DocNode, node_id)
        if not n or n.kind != "file":
            abort(404)
        return Response(n.data, mimetype=n.mime_type or "application/octet-stream",
                         headers={"Content-Disposition": 'inline; filename="%s"' % (n.name or "file")})


@app.route("/health")
def health():
    try:
        return jsonify({"ok": True, "status": sheets.health()})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/webhook", methods=["POST"])
def webhook():
    """Optional external lead intake — mirrors the old Apps Script doPost."""
    try:
        data = request.get_json(force=True)
        leads = data if isinstance(data, list) else [data]
        result = logic.importLeads(leads)
        return jsonify({"status": "success", "result": result})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 400


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
