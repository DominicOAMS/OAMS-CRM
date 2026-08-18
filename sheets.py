"""
Local data store — a SQLite/SQLAlchemy backend that emulates the small "spreadsheet"
API the rest of the app was written against. Each logical sheet (Leads, Contacts,
Accounts, Deals, Visits, Attachments, plus any the user makes) keeps the exact
{columns, rows} model the front-end expects, so logic.py is almost unchanged.

Model:
  sheets(name, columns)  columns = [{name, type, options}]  (ordered, defines the sheet)
  rows(id, sheet_name, data)  data = {columnName: value}  (insertion order = row order)

No Google, no accounts. Default DB is a local file (config.DATABASE_URL).
"""

import datetime

from sqlalchemy import create_engine, Column, String, Integer, JSON, LargeBinary, DateTime, ForeignKey, Boolean, text
from sqlalchemy.orm import declarative_base, sessionmaker

from config import DATABASE_URL

# SQLite for local dev; MySQL-compatible (TiDB Cloud) when CRM_DATABASE_URL is a
# mysql:// URL on a deployed host. TiDB requires TLS (verified against the system CA
# bundle), and pre-ping/recycle keep connections healthy across TiDB Serverless's idle
# auto-pause and serverless cold starts.
if DATABASE_URL.startswith("sqlite"):
    _connect_args = {"check_same_thread": False}
    _engine_kwargs = {}
elif DATABASE_URL.startswith("mysql"):
    _connect_args = {"ssl_verify_cert": True, "ssl_verify_identity": True}
    _engine_kwargs = {"pool_pre_ping": True, "pool_recycle": 280}
else:  # e.g. postgresql
    _connect_args = {}
    _engine_kwargs = {"pool_pre_ping": True}

engine = create_engine(DATABASE_URL, future=True, connect_args=_connect_args, **_engine_kwargs)
Base = declarative_base()
SessionLocal = sessionmaker(bind=engine, future=True, expire_on_commit=False)


class SheetMeta(Base):
    __tablename__ = "sheets"
    # MySQL/TiDB require a length on VARCHAR (SQLite doesn't care, which is why this
    # worked locally but failed against TiDB) - 255 is plenty for a sheet/tab name.
    name = Column(String(255), primary_key=True)
    columns = Column(JSON, default=list)  # [{name, type, options}]


class RowRec(Base):
    __tablename__ = "rows"
    id = Column(Integer, primary_key=True, autoincrement=True)
    sheet_name = Column(String(255), index=True)
    data = Column(JSON, default=dict)  # {columnName: value}


# File storage lives in the database too (not local disk), so uploads survive Vercel's
# ephemeral filesystem between serverless invocations. `length` on LargeBinary makes the
# MySQL/TiDB dialect render LONGBLOB (up to 4GB) instead of the 64KB default BLOB.
_BLOB = LargeBinary(length=(2 ** 32) - 1)


class Blob(Base):
    """A single uploaded file (Lead/Account/etc. attachment)."""
    __tablename__ = "blobs"
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(500))
    mime_type = Column(String(255))
    size = Column(Integer)
    data = Column(_BLOB)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


class DocNode(Base):
    """A folder or file in the Documents manager's tree."""
    __tablename__ = "doc_nodes"
    id = Column(Integer, primary_key=True, autoincrement=True)
    parent_id = Column(Integer, ForeignKey("doc_nodes.id"), nullable=True, index=True)
    kind = Column(String(10))  # "folder" | "file"
    name = Column(String(500))
    mime_type = Column(String(255))
    size = Column(Integer)
    data = Column(_BLOB, nullable=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


class User(Base):
    """A login account. Multiple accounts, one of which (at least) is an admin who can
    manage the others from the User Settings tab."""
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(255), unique=True, nullable=False)
    email = Column(String(255), nullable=True)
    password_hash = Column(String(255), nullable=False)
    is_admin = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)


Base.metadata.create_all(engine)

# Hash of the initial admin password ("oams1010") - never stored in plain text, only
# this one-way hash. Seeded once, only if the users table is empty; change the password
# from the User Settings tab after logging in rather than editing this.
_DEFAULT_ADMIN_USERNAME = "Admin"
_DEFAULT_ADMIN_HASH = "scrypt:32768:8:1$beluSZ4FVdYrclqr$ed68745125eff9d30b5213bae242f363e72f1d58c71fc7a884f4cc252c01669a8a5e153853b5e4af4d5635851928d0d30d89f5f09479543f8ed6be982792ca60"

with SessionLocal() as _s:
    if _s.query(User).count() == 0:
        _s.add(User(username=_DEFAULT_ADMIN_USERNAME, password_hash=_DEFAULT_ADMIN_HASH, is_admin=True))
        _s.commit()


def health():
    with SessionLocal() as s:
        s.execute(text("SELECT 1"))
    return "database ready (%s)" % ("sqlite" if DATABASE_URL.startswith("sqlite") else "external")


# ---- internal helpers ----

def _cellstr(v):
    if v is None:
        return ""
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    return str(v)


def _get_meta(s, name):
    return s.get(SheetMeta, name)


def _col_defs(name):
    with SessionLocal() as s:
        m = _get_meta(s, name)
        return list(m.columns) if m and m.columns else []


def _col_names(name):
    return [c.get("name", "") for c in _col_defs(name)]


def _rows(s, name):
    return s.query(RowRec).filter(RowRec.sheet_name == name).order_by(RowRec.id).all()


# ---- Worksheet handle (mimics the gspread object the code used) ----

class _Cell:
    def __init__(self, value):
        self.value = value


class Worksheet:
    def __init__(self, name):
        self.name = name

    @property
    def id(self):
        return self.name

    @property
    def row_count(self):
        with SessionLocal() as s:
            return s.query(RowRec).filter(RowRec.sheet_name == self.name).count() + 1

    def cell(self, row1, col1):
        return _Cell(_get_cell(self.name, row1, col1))

    def row_values(self, row1):
        return get_row_values(self.name, row1)

    def append_rows(self, rows, value_input_option=None):
        for r in rows:
            append_row(self, r)


# ---- public API used by logic.py ----

def get_worksheet(name):
    with SessionLocal() as s:
        return Worksheet(name) if _get_meta(s, name) else None


def ensure_worksheet(name, headers):
    with SessionLocal() as s:
        m = _get_meta(s, name)
        if m is None:
            m = SheetMeta(name=name, columns=[{"name": h, "type": "text", "options": []} for h in headers])
            s.add(m)
            s.commit()
    return Worksheet(name)


def get_all_values(ws):
    """The header row is stripped for display/matching consistency with header_row()
    (a stray space in a stored column name - e.g. from a messy import - used to make
    this disagree with header_row(), which silently broke saving edits to that column
    and any code that looks up a value by an exact header string). Row data is still
    looked up by the RAW column name, since that's the key it was actually stored
    under (append_row/update_cell key by _col_names(), not the stripped display name)."""
    name = ws.name
    raw_names = _col_names(name)
    names = [str(n).strip() for n in raw_names]
    out = [names]
    with SessionLocal() as s:
        for r in _rows(s, name):
            data = r.data or {}
            out.append([_cellstr(data.get(n, "")) for n in raw_names])
    return out


def header_row(ws):
    return [str(n).strip() for n in _col_names(ws.name)]


def append_row(ws, row_values):
    name = ws.name
    names = _col_names(name)
    data = {}
    for i, n in enumerate(names):
        data[n] = row_values[i] if i < len(row_values) else ""
    with SessionLocal() as s:
        s.add(RowRec(sheet_name=name, data=data))
        s.commit()


def append_rows(ws, rows):
    for r in rows:
        append_row(ws, r)


def update_cell(ws, row1, col1, value):
    name = ws.name
    names = _col_names(name)
    ci = col1 - 1
    if ci < 0 or ci >= len(names):
        return
    colname = names[ci]
    with SessionLocal() as s:
        rows = _rows(s, name)
        idx0 = row1 - 2
        if 0 <= idx0 < len(rows):
            r = rows[idx0]
            d = dict(r.data or {})
            d[colname] = value
            r.data = d  # reassign so SQLAlchemy tracks the JSON change
            s.commit()


def set_cell(ws, row1, col1, value):
    update_cell(ws, row1, col1, value)


def delete_row(ws, row1):
    name = ws.name
    with SessionLocal() as s:
        rows = _rows(s, name)
        idx0 = row1 - 2
        if 0 <= idx0 < len(rows):
            s.delete(rows[idx0])
            s.commit()


def clear_worksheet(ws):
    """Empty the sheet: remove all rows and all column definitions."""
    name = ws.name
    with SessionLocal() as s:
        s.query(RowRec).filter(RowRec.sheet_name == name).delete()
        m = _get_meta(s, name)
        if m:
            m.columns = []
        s.commit()


def get_row_values(name, row1):
    names = _col_names(name)
    with SessionLocal() as s:
        rows = _rows(s, name)
        idx0 = row1 - 2
        if 0 <= idx0 < len(rows):
            data = rows[idx0].data or {}
            return [_cellstr(data.get(n, "")) for n in names]
    return []


def _get_cell(name, row1, col1):
    names = _col_names(name)
    ci = col1 - 1
    if ci < 0 or ci >= len(names):
        return ""
    with SessionLocal() as s:
        rows = _rows(s, name)
        idx0 = row1 - 2
        if 0 <= idx0 < len(rows):
            return _cellstr((rows[idx0].data or {}).get(names[ci], ""))
    return ""


# ---- column / bulk helpers (replace the old A1-range writes) ----

def _set_columns(name, col_defs):
    with SessionLocal() as s:
        m = _get_meta(s, name)
        if m is None:
            m = SheetMeta(name=name, columns=col_defs)
            s.add(m)
        else:
            m.columns = col_defs
        s.commit()


def add_columns(ws, names):
    cols = _col_defs(ws.name)
    have = {c.get("name") for c in cols}
    for n in names:
        if n not in have:
            cols.append({"name": n, "type": "text", "options": []})
    _set_columns(ws.name, cols)


def set_row(ws, row1, values):
    name = ws.name
    names = _col_names(name)
    with SessionLocal() as s:
        rows = _rows(s, name)
        idx0 = row1 - 2
        if 0 <= idx0 < len(rows):
            r = rows[idx0]
            r.data = {n: (values[i] if i < len(values) else "") for i, n in enumerate(names)}
            s.commit()


def set_all(ws, headers, rows):
    """Replace the whole sheet: columns := headers, rows := given rows. Each item in
    `headers` is either a plain name (stored as a plain 'text' column - what a fresh
    import provides) or a {name, type, options} dict, letting a caller that already
    knows a column's chosen type (syncColumns) persist it instead of every column
    reverting to 'text'."""
    name = ws.name
    col_defs = [h if isinstance(h, dict) else {"name": h, "type": "text", "options": []} for h in headers]
    names = [c["name"] for c in col_defs]
    _set_columns(name, col_defs)
    with SessionLocal() as s:
        s.query(RowRec).filter(RowRec.sheet_name == name).delete()
        for row in rows:
            data = {names[i]: (row[i] if i < len(row) else "") for i in range(len(names))}
            s.add(RowRec(sheet_name=name, data=data))
        s.commit()


# ---- dropdown metadata (was per-cell data validation on the sheet) ----

def get_row2_validations(name, num_cols):
    cols = _col_defs(name)
    result = [None] * num_cols
    for i, c in enumerate(cols[:num_cols]):
        if c.get("type") == "dropdown":
            result[i] = {"options": c.get("options") or []}
    return result


# Positional (not name-keyed) on purpose, same reasoning as get_row2_validations above -
# a stored column name can carry stray whitespace that the caller's already-stripped
# display headers won't match exactly.
def get_column_types(name, num_cols):
    cols = _col_defs(name)
    result = ["text"] * num_cols
    for i, c in enumerate(cols[:num_cols]):
        t = c.get("type")
        if t:
            result[i] = t
    return result


def apply_list_validation(ws, col_index0, options, start_row1, num_rows, strict):
    cols = _col_defs(ws.name)
    if 0 <= col_index0 < len(cols):
        cols[col_index0]["type"] = "dropdown"
        cols[col_index0]["options"] = list(options)
        _set_columns(ws.name, cols)


def clear_all_validations(ws):
    cols = _col_defs(ws.name)
    for c in cols:
        c["type"] = "text"
        c["options"] = []
    _set_columns(ws.name, cols)
