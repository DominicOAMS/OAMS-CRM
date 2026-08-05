"""
Database-backed file storage — attachments and Documents-manager files are stored as
blobs in the same SQLAlchemy database as the rest of the CRM data (see sheets.py),
instead of on local disk. Local disk doesn't persist between Vercel serverless
invocations, so this is what keeps uploaded files alive on the deployed site; the same
code also works unchanged against the local SQLite file.

Function names/signatures are unchanged from the old local-disk version, so logic.py and
app.py's RPC registry don't need to change. Files are served via app.py's
/files/blob/<id> (attachments) and /files/doc/<id> (documents) routes.
"""

import os
import re
import base64
import mimetypes

import config
from sheets import SessionLocal, Blob, DocNode

MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024  # 10MB


def _safe_name(name):
    name = (name or "Untitled").strip()
    return re.sub(r"[^\w.\- ]", "_", name) or "Untitled"


# ---- Logo (small, bundled with the deployment itself - stays on disk) ----

_LOGO_NAMES = ["logo.png", "logo.jpg", "logo.jpeg", "logo.svg", "logo.webp"]


def _logo_candidates():
    """Search config.LOGO_PATH first, then logo.* in the project root and static/."""
    paths = [config.LOGO_PATH]
    for base in (config.BASE_DIR, os.path.join(config.BASE_DIR, "static")):
        for name in _LOGO_NAMES:
            paths.append(os.path.join(base, name))
    seen, out = set(), []
    for p in paths:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


def get_logo_info():
    """Return (bytes, mimetype) for the first logo image found, or (None, None)."""
    for p in _logo_candidates():
        try:
            if os.path.exists(p):
                with open(p, "rb") as f:
                    data = f.read()
                if data:
                    return data, (mimetypes.guess_type(p)[0] or "image/png")
        except Exception:
            pass
    return None, None


def get_logo_bytes():
    return get_logo_info()[0]


# ---- Shared upload decode ----

def decode_upload_files(files):
    out = []
    for f in (files or []):
        b64 = f.get("base64Data", "") or ""
        if "base64," in b64:
            b64 = b64.split(",", 1)[1]
        try:
            raw = base64.b64decode(b64)
        except Exception:
            raw = b""
        if len(raw) > MAX_ATTACHMENT_BYTES:
            mb = len(raw) / (1024 * 1024)
            raise Exception('"%s" is %.1fMB. Files are limited to 10MB.' % (f.get("fileName"), mb))
        out.append({"fileName": f.get("fileName"), "mimeType": f.get("mimeType"), "bytes": raw})
    return out


# ---- Attachments (called from logic.py) ----
# There's no real filesystem folder anymore - entity_type/entity_id is only used by
# logic.py to re-key rows on lead->deal conversion, so the "folder" is just that pair.

def get_or_create_entity_folder(entity_type, entity_id):
    return (entity_type, entity_id)


def create_file_in_folder(folder_abspath, name, mime, data_bytes):
    with SessionLocal() as s:
        b = Blob(name=_safe_name(name), mime_type=mime or "application/octet-stream",
                  size=len(data_bytes), data=data_bytes)
        s.add(b)
        s.commit()
        return {"id": str(b.id), "url": "/files/blob/%d" % b.id}


def trash_file(rel_path):
    """rel_path is the Blob id (as a string) - what create_file_in_folder returned as id."""
    try:
        blob_id = int(rel_path)
    except (TypeError, ValueError):
        return
    with SessionLocal() as s:
        b = s.get(Blob, blob_id)
        if b:
            s.delete(b)
            s.commit()


def rename_entity_folder(from_type, from_id, to_type, to_id):
    """No-op: attachments are addressed by blob id, not by any folder path."""
    return


# ---- Documents file manager (a DocNode tree in the database) ----

def _node_chain(s, node):
    """Root-to-node list of DocNode rows, for breadcrumbs."""
    chain = []
    cur = node
    while cur is not None:
        chain.append(cur)
        cur = s.get(DocNode, cur.parent_id) if cur.parent_id else None
    return list(reversed(chain))


def _get_folder(s, folder_id):
    """folder_id is '' / None for root, else a DocNode id that must be a folder."""
    if not folder_id:
        return None
    try:
        node = s.get(DocNode, int(folder_id))
    except (TypeError, ValueError):
        return None
    return node if node and node.kind == "folder" else None


def getDocuments(folderId=None):
    with SessionLocal() as s:
        folder = _get_folder(s, folderId)
        chain = [{"id": "", "name": "Home"}]
        if folder:
            for n in _node_chain(s, folder):
                chain.append({"id": str(n.id), "name": n.name})

        parent_id = folder.id if folder else None
        children = (s.query(DocNode)
                    .filter(DocNode.parent_id == parent_id)
                    .order_by(DocNode.name)
                    .all())
        folders, files = [], []
        for n in children:
            if n.kind == "folder":
                folders.append({"id": str(n.id), "name": n.name})
            else:
                files.append({
                    "id": str(n.id),
                    "name": n.name,
                    "size": n.size or 0,
                    "mimeType": n.mime_type or "",
                    "url": "/files/doc/%d" % n.id,
                    "modified": n.created_at.strftime("%Y-%m-%d %H:%M") if n.created_at else "",
                })

        return {"folderId": (str(folder.id) if folder else ""), "isRoot": folder is None,
                "breadcrumbs": chain, "folders": folders, "files": files}


def createDocFolder(parentFolderId, name):
    clean = _safe_name(name)
    if not clean:
        raise Exception("Folder name is required.")
    with SessionLocal() as s:
        parent = _get_folder(s, parentFolderId)
        s.add(DocNode(parent_id=(parent.id if parent else None), kind="folder", name=clean))
        s.commit()
    return getDocuments(parentFolderId or "")


def uploadDocuments(folderId, files):
    with SessionLocal() as s:
        parent = _get_folder(s, folderId)
        parent_id = parent.id if parent else None
        for f in decode_upload_files(files):
            s.add(DocNode(parent_id=parent_id, kind="file",
                          name=_safe_name(f["fileName"]),
                          mime_type=f["mimeType"] or "application/octet-stream",
                          size=len(f["bytes"]), data=f["bytes"]))
        s.commit()
    return getDocuments(folderId or "")


def renameDocItem(itemId, isFolder, newName, parentFolderId=None):
    clean = _safe_name(newName)
    if not clean:
        raise Exception("A name is required.")
    with SessionLocal() as s:
        try:
            node = s.get(DocNode, int(itemId))
        except (TypeError, ValueError):
            node = None
        if not node:
            raise Exception("Item not found.")
        node.name = clean
        s.commit()
    return getDocuments(parentFolderId or "")


def deleteDocItem(itemId, isFolder, parentFolderId=None):
    with SessionLocal() as s:
        try:
            node = s.get(DocNode, int(itemId))
        except (TypeError, ValueError):
            node = None
        if not node:
            raise Exception("Item not found.")
        if node.kind == "folder":
            _delete_subtree(s, node.id)
        s.delete(node)
        s.commit()
    return getDocuments(parentFolderId or "")


def _delete_subtree(s, folder_id):
    """Delete descendants bottom-up. There's no ORM relationship() on the self-referential
    parent_id FK, so the unit-of-work doesn't know children must go before their parent -
    flushing after each delete forces that order against the real FK constraint (TiDB/MySQL
    enforces it; SQLite doesn't, but this keeps both paths identical)."""
    for c in s.query(DocNode).filter(DocNode.parent_id == folder_id).all():
        if c.kind == "folder":
            _delete_subtree(s, c.id)
        s.delete(c)
        s.flush()
