"""
Local file storage — replaces the old Google Drive layer, keeping the same function
names so logic.py and app.py are unchanged. Files live under config.STORAGE_DIR:

  storage/attachments/<EntityType>-<EntityId>/<uuid>__<filename>
  storage/documents/<user folder tree>

Files are served to the browser via app.py's /files/download?path=... route.
"""

import os
import re
import shutil
import uuid
import base64
import mimetypes
from datetime import datetime
from urllib.parse import quote

import config

MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024  # 10MB

STORAGE_DIR = config.STORAGE_DIR
ATTACHMENTS_DIR = os.path.join(STORAGE_DIR, "attachments")
DOCUMENTS_DIR = os.path.join(STORAGE_DIR, "documents")


def _ensure_dirs():
    os.makedirs(ATTACHMENTS_DIR, exist_ok=True)
    os.makedirs(DOCUMENTS_DIR, exist_ok=True)


def _rel_to_storage(abspath):
    return os.path.relpath(abspath, STORAGE_DIR).replace("\\", "/")


def _download_url(rel_under_storage):
    return "/files/download?path=" + quote(rel_under_storage)


def _safe_name(name):
    name = (name or "Untitled").strip()
    return re.sub(r"[^\w.\- ]", "_", name) or "Untitled"


# ---- Logo ----

import mimetypes

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

def get_or_create_entity_folder(entity_type, entity_id):
    _ensure_dirs()
    folder = os.path.join(ATTACHMENTS_DIR, "%s-%s" % (entity_type, entity_id))
    os.makedirs(folder, exist_ok=True)
    return folder


def create_file_in_folder(folder_abspath, name, mime, data_bytes):
    os.makedirs(folder_abspath, exist_ok=True)
    fname = uuid.uuid4().hex[:8] + "__" + _safe_name(name)
    abspath = os.path.join(folder_abspath, fname)
    with open(abspath, "wb") as f:
        f.write(data_bytes)
    rel = _rel_to_storage(abspath)
    return {"id": rel, "url": _download_url(rel)}


def trash_file(rel_path):
    """rel_path is relative to STORAGE_DIR (what create_file_in_folder returned as id)."""
    try:
        target = _resolve_under(STORAGE_DIR, rel_path)
        if target and os.path.isfile(target):
            os.remove(target)
    except Exception:
        pass


def rename_entity_folder(from_type, from_id, to_type, to_id):
    """No-op for local storage. The Attachments rows are re-keyed to the new entity, and
    the files keep their stored paths (still valid) - renaming the folder would break
    those paths, so we leave files in place. The folder name is only cosmetic anyway."""
    return


# ---- path safety ----

def _resolve_under(base, rel):
    """Safely resolve rel under base; return abspath or None if it escapes base."""
    rel = (rel or "").replace("\\", "/").lstrip("/")
    target = os.path.realpath(os.path.join(base, rel))
    base_real = os.path.realpath(base)
    if target == base_real or target.startswith(base_real + os.sep):
        return target
    return None


# ---- Documents file manager (pure local) ----

def _doc_abs(rel):
    _ensure_dirs()
    target = _resolve_under(DOCUMENTS_DIR, rel or "")
    if target is None:
        target = DOCUMENTS_DIR
    return target


def getDocuments(folderId=None):
    _ensure_dirs()
    rel = (folderId or "").replace("\\", "/").strip("/")
    absdir = _doc_abs(rel)
    if not os.path.isdir(absdir):
        rel, absdir = "", DOCUMENTS_DIR

    # Breadcrumbs from the relative path.
    chain = [{"id": "", "name": "Home"}]
    if rel:
        cum = []
        for seg in rel.split("/"):
            cum.append(seg)
            chain.append({"id": "/".join(cum), "name": seg})

    folders, files = [], []
    for entry in sorted(os.listdir(absdir), key=lambda x: x.lower()):
        p = os.path.join(absdir, entry)
        item_rel = (rel + "/" + entry) if rel else entry
        if os.path.isdir(p):
            folders.append({"id": item_rel, "name": entry})
        else:
            files.append({
                "id": item_rel,
                "name": entry,
                "size": os.path.getsize(p),
                "mimeType": mimetypes.guess_type(entry)[0] or "",
                "url": _download_url("documents/" + item_rel),
                "modified": datetime.fromtimestamp(os.path.getmtime(p)).strftime("%Y-%m-%d %H:%M"),
            })

    return {"folderId": rel, "isRoot": rel == "", "breadcrumbs": chain,
            "folders": folders, "files": files}


def createDocFolder(parentFolderId, name):
    clean = _safe_name(name)
    if not clean:
        raise Exception("Folder name is required.")
    parent = _doc_abs(parentFolderId or "")
    os.makedirs(os.path.join(parent, clean), exist_ok=True)
    return getDocuments(parentFolderId or "")


def uploadDocuments(folderId, files):
    parent = _doc_abs(folderId or "")
    os.makedirs(parent, exist_ok=True)
    for f in decode_upload_files(files):
        with open(os.path.join(parent, _safe_name(f["fileName"])), "wb") as out:
            out.write(f["bytes"])
    return getDocuments(folderId or "")


def renameDocItem(itemId, isFolder, newName, parentFolderId=None):
    clean = _safe_name(newName)
    if not clean:
        raise Exception("A name is required.")
    src = _doc_abs(itemId)
    if src is None or not os.path.exists(src) or os.path.realpath(src) == os.path.realpath(DOCUMENTS_DIR):
        raise Exception("Item not found.")
    dst = os.path.join(os.path.dirname(src), clean)
    os.rename(src, dst)
    return getDocuments(parentFolderId or "")


def deleteDocItem(itemId, isFolder, parentFolderId=None):
    target = _doc_abs(itemId)
    if target is None or os.path.realpath(target) == os.path.realpath(DOCUMENTS_DIR):
        raise Exception("Item not found.")
    if os.path.isdir(target):
        shutil.rmtree(target, ignore_errors=True)
    elif os.path.isfile(target):
        os.remove(target)
    return getDocuments(parentFolderId or "")
