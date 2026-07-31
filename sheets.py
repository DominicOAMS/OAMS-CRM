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

from sqlalchemy import create_engine, Column, String, Integer, JSON, text
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


Base.metadata.create_all(engine)


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
    name = ws.name
    names = _col_names(name)
    out = [names]
    with SessionLocal() as s:
        for r in _rows(s, name):
            data = r.data or {}
            out.append([_cellstr(data.get(n, "")) for n in names])
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
    """Replace the whole sheet: columns := headers (as text), rows := given rows."""
    name = ws.name
    _set_columns(name, [{"name": h, "type": "text", "options": []} for h in headers])
    with SessionLocal() as s:
        s.query(RowRec).filter(RowRec.sheet_name == name).delete()
        for row in rows:
            data = {h: (row[i] if i < len(row) else "") for i, h in enumerate(headers)}
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
