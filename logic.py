"""
Business logic — a faithful Python port of the Apps Script Code.gs, backed by Google
Sheets (via sheets.py) and Google Drive (via drive.py). Function names and positional
args match the originals so the front-end's google.script.run shim calls them directly.

Row convention (unchanged from the Apps Script app): the client passes 0-based data
`rowIndex`; the sheet row is rowIndex + 2 (row 1 is headers).
"""

import re
import uuid
from datetime import datetime, timedelta

from dateutil import parser as dateparser

import sheets
import drive

DEAL_STAGES = ["Awaiting Decision", "Proposed Bid", "Closed Won", "Closed Lost"]
KNOWN_ID_COLUMNS = {
    "Lead ID": "LEAD", "Account ID": "ACC", "Contact ID": "CON",
    "Deal ID": "DEAL", "Visit ID": "VIS", "Attachment ID": "ATT",
}
DAY_MS = 24 * 60 * 60 * 1000

DEFAULT_HEADERS = {
    "Leads": ["Lead ID", "Name", "Email", "Phone", "Company", "Number", "Status", "Source", "Next Follow-up", "Created Time"],
    "Contacts": ["Contact ID", "Account", "Name", "Email", "Phone", "Created Time"],
    "Accounts": ["Account ID", "Account Name", "Sales Rep", "Territory", "Last Visit", "Visit Count", "Number", "Created Time"],
    "Deals": ["Deal ID", "Deal Name", "Account", "Amount", "Stage", "Sales Rep", "Territory", "Next Follow-up", "Created Time", "Closed Date", "Lost Reason"],
    "Attachments": ["Attachment ID", "Entity Type", "Entity ID", "File Name", "Mime Type", "Size", "Drive File ID", "Drive File URL", "Uploaded Time"],
    "Visits": ["Visit ID", "Account ID", "Account Name", "Visit Date", "Notes", "Logged Time"],
}


# ---- small helpers ----

def _uid(prefix):
    return prefix + "-" + uuid.uuid4().hex[:8].upper()


def _now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _now_ms():
    return int(datetime.now().timestamp() * 1000)


def _to_ms(v):
    if v is None:
        return None
    s = str(v).strip()
    if s == "":
        return None
    try:
        return int(dateparser.parse(s).timestamp() * 1000)
    except Exception:
        return None


def _to_float(v):
    if v is None:
        return None
    s = re.sub(r"[^0-9.\-]", "", str(v))
    if s in ("", "-", ".", "-."):
        return None
    try:
        return float(s)
    except Exception:
        return None


def _strip_link(v):
    return re.sub(r"\s*\[[^\]]*\]\s*$", "", "" if v is None else str(v))


def _norm(v):
    return ("" if v is None else str(v)).strip()


def _set_contact_account_link(row_data, account_name):
    """Contacts link to their Account by plain name (no ID), but the real column for
    that is "Account Name" on Contacts imported from the old Sheet, vs "Account" on
    the DEFAULT_HEADERS template for a brand-new Contacts sheet. Writing the wrong one
    doesn't error - it just silently vanishes into a key addRecordData never reads,
    leaving the new Contact created but not actually linked to any Account."""
    contacts_ws = sheets.get_worksheet("Contacts")
    headers = sheets.header_row(contacts_ws) if contacts_ws else []
    key = "Account Name" if "Account Name" in headers else "Account"
    row_data[key] = account_name


def _set_contact_name(row_data, full_name, first_name, last_name):
    """Same problem as the account link, for the name: real Contacts data uses split
    First Name/Last Name columns, not a combined "Name" field."""
    contacts_ws = sheets.get_worksheet("Contacts")
    headers = sheets.header_row(contacts_ws) if contacts_ws else []
    if "First Name" in headers or "Last Name" in headers:
        row_data["First Name"] = first_name
        row_data["Last Name"] = last_name
    else:
        row_data["Name"] = full_name


def _read(ws):
    """Return (headers, data_rows) as lists of strings; headers row + rows below."""
    vals = sheets.get_all_values(ws)
    if not vals:
        return [], []
    return vals[0], vals[1:]


def _row_at(rows, headers, i):
    """Padded row i as a dict-safe list of length len(headers)."""
    row = list(rows[i]) if i < len(rows) else []
    if len(row) < len(headers):
        row = row + [""] * (len(headers) - len(row))
    return row


def findRowByIdColumn_(ws, id_col_name, id_value):
    headers, rows = _read(ws)
    if id_col_name not in headers:
        return -1
    ci = headers.index(id_col_name)
    for i, row in enumerate(rows):
        if ci < len(row) and str(row[ci]) == str(id_value):
            return i + 2
    return -1


def _find_account_id_by_name_ci(name):
    """Case-insensitive lookup of an existing Account by name. Accounts are matched by
    plain name throughout the app (Contacts/Deals store the name, not an ID), so a
    second same-named row would be an untraceable duplicate rather than a genuinely
    distinct account - callers use this to avoid minting one."""
    acc_ws = sheets.get_worksheet("Accounts")
    if acc_ws is None:
        return None
    headers, rows = _read(acc_ws)
    if "Account Name" not in headers or "Account ID" not in headers:
        return None
    name_i = headers.index("Account Name")
    id_i = headers.index("Account ID")
    target = _norm(name).lower()
    if not target:
        return None
    for row in rows:
        if name_i < len(row) and _norm(row[name_i]).lower() == target:
            return row[id_i] if id_i < len(row) else None
    return None


def _append_missing_headers(ws, headers, missing):
    sheets.add_columns(ws, missing)


# ---- schema self-healing ----

def ensureDealsSchema_():
    ws = sheets.get_worksheet("Deals")
    created = False
    if ws is None:
        ws = sheets.ensure_worksheet("Deals", DEFAULT_HEADERS["Deals"])
        created = True
    headers = sheets.header_row(ws)
    missing = [c for c in ["Closed Date", "Lost Reason", "Sales Rep", "Territory", "Next Follow-up"] if c not in headers]
    if missing:
        _append_missing_headers(ws, headers, missing)
        headers = sheets.header_row(ws)
    # Apply the strict Stage dropdown once (on creation / when columns were added),
    # rather than on every load (each apply is an API write).
    if (created or missing) and "Stage" in headers:
        try:
            sheets.apply_list_validation(ws, headers.index("Stage"), DEAL_STAGES, 2, max(ws.row_count - 1, 1), True)
        except Exception:
            pass
    return ws


def ensureAccountsVisitColumns_():
    ws = sheets.get_worksheet("Accounts")
    if ws is None:
        ws = sheets.ensure_worksheet("Accounts", DEFAULT_HEADERS["Accounts"])
    headers = sheets.header_row(ws)
    missing = [c for c in ["Last Visit", "Visit Count", "Sales Rep", "Territory", "Created Time"] if c not in headers]
    if missing:
        _append_missing_headers(ws, headers, missing)
    return ws


def ensureLeadsFollowUp_():
    ws = sheets.get_worksheet("Leads")
    if ws is None:
        ws = sheets.ensure_worksheet("Leads", DEFAULT_HEADERS["Leads"])
    headers = sheets.header_row(ws)
    if "Next Follow-up" not in headers:
        _append_missing_headers(ws, headers, ["Next Follow-up"])
    return ws


# ---- core reader ----

def getSheetData(sheetName):
    ws = sheets.get_worksheet(sheetName)
    if ws is None:
        headers = DEFAULT_HEADERS.get(sheetName, ["ID", "Name", "Created Time"])
        ws = sheets.ensure_worksheet(sheetName, headers)

    if sheetName == "Accounts":
        ensureAccountsVisitColumns_()

    vals = sheets.get_all_values(ws)
    header_values = vals[0] if vals else []
    last_col = len(header_values)
    if last_col == 0:
        return {"columns": [], "rows": []}
    data_rows = vals[1:]

    validations = sheets.get_row2_validations(sheetName, last_col)

    # Dynamic Account dropdown options (plain names). Looked up by column NAME, not a
    # hardcoded position - "Account Name" sits at a different index on data imported
    # from the old Sheet than on the DEFAULT_HEADERS template for a fresh sheet, and
    # reading the wrong position (previously always index 1) silently pulled from
    # whatever column happened to be there instead - Sales Rep, on this real data.
    acc_options = None
    if sheetName in ("Contacts", "Deals"):
        acc_options = []
        acc_ws = sheets.get_worksheet("Accounts")
        if acc_ws is not None:
            acc_vals = sheets.get_all_values(acc_ws)
            acc_headers = acc_vals[0] if acc_vals else []
            name_i = acc_headers.index("Account Name") if "Account Name" in acc_headers else 1
            seen = set()
            for r in acc_vals[1:]:
                nm = _norm(r[name_i]) if name_i < len(r) else ""
                if nm and nm.lower() not in seen:
                    seen.add(nm.lower())
                    acc_options.append(nm)

    columns = []
    for i, colName in enumerate(header_values):
        # "Account Name" is the real column on Contacts data imported from the old
        # Sheet; "Account"/"Account ID" match the DEFAULT_HEADERS template for a
        # brand-new sheet. Without all three, real imported Contacts never actually
        # got the dropdown treatment - the field silently stayed free text.
        if acc_options is not None and colName in ("Account", "Account ID", "Account Name"):
            columns.append({"name": colName, "type": "dropdown", "options": acc_options})
        elif validations[i]:
            columns.append({"name": colName, "type": "dropdown", "options": validations[i]["options"]})
        else:
            columns.append({"name": colName, "type": "text", "options": []})

    rows = []
    for r in data_rows:
        row = list(r) + [""] * (last_col - len(r))
        rows.append(row[:last_col])

    if sheetName in ("Contacts", "Deals") and "Account" in header_values:
        aci = header_values.index("Account")
        for r in rows:
            if r[aci]:
                r[aci] = _strip_link(r[aci])

    return {"columns": columns, "rows": rows}


def addRecordData(sheetName, rowData):
    ws = sheets.get_worksheet(sheetName)
    if ws is None:
        return getSheetData(sheetName)
    headers = sheets.header_row(ws)
    for h in headers:
        key = h.strip()
        if key in KNOWN_ID_COLUMNS and not rowData.get(key):
            rowData[key] = _uid(KNOWN_ID_COLUMNS[key])
    new_row = [rowData.get(h) if rowData.get(h) not in (None,) else "" for h in headers]
    new_row = [("" if v is None or v == "" else v) for v in new_row]
    sheets.append_row(ws, new_row)
    return getSheetData(sheetName)


def updateCellData(sheetName, rowIndex, colName, newValue):
    ws = sheets.get_worksheet(sheetName)
    if ws is None:
        return None
    headers = sheets.header_row(ws)
    if colName not in headers:
        return None

    old_value = None
    if sheetName == "Accounts" and colName == "Account Name":
        old_row = sheets.get_row_values(sheetName, rowIndex + 2)
        col_i = headers.index(colName)
        old_value = old_row[col_i] if col_i < len(old_row) else None

    sheets.update_cell(ws, rowIndex + 2, headers.index(colName) + 1, newValue)

    if old_value and _norm(old_value).lower() != _norm(newValue).lower():
        _cascadeAccountRename_(old_value, newValue)
    return None


def _cascadeAccountRename_(old_name, new_name):
    """Contacts/Deals link to an Account by its plain name, not an ID - editing an
    Account's name (even just fixing a typo) would otherwise silently orphan every
    existing Contact/Deal that pointed at the old spelling."""
    old_norm = _norm(old_name).lower()
    for sheet_name, col_name in (
        ("Contacts", "Account Name"), ("Contacts", "Account"),
        ("Deals", "Account"), ("Deals", "Account Name"),
    ):
        ws = sheets.get_worksheet(sheet_name)
        if ws is None:
            continue
        headers = sheets.header_row(ws)
        if col_name not in headers:
            continue
        col_i = headers.index(col_name)
        vals = sheets.get_all_values(ws)
        for row_offset, row in enumerate(vals[1:]):
            if col_i < len(row) and _norm(row[col_i]).lower() == old_norm:
                sheets.update_cell(ws, row_offset + 2, col_i + 1, new_name)


def deleteRecordRow(sheetName, rowIndex):
    ws = sheets.get_worksheet(sheetName)
    if ws is not None:
        sheets.delete_row(ws, rowIndex + 2)
    return getSheetData(sheetName)


def convertLeadToAccount(rowIndex):
    leads_ws = sheets.get_worksheet("Leads")
    if leads_ws is None:
        raise Exception("Leads data isn't available right now - contact your admin.")
    headers, rows = _read(leads_ws)
    if rowIndex < 0 or rowIndex >= len(rows):
        raise Exception("Lead row not found.")
    row = _row_at(rows, headers, rowIndex)
    lead = {}
    for i, h in enumerate(headers):
        lead[h.lower()] = row[i] if i < len(row) else ""

    company = lead.get("company") or lead.get("account name") or lead.get("account") or "Unknown Company"
    # This schema (First Name + Last Name, no combined "Name" field) is what this
    # app's real Lead data actually uses - without composing from those, `name` would
    # silently fall through to "Unknown Name" for every real lead in the system.
    lead_first = lead.get("first name") or ""
    lead_last = lead.get("last name") or ""
    combined_name = lead.get("name") or lead.get("contact person") or lead.get("contact") or ""
    if not combined_name:
        combined_name = (str(lead_first) + " " + str(lead_last)).strip()
    if not lead_first and not lead_last and combined_name:
        # Source only had a combined name (not split) - best-effort split for targets
        # that need First/Last separately.
        parts = combined_name.split(" ", 1)
        lead_first, lead_last = parts[0], (parts[1] if len(parts) > 1 else "")
    name = combined_name or "Unknown Name"
    email = lead.get("email") or ""
    phone = lead.get("phone") or ""
    number = lead.get("number") or ""
    sales_rep = lead.get("sales rep") or lead.get("(sales rep)") or lead.get("rep") or ""
    territory = lead.get("territory") or lead.get("region") or ""

    account_id = _uid("ACC")
    contact_id = _uid("CON")
    deal_id = _uid("DEAL")
    timestamp = _now_str()
    account_link = company  # plain name link

    ensureAccountsVisitColumns_()
    # Don't mint a second Account row for a company that already has one - since
    # Accounts are matched by plain name everywhere else, a duplicate would just be an
    # untraceable second record, not a distinct account.
    if not _find_account_id_by_name_ci(company):
        addRecordData("Accounts", {
            "Account ID": account_id, "Account Name": company,
            "Sales Rep": sales_rep, "Territory": territory,
            "Number": number, "Created Time": timestamp,
        })

    getSheetData("Contacts")
    contact_row = {
        "Contact ID": contact_id, "Email": email, "Phone": phone, "Created Time": timestamp,
    }
    _set_contact_account_link(contact_row, account_link)
    _set_contact_name(contact_row, name, lead_first, lead_last)
    addRecordData("Contacts", contact_row)

    ensureDealsSchema_()
    addRecordData("Deals", {
        "Deal ID": deal_id, "Deal Name": company + " Deal", "Account": account_link,
        "Amount": "", "Stage": "Awaiting Decision", "Sales Rep": sales_rep,
        "Territory": territory, "Created Time": timestamp, "Closed Date": "", "Lost Reason": "",
    })

    lead_id = lead.get("lead id")
    if lead_id:
        reKeyAttachments_("Lead", lead_id, "Deal", deal_id)

    sheets.delete_row(leads_ws, rowIndex + 2)
    return getSheetData("Leads")


def addContactToAccount(accountId, contactFields):
    acc_ws = sheets.get_worksheet("Accounts")
    if acc_ws is None:
        raise Exception("Accounts data isn't available right now - contact your admin.")
    row_num = findRowByIdColumn_(acc_ws, "Account ID", accountId)
    if row_num == -1:
        raise Exception("Account not found: " + str(accountId))
    headers = sheets.header_row(acc_ws)
    account_name = "Unknown Account"
    if "Account Name" in headers:
        account_name = acc_ws.cell(row_num, headers.index("Account Name") + 1).value or "Unknown Account"

    row_data = dict(contactFields or {})
    row_data.update({
        "Contact ID": _uid("CON"),
        "Created Time": _now_str(),
    })
    _set_contact_account_link(row_data, account_name)
    return addRecordData("Contacts", row_data)


# ---- Visits ----

def parseVisitDate_(s):
    if not s:
        return datetime.now().strftime("%Y-%m-%d")
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", str(s).strip())
    if m:
        return "%s-%s-%s" % (m.group(1), m.group(2), m.group(3))
    ms = _to_ms(s)
    if ms is None:
        return datetime.now().strftime("%Y-%m-%d")
    return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d")


def recomputeAccountVisitStats_(accountId):
    visits_ws = sheets.get_worksheet("Visits")
    acc_ws = ensureAccountsVisitColumns_()

    count = 0
    last_ms = None
    if visits_ws is not None:
        headers, rows = _read(visits_ws)
        if "Account ID" in headers and "Visit Date" in headers:
            acc_i = headers.index("Account ID")
            date_i = headers.index("Visit Date")
            for r in rows:
                if acc_i < len(r) and str(r[acc_i]) == str(accountId):
                    count += 1
                    ms = _to_ms(r[date_i]) if date_i < len(r) else None
                    if ms is not None and (last_ms is None or ms > last_ms):
                        last_ms = ms

    acc_row = findRowByIdColumn_(acc_ws, "Account ID", accountId)
    if acc_row == -1:
        return
    acc_headers = sheets.header_row(acc_ws)
    if "Last Visit" in acc_headers:
        val = datetime.fromtimestamp(last_ms / 1000).strftime("%Y-%m-%d") if last_ms else ""
        sheets.update_cell(acc_ws, acc_row, acc_headers.index("Last Visit") + 1, val)
    if "Visit Count" in acc_headers:
        sheets.update_cell(acc_ws, acc_row, acc_headers.index("Visit Count") + 1, count)


def logVisit(accountId, visitDate, notes):
    acc_ws = sheets.get_worksheet("Accounts")
    if acc_ws is None:
        raise Exception("Accounts data isn't available right now - contact your admin.")
    acc_row = findRowByIdColumn_(acc_ws, "Account ID", accountId)
    if acc_row == -1:
        raise Exception("Account not found: " + str(accountId))
    headers = sheets.header_row(acc_ws)
    account_name = ""
    if "Account Name" in headers:
        account_name = acc_ws.cell(acc_row, headers.index("Account Name") + 1).value or ""

    getSheetData("Visits")
    addRecordData("Visits", {
        "Visit ID": _uid("VIS"),
        "Account ID": accountId,
        "Account Name": account_name,
        "Visit Date": parseVisitDate_(visitDate),
        "Notes": notes or "",
        "Logged Time": _now_str(),
    })
    recomputeAccountVisitStats_(accountId)
    return getSheetData("Accounts")


def listVisits(accountId):
    ws = sheets.get_worksheet("Visits")
    if ws is None:
        return []
    headers, rows = _read(ws)
    if not rows or "Account ID" not in headers:
        return []
    idx = {h: i for i, h in enumerate(headers)}
    results = []
    for r in rows:
        if str(r[idx["Account ID"]]) == str(accountId):
            ms = _to_ms(r[idx["Visit Date"]]) if "Visit Date" in idx and idx["Visit Date"] < len(r) else None
            results.append({
                "visitId": r[idx["Visit ID"]] if "Visit ID" in idx else "",
                "visitDate": datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d") if ms else "",
                "visitDateSort": ms or 0,
                "notes": r[idx["Notes"]] if "Notes" in idx and idx["Notes"] < len(r) else "",
            })
    results.sort(key=lambda x: x["visitDateSort"], reverse=True)
    return results


def deleteVisit(visitId):
    ws = sheets.get_worksheet("Visits")
    if ws is None:
        raise Exception("Visits data isn't available right now - contact your admin.")
    row_num = findRowByIdColumn_(ws, "Visit ID", visitId)
    if row_num == -1:
        raise Exception("Visit not found: " + str(visitId))
    headers = sheets.header_row(ws)
    account_id = ws.cell(row_num, headers.index("Account ID") + 1).value
    sheets.delete_row(ws, row_num)
    recomputeAccountVisitStats_(account_id)
    return listVisits(account_id)


# ---- Attachments (Sheets metadata + Drive files) ----

def listAttachments(entityType, entityId):
    ws = sheets.get_worksheet("Attachments")
    if ws is None:
        return []
    headers, rows = _read(ws)
    if not rows:
        return []
    idx = {h: i for i, h in enumerate(headers)}
    out = []
    for r in rows:
        if (r[idx["Entity Type"]] == entityType and str(r[idx["Entity ID"]]) == str(entityId)):
            out.append({
                "attachmentId": r[idx["Attachment ID"]],
                "fileName": r[idx["File Name"]],
                "mimeType": r[idx["Mime Type"]],
                "size": r[idx["Size"]],
                "driveFileUrl": r[idx["Drive File URL"]],
                "uploadedTime": r[idx["Uploaded Time"]],
            })
    return out


ATTACHMENT_ENTITY_SHEETS = {
    "Lead": ("Leads", "Lead ID"), "Deal": ("Deals", "Deal ID"),
    "Account": ("Accounts", "Account ID"), "Contact": ("Contacts", "Contact ID"),
}


def uploadAttachments(entityType, entityId, files):
    if entityType not in ATTACHMENT_ENTITY_SHEETS:
        raise Exception("Invalid entity type: " + str(entityType))
    entity_sheet, id_col = ATTACHMENT_ENTITY_SHEETS[entityType]
    ews = sheets.get_worksheet(entity_sheet)
    if ews is None or findRowByIdColumn_(ews, id_col, entityId) == -1:
        raise Exception("%s not found: %s" % (entityType, entityId))

    decoded = drive.decode_upload_files(files)
    getSheetData("Attachments")

    for f in decoded:
        folder = drive.get_or_create_entity_folder(entityType, entityId)
        created = drive.create_file_in_folder(folder, f["fileName"] or "Untitled Attachment",
                                               f["mimeType"] or "application/octet-stream", f["bytes"])
        addRecordData("Attachments", {
            "Attachment ID": _uid("ATT"),
            "Entity Type": entityType,
            "Entity ID": entityId,
            "File Name": f["fileName"] or "Untitled Attachment",
            "Mime Type": f["mimeType"] or "application/octet-stream",
            "Size": len(f["bytes"]),
            "Drive File ID": created["id"],
            "Drive File URL": created["url"],
            "Uploaded Time": _now_str(),
        })
    return listAttachments(entityType, entityId)


def deleteAttachment(attachmentId):
    ws = sheets.get_worksheet("Attachments")
    if ws is None:
        raise Exception("Attachments aren't available right now - contact your admin.")
    row_num = findRowByIdColumn_(ws, "Attachment ID", attachmentId)
    if row_num == -1:
        raise Exception("Attachment not found: " + str(attachmentId))
    headers = sheets.header_row(ws)
    row_vals = ws.row_values(row_num)
    idx = {h: i for i, h in enumerate(headers)}
    drive_file_id = row_vals[idx["Drive File ID"]] if idx["Drive File ID"] < len(row_vals) else ""
    entity_type = row_vals[idx["Entity Type"]] if idx["Entity Type"] < len(row_vals) else ""
    entity_id = row_vals[idx["Entity ID"]] if idx["Entity ID"] < len(row_vals) else ""
    if drive_file_id:
        drive.trash_file(drive_file_id)
    sheets.delete_row(ws, row_num)
    return listAttachments(entity_type, entity_id)


def reKeyAttachments_(from_type, from_id, to_type, to_id):
    ws = sheets.get_worksheet("Attachments")
    if ws is None:
        return
    headers, rows = _read(ws)
    if not rows or "Entity Type" not in headers or "Entity ID" not in headers:
        return
    type_i = headers.index("Entity Type")
    id_i = headers.index("Entity ID")
    found = False
    for i, r in enumerate(rows):
        if r[type_i] == from_type and str(r[id_i]) == str(from_id):
            sheets.update_cell(ws, i + 2, type_i + 1, to_type)
            sheets.update_cell(ws, i + 2, id_i + 1, to_id)
            found = True
    if found:
        drive.rename_entity_folder(from_type, from_id, to_type, to_id)


# ---- Deals (Kanban) ----

def getDealsBoard():
    ensureDealsSchema_()
    return getSheetData("Deals")


def addNewDeal(dealFields):
    ensureDealsSchema_()
    row_data = dict(dealFields or {})
    row_data.update({
        "Deal ID": _uid("DEAL"),
        "Stage": "Awaiting Decision",
        "Created Time": _now_str(),
        "Closed Date": "",
        "Lost Reason": "",
    })
    addRecordData("Deals", row_data)
    return getDealsBoard()


def updateDealStage(dealId, newStage, extra=None):
    extra = extra or {}
    if newStage not in DEAL_STAGES:
        raise Exception("Invalid stage: " + str(newStage))
    ws = ensureDealsSchema_()
    row_num = findRowByIdColumn_(ws, "Deal ID", dealId)
    if row_num == -1:
        raise Exception("This deal could not be found - it may have been deleted or converted by someone else.")
    headers = sheets.header_row(ws)
    col = {h: i + 1 for i, h in enumerate(headers)}

    if newStage == "Proposed Bid":
        amount = _to_float(extra.get("amount"))
        if amount is None or amount <= 0:
            raise Exception("A valid bid amount is required to move a deal to Proposed Bid.")
        if "Amount" in col:
            sheets.update_cell(ws, row_num, col["Amount"], amount)

    if "Stage" in col:
        sheets.update_cell(ws, row_num, col["Stage"], newStage)

    is_closed = newStage in ("Closed Won", "Closed Lost")
    if "Closed Date" in col:
        sheets.update_cell(ws, row_num, col["Closed Date"], _now_str() if is_closed else "")
    if "Lost Reason" in col:
        sheets.update_cell(ws, row_num, col["Lost Reason"], extra.get("lostReason", "") if newStage == "Closed Lost" else "")

    return getDealsBoard()


def updateDealFields(dealId, fieldsObject):
    ws = ensureDealsSchema_()
    row_num = findRowByIdColumn_(ws, "Deal ID", dealId)
    if row_num == -1:
        raise Exception("This deal could not be found - it may have been deleted or converted by someone else.")
    locked = {"Deal ID", "Stage", "Closed Date", "Lost Reason", "Created Time"}
    headers = sheets.header_row(ws)
    for i, header in enumerate(headers):
        if header in locked:
            continue
        if isinstance(fieldsObject, dict) and header in fieldsObject:
            sheets.update_cell(ws, row_num, i + 1, fieldsObject[header])
    return getDealsBoard()


def deleteDealById(dealId):
    ws = ensureDealsSchema_()
    row_num = findRowByIdColumn_(ws, "Deal ID", dealId)
    if row_num == -1:
        raise Exception("This deal could not be found - it may have already been deleted.")
    sheets.delete_row(ws, row_num)
    return getDealsBoard()


# ---- Manage Columns ----

def syncColumns(sheetName, columnsState):
    ws = sheets.get_worksheet(sheetName)
    if ws is None:
        ws = sheets.ensure_worksheet(sheetName, [c["newName"] for c in columnsState] or ["Column"])

    data = sheets.get_all_values(ws)
    new_headers = [c["newName"] for c in columnsState]

    required = {"Deals": "Deal ID", "Attachments": "Attachment ID"}.get(sheetName)
    if required and required not in new_headers:
        raise Exception('The "%s" column is required for %s and can\'t be removed.' % (required, sheetName))

    if len(new_headers) == 0:
        sheets.clear_worksheet(ws)
        return getSheetData(sheetName)

    new_data = [new_headers]
    if data and not (len(data) == 1 and (not data[0] or (len(data[0]) == 1 and data[0][0] == ""))):
        old_headers = data[0]
        for row in data[1:]:
            new_row = []
            for col in columnsState:
                old_name = col.get("oldName")
                if old_name and old_name in old_headers:
                    oi = old_headers.index(old_name)
                    new_row.append(row[oi] if oi < len(row) else "")
                else:
                    new_row.append("")
            new_data.append(new_row)

    sheets.set_all(ws, new_headers, new_data[1:])
    try:
        sheets.clear_all_validations(ws)
    except Exception:
        pass

    num_rows = max(ws.row_count - 1, 1)
    for idx, col in enumerate(columnsState):
        is_dynamic_account = (sheetName in ("Contacts", "Deals") and col.get("newName") in ("Account", "Account ID"))
        if col.get("type") == "dropdown" and col.get("options") and not is_dynamic_account:
            try:
                sheets.apply_list_validation(ws, idx, col["options"], 2, num_rows, False)
            except Exception:
                pass
    return getSheetData(sheetName)


# ---- Import ----

def importSpreadsheetData(sheetName, data, mode=None, keyColumn=None):
    ws = sheets.get_worksheet(sheetName)
    if ws is None:
        ws = sheets.ensure_worksheet(sheetName, DEFAULT_HEADERS.get(sheetName, ["ID"]))
    if not data:
        return getSheetData(sheetName)

    existing = sheets.get_all_values(ws)
    if mode == "upsert" and keyColumn and existing and len(existing[0]) > 0:
        return _upsert_import(ws, sheetName, data, keyColumn)

    # Replace all
    sheets.set_all(ws, data[0], data[1:])
    if sheetName == "Deals":
        ensureDealsSchema_()
    return getSheetData(sheetName)


def _upsert_import(ws, sheetName, data, keyColumn):
    import_headers = [str(h).strip() for h in data[0]]
    if keyColumn not in import_headers:
        raise Exception('The key column "%s" isn\'t in the imported file.' % keyColumn)
    import_key_idx = import_headers.index(keyColumn)

    sheet_headers = [str(h).strip() for h in sheets.header_row(ws)]
    lower_idx = {}
    for i, h in enumerate(sheet_headers):
        lower_idx.setdefault(h.lower(), i)
    if keyColumn.lower() not in lower_idx:
        raise Exception('The key column "%s" isn\'t in the %s sheet.' % (keyColumn, sheetName))
    sheet_key_idx = lower_idx[keyColumn.lower()]
    col_map = [lower_idx.get(h.lower(), -1) for h in import_headers]
    last_col = len(sheet_headers)

    def norm(v):
        return ("" if v is None else str(v)).strip().lower()

    headers, rows = _read(ws)
    existing_index = {}
    for i, r in enumerate(rows):
        k = norm(r[sheet_key_idx]) if sheet_key_idx < len(r) else ""
        if k and k not in existing_index:
            existing_index[k] = i + 2

    updated = 0
    added = 0
    new_rows = []
    for r in range(1, len(data)):
        row = data[r]
        key_val = norm(row[import_key_idx]) if import_key_idx < len(row) else ""
        if key_val == "":
            continue
        if key_val in existing_index:
            sheet_row = existing_index[key_val]
            for ii, _h in enumerate(import_headers):
                si = col_map[ii]
                if si > -1 and ii < len(row):
                    sheets.update_cell(ws, sheet_row, si + 1, row[ii])
            updated += 1
        else:
            new_row = [""] * last_col
            for ii, _h in enumerate(import_headers):
                si = col_map[ii]
                if si > -1 and ii < len(row):
                    new_row[si] = row[ii]
            for si, h in enumerate(sheet_headers):
                if h in KNOWN_ID_COLUMNS and not new_row[si]:
                    new_row[si] = _uid(KNOWN_ID_COLUMNS[h])
            new_rows.append(new_row)
            added += 1

    if new_rows:
        ws.append_rows(new_rows, value_input_option="USER_ENTERED")
    if sheetName == "Deals":
        ensureDealsSchema_()

    result = getSheetData(sheetName)
    result["importSummary"] = {"updated": updated, "added": added}
    return result


def importLeads(leadsArray):
    ws = sheets.ensure_worksheet("Leads", DEFAULT_HEADERS["Leads"])
    _headers, rows = _read(ws)
    existing_emails = set()
    for r in rows:
        if len(r) > 2 and r[2]:
            existing_emails.add(str(r[2]).strip().lower())
    imported = 0
    skipped = 0
    for lead in leadsArray:
        email = str(lead.get("email", "")).strip().lower() if lead.get("email") else ""
        if email and email not in existing_emails:
            sheets.append_row(ws, [
                _uid("LEAD"), lead.get("name") or "N/A", lead.get("email"),
                lead.get("phone") or "N/A", lead.get("company") or "N/A",
                lead.get("number") or "", lead.get("status") or "New",
                lead.get("source") or "Direct", "", _now_str(),
            ])
            existing_emails.add(email)
            imported += 1
        else:
            skipped += 1
    return {"imported": imported, "skipped": skipped}


# ---- Home dashboard ----

def getHomeData():
    now_ms = _now_ms()
    today = datetime.now()
    today_end = int(datetime(today.year, today.month, today.day).timestamp() * 1000) + DAY_MS - 1
    week_ago = now_ms - 7 * DAY_MS

    def fmt(ms):
        return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d")

    follow_ups = []
    leads_past_week = 0

    ensureLeadsFollowUp_()
    leads_ws = sheets.get_worksheet("Leads")
    if leads_ws is not None:
        headers, rows = _read(leads_ws)
        c = {h: i for i, h in enumerate(headers)}
        for row in rows:
            created = _to_ms(row[c["Created Time"]]) if "Created Time" in c and c["Created Time"] < len(row) else None
            if created is not None and created >= week_ago:
                leads_past_week += 1
            fu = _to_ms(row[c["Next Follow-up"]]) if "Next Follow-up" in c and c["Next Follow-up"] < len(row) else None
            if fu is not None and fu <= today_end:
                nm = (row[c["Name"]] if "Name" in c and row[c["Name"]] else (row[c["Company"]] if "Company" in c else "")) or "Lead"
                follow_ups.append({"entity": "Lead", "name": nm, "date": fmt(fu), "daysOverdue": (today_end - fu) // DAY_MS})

    stale_bids = []
    deals_won_past_week = 0
    won_value_past_week = 0.0
    ensureDealsSchema_()
    deals_ws = sheets.get_worksheet("Deals")
    if deals_ws is not None:
        headers, rows = _read(deals_ws)
        c = {h: i for i, h in enumerate(headers)}
        for row in rows:
            stage_raw = str(row[c["Stage"]]).strip() if "Stage" in c and c["Stage"] < len(row) else ""
            stage = next((s for s in DEAL_STAGES if s.lower() == stage_raw.lower()), None)
            name = (row[c["Deal Name"]] if "Deal Name" in c and row[c["Deal Name"]] else "") or "Deal"
            account = _strip_link(row[c["Account"]]) if "Account" in c and c["Account"] < len(row) else ""

            fu = _to_ms(row[c["Next Follow-up"]]) if "Next Follow-up" in c and c["Next Follow-up"] < len(row) else None
            if fu is not None and fu <= today_end:
                follow_ups.append({"entity": "Deal", "name": name, "date": fmt(fu), "daysOverdue": (today_end - fu) // DAY_MS})

            if stage in ("Awaiting Decision", "Proposed Bid"):
                created = _to_ms(row[c["Created Time"]]) if "Created Time" in c and c["Created Time"] < len(row) else None
                if created is not None:
                    days_open = (now_ms - created) // DAY_MS
                    if days_open > 14:
                        stale_bids.append({"name": name, "account": account, "daysOpen": days_open})

            if stage == "Closed Won":
                closed = _to_ms(row[c["Closed Date"]]) if "Closed Date" in c and c["Closed Date"] < len(row) else None
                if closed is not None and closed >= week_ago:
                    deals_won_past_week += 1
                    amt = _to_float(row[c["Amount"]]) if "Amount" in c and c["Amount"] < len(row) else None
                    if amt is not None:
                        won_value_past_week += amt

    follow_ups.sort(key=lambda x: x["daysOverdue"], reverse=True)
    stale_bids.sort(key=lambda x: x["daysOpen"], reverse=True)

    latest_visit = {}
    visits_past_week = 0
    visits_ws = sheets.get_worksheet("Visits")
    if visits_ws is not None:
        headers, rows = _read(visits_ws)
        c = {h: i for i, h in enumerate(headers)}
        for row in rows:
            ms = _to_ms(row[c["Visit Date"]]) if "Visit Date" in c and c["Visit Date"] < len(row) else None
            if ms is None:
                continue
            if ms >= week_ago:
                visits_past_week += 1
            acc = row[c["Account ID"]] if "Account ID" in c and c["Account ID"] < len(row) else None
            if acc and (acc not in latest_visit or ms > latest_visit[acc]):
                latest_visit[acc] = ms

    overdue_visits = []
    ensureAccountsVisitColumns_()
    acc_ws = sheets.get_worksheet("Accounts")
    if acc_ws is not None:
        headers, rows = _read(acc_ws)
        c = {h: i for i, h in enumerate(headers)}
        for row in rows:
            aid = row[c["Account ID"]] if "Account ID" in c and c["Account ID"] < len(row) else None
            if not aid:
                continue
            # A brand-new account with zero visits yet isn't "neglected" - give it a
            # week before it starts showing up as overdue/never-visited.
            created = _to_ms(row[c["Created Time"]]) if "Created Time" in c and c["Created Time"] < len(row) else None
            if created is not None and created >= week_ago:
                continue
            nm = (row[c["Account Name"]] if "Account Name" in c and row[c["Account Name"]] else aid)
            last = latest_visit.get(aid)
            if not last:
                overdue_visits.append({"name": nm, "lastVisit": None, "daysSince": None})
            else:
                days = (now_ms - last) // DAY_MS
                if days > 30:
                    overdue_visits.append({"name": nm, "lastVisit": fmt(last), "daysSince": days})
    # Never-visited accounts (daysSince=None) are the most urgent, not the least - treat
    # them as infinitely overdue so they sort first instead of ranking behind every
    # account with even one old visit.
    overdue_visits.sort(key=lambda x: x["daysSince"] if x["daysSince"] is not None else float("inf"), reverse=True)

    return {
        "pastWeek": {"leads": leads_past_week, "visits": visits_past_week,
                     "dealsWon": deals_won_past_week, "wonValue": won_value_past_week},
        "followUps": {"count": len(follow_ups), "items": follow_ups[:25]},
        "overdueVisits": {"count": len(overdue_visits), "items": overdue_visits[:25]},
        "staleBids": {"count": len(stale_bids), "items": stale_bids[:25]},
    }


# ---- Duplicate detect & merge ----

def findDuplicateGroups(sheetName, keyColumn):
    ws = sheets.get_worksheet(sheetName)
    if ws is None:
        return {"groups": []}
    headers, rows = _read(ws)
    if not rows:
        return {"groups": []}
    headers = [str(h).strip() for h in headers]
    if keyColumn not in headers:
        raise Exception('Column "%s" not found in %s.' % (keyColumn, sheetName))
    key_idx = headers.index(keyColumn)

    label_cols = []
    for n in ["Name", "Account Name", "Company", "Deal Name", "Email"]:
        if n in headers and headers.index(n) not in label_cols:
            label_cols.append(headers.index(n))

    groups_map = {}
    for i, row in enumerate(rows):
        raw_key = _norm(row[key_idx]) if key_idx < len(row) else ""
        if raw_key == "":
            continue
        k = raw_key.lower()
        filled = sum(1 for c in row if c not in ("", None))
        parts = [row[ci] for ci in label_cols if ci < len(row) and row[ci] not in ("", None)]
        groups_map.setdefault(k, []).append({
            "rowIndex": i,
            "label": " · ".join(parts) if parts else raw_key,
            "keyValue": raw_key,
            "filledCount": filled,
        })

    groups = [{"key": v[0]["keyValue"], "members": v} for v in groups_map.values() if len(v) > 1]
    return {"groups": groups}


def _repoint_by_name(sheetName, colName, oldName, newName):
    ws = sheets.get_worksheet(sheetName)
    if ws is None:
        return
    headers, rows = _read(ws)
    if not rows or colName not in headers:
        return
    ci = headers.index(colName)

    def norm(v):
        return _strip_link("" if v is None else str(v)).strip().lower()

    target = norm(oldName)
    if target == "":
        return
    for i, r in enumerate(rows):
        cur = r[ci] if ci < len(r) else ""
        if norm(cur) == target:
            sheets.update_cell(ws, i + 2, ci + 1, newName)


def _repoint_visits_account(old_acc_id, new_acc_id, new_acc_name):
    ws = sheets.get_worksheet("Visits")
    if ws is None:
        return
    headers, rows = _read(ws)
    if not rows or "Account ID" not in headers:
        return
    id_i = headers.index("Account ID")
    name_i = headers.index("Account Name") if "Account Name" in headers else -1
    changed = False
    for i, r in enumerate(rows):
        if id_i < len(r) and str(r[id_i]) == str(old_acc_id):
            sheets.update_cell(ws, i + 2, id_i + 1, new_acc_id)
            if name_i > -1:
                sheets.update_cell(ws, i + 2, name_i + 1, new_acc_name)
            changed = True
    return changed


def _repoint_attachments(entity_type, old_id, new_id):
    ws = sheets.get_worksheet("Attachments")
    if ws is None:
        return
    headers, rows = _read(ws)
    if not rows or "Entity Type" not in headers or "Entity ID" not in headers:
        return
    type_i = headers.index("Entity Type")
    ent_i = headers.index("Entity ID")
    for i, r in enumerate(rows):
        if type_i < len(r) and ent_i < len(r) and r[type_i] == entity_type and str(r[ent_i]) == str(old_id):
            sheets.update_cell(ws, i + 2, ent_i + 1, new_id)


def mergeRecords(sheetName, rowIndices, masterRowIndex):
    ws = sheets.get_worksheet(sheetName)
    if ws is None:
        raise Exception(sheetName + " data isn't available right now - contact your admin.")
    headers, rows = _read(ws)
    headers = [str(h).strip() for h in headers]
    last_col = len(headers)
    idx = {h: i for i, h in enumerate(headers)}

    member = {ri: _row_at(rows, headers, ri) for ri in rowIndices}
    master = member.get(masterRowIndex)
    if master is None:
        raise Exception("The chosen master record could not be read.")
    dup_indices = [ri for ri in rowIndices if ri != masterRowIndex]
    if not dup_indices:
        raise Exception("Select at least two records to merge.")

    for ci in range(last_col):
        if master[ci] in ("", None):
            for di in dup_indices:
                dv = member[di][ci] if ci < len(member[di]) else ""
                if dv not in ("", None):
                    master[ci] = dv
                    break
    sheets.set_row(ws, masterRowIndex + 2, master)

    if sheetName == "Accounts":
        master_acc_id = master[idx["Account ID"]] if "Account ID" in idx else ""
        master_acc_name = master[idx["Account Name"]] if "Account Name" in idx else ""
        for di in dup_indices:
            dr = member[di]
            dup_acc_id = dr[idx["Account ID"]] if "Account ID" in idx else ""
            dup_acc_name = dr[idx["Account Name"]] if "Account Name" in idx else ""
            if dup_acc_id:
                _repoint_visits_account(dup_acc_id, master_acc_id, master_acc_name)
            if dup_acc_name:
                _repoint_by_name("Contacts", "Account", dup_acc_name, master_acc_name)
                _repoint_by_name("Deals", "Account", dup_acc_name, master_acc_name)
    elif sheetName == "Leads":
        master_lead_id = master[idx["Lead ID"]] if "Lead ID" in idx else ""
        for di in dup_indices:
            dup_lead_id = member[di][idx["Lead ID"]] if "Lead ID" in idx else ""
            if dup_lead_id:
                _repoint_attachments("Lead", dup_lead_id, master_lead_id)

    for sheet_row in sorted((ri + 2 for ri in dup_indices), reverse=True):
        sheets.delete_row(ws, sheet_row)

    result = getSheetData(sheetName)
    result["mergeSummary"] = {"merged": len(dup_indices)}
    return result


# ---- Analytics ----

def getAnalyticsData(opts=None):
    opts = opts or {}
    now_ms = _now_ms()
    week_ago = now_ms - 7 * DAY_MS
    UNASSIGNED = "(Unassigned)"
    rep_filter = opts.get("rep") or ""
    terr_filter = opts.get("territory") or ""

    def parse_day(s, end_of_day):
        if not s:
            return None
        ms = _to_ms(s)
        if ms is None:
            return None
        d = datetime.fromtimestamp(ms / 1000)
        base = int(datetime(d.year, d.month, d.day).timestamp() * 1000)
        return base + DAY_MS - 1 if end_of_day else base

    start_ms = parse_day(opts.get("startDate"), False)
    end_ms = parse_day(opts.get("endDate"), True)
    has_window = start_ms is not None and end_ms is not None and end_ms >= start_ms
    prev_start_ms = prev_end_ms = None
    if has_window:
        length = end_ms - start_ms
        prev_end_ms = start_ms - 1
        prev_start_ms = prev_end_ms - length

    def in_cur(ms):
        return (not has_window) or (start_ms <= ms <= end_ms)

    def in_prev(ms):
        return has_window and prev_start_ms <= ms <= prev_end_ms

    def seg_match(rep_val, terr_val):
        if rep_filter:
            v = _norm(rep_val)
            if rep_filter == UNASSIGNED:
                if v != "":
                    return False
            elif v.lower() != rep_filter.lower():
                return False
        if terr_filter:
            v = _norm(terr_val)
            if terr_filter == UNASSIGNED:
                if v != "":
                    return False
            elif v.lower() != terr_filter.lower():
                return False
        return True

    rep_options = {}
    terr_options = {}

    def add_opt(m, v):
        s = _norm(v)
        if s and s.lower() not in m:
            m[s.lower()] = s

    def pick_col(headers, candidates):
        for cand in candidates:
            if cand in headers:
                return headers.index(cand)
        return -1

    def map_to_sorted(m, key_name):
        return sorted(({key_name: k, "count": v} for k, v in m.items()), key=lambda x: x["count"], reverse=True)

    # ---- LEADS ----
    total_leads = 0
    total_leads_prev = 0
    leads_by_status = {}
    leads_by_source = {}
    leads_ws = sheets.get_worksheet("Leads")
    if leads_ws is not None:
        h, rows = _read(leads_ws)
        status_i = h.index("Status") if "Status" in h else -1
        source_i = h.index("Source") if "Source" in h else -1
        created_i = h.index("Created Time") if "Created Time" in h else -1
        rep_i = pick_col(h, ["Sales Rep", "(Sales Rep)", "Rep"])
        terr_i = pick_col(h, ["Territory", "Region"])
        for row in rows:
            if rep_i > -1:
                add_opt(rep_options, row[rep_i] if rep_i < len(row) else "")
            if terr_i > -1:
                add_opt(terr_options, row[terr_i] if terr_i < len(row) else "")
            if not seg_match(row[rep_i] if rep_i > -1 and rep_i < len(row) else "",
                             row[terr_i] if terr_i > -1 and terr_i < len(row) else ""):
                continue
            cms = _to_ms(row[created_i]) if created_i > -1 and created_i < len(row) else None
            in_c = (not has_window) or (cms is not None and in_cur(cms))
            in_p = has_window and cms is not None and in_prev(cms)
            if in_p:
                total_leads_prev += 1
            if in_c:
                total_leads += 1
                if status_i > -1:
                    s = str(row[status_i]) if status_i < len(row) and row[status_i] else "Unspecified"
                    leads_by_status[s] = leads_by_status.get(s, 0) + 1
                if source_i > -1:
                    s = str(row[source_i]) if source_i < len(row) and row[source_i] else "Unspecified"
                    leads_by_source[s] = leads_by_source.get(s, 0) + 1

    # ---- DEALS ----
    open_deal_count = 0
    total_pipeline_value = 0.0
    deal_amount_sum = 0.0
    deal_amount_count = 0
    closed_won = 0
    closed_lost = 0
    total_won_value = 0.0
    closed_won_prev = 0
    closed_lost_prev = 0
    total_won_value_prev = 0.0
    deals_by_stage = {s: {"count": 0, "totalAmount": 0.0} for s in DEAL_STAGES}
    per_month = {}
    deals_ws = sheets.get_worksheet("Deals")
    if deals_ws is not None:
        h, rows = _read(deals_ws)
        stage_i = h.index("Stage") if "Stage" in h else -1
        amount_i = h.index("Amount") if "Amount" in h else -1
        closed_i = h.index("Closed Date") if "Closed Date" in h else -1
        rep_i = h.index("Sales Rep") if "Sales Rep" in h else -1
        terr_i = h.index("Territory") if "Territory" in h else -1
        for row in rows:
            if rep_i > -1:
                add_opt(rep_options, row[rep_i] if rep_i < len(row) else "")
            if terr_i > -1:
                add_opt(terr_options, row[terr_i] if terr_i < len(row) else "")
            if not seg_match(row[rep_i] if rep_i > -1 and rep_i < len(row) else "",
                             row[terr_i] if terr_i > -1 and terr_i < len(row) else ""):
                continue
            stage_raw = str(row[stage_i]).strip() if stage_i > -1 and stage_i < len(row) else ""
            stage = next((s for s in DEAL_STAGES if s.lower() == stage_raw.lower()), None)
            amount = _to_float(row[amount_i]) if amount_i > -1 and amount_i < len(row) else None
            has_amount = amount is not None and amount > 0

            if stage:
                deals_by_stage[stage]["count"] += 1
                if has_amount:
                    deals_by_stage[stage]["totalAmount"] += amount
            if stage in ("Awaiting Decision", "Proposed Bid"):
                open_deal_count += 1
                if has_amount:
                    total_pipeline_value += amount
            if has_amount:
                deal_amount_sum += amount
                deal_amount_count += 1

            if stage in ("Closed Won", "Closed Lost"):
                closed_ms = _to_ms(row[closed_i]) if closed_i > -1 and closed_i < len(row) else None
                valid_close = closed_ms is not None
                if (not has_window) or (valid_close and in_cur(closed_ms)):
                    if stage == "Closed Won":
                        closed_won += 1
                        if has_amount:
                            total_won_value += amount
                    else:
                        closed_lost += 1
                if has_window and valid_close and in_prev(closed_ms):
                    if stage == "Closed Won":
                        closed_won_prev += 1
                        if has_amount:
                            total_won_value_prev += amount
                    else:
                        closed_lost_prev += 1
                if valid_close:
                    d = datetime.fromtimestamp(closed_ms / 1000)
                    mk = "%d-%02d" % (d.year, d.month)
                    bucket = per_month.setdefault(mk, {"wonCount": 0, "lostCount": 0, "wonAmount": 0.0})
                    if stage == "Closed Won":
                        bucket["wonCount"] += 1
                        if has_amount:
                            bucket["wonAmount"] += amount
                    else:
                        bucket["lostCount"] += 1

    # ---- ACCOUNTS segment map ----
    acc_seg = {}
    ensureAccountsVisitColumns_()
    acc_ws = sheets.get_worksheet("Accounts")
    if acc_ws is not None:
        h, rows = _read(acc_ws)
        id_i = h.index("Account ID") if "Account ID" in h else -1
        name_i = h.index("Account Name") if "Account Name" in h else -1
        rep_i = h.index("Sales Rep") if "Sales Rep" in h else -1
        terr_i = h.index("Territory") if "Territory" in h else -1
        created_i = h.index("Created Time") if "Created Time" in h else -1
        for row in rows:
            aid = row[id_i] if id_i > -1 and id_i < len(row) else None
            if not aid:
                continue
            rep = row[rep_i] if rep_i > -1 and rep_i < len(row) else ""
            terr = row[terr_i] if terr_i > -1 and terr_i < len(row) else ""
            add_opt(rep_options, rep)
            add_opt(terr_options, terr)
            created = _to_ms(row[created_i]) if created_i > -1 and created_i < len(row) else None
            acc_seg[aid] = {"rep": rep, "terr": terr, "created": created,
                            "name": row[name_i] if name_i > -1 and name_i < len(row) and row[name_i] else aid}

    # ---- VISITS ----
    latest_visit = {}
    visits_in_period = 0
    visits_prev = 0
    visits_per_month = {}
    visits_ws = sheets.get_worksheet("Visits")
    if visits_ws is not None:
        h, rows = _read(visits_ws)
        acc_i = h.index("Account ID") if "Account ID" in h else -1
        date_i = h.index("Visit Date") if "Visit Date" in h else -1
        for row in rows:
            ms = _to_ms(row[date_i]) if date_i > -1 and date_i < len(row) else None
            if ms is None:
                continue
            acc = row[acc_i] if acc_i > -1 and acc_i < len(row) else None
            seg = acc_seg.get(acc) if acc else None
            if not seg_match(seg["rep"] if seg else "", seg["terr"] if seg else ""):
                continue
            if in_cur(ms):
                visits_in_period += 1
            if in_prev(ms):
                visits_prev += 1
            d = datetime.fromtimestamp(ms / 1000)
            mk = "%d-%02d" % (d.year, d.month)
            visits_per_month[mk] = visits_per_month.get(mk, 0) + 1
            if acc and (acc not in latest_visit or ms > latest_visit[acc]):
                latest_visit[acc] = ms

    # ---- OVERDUE ACCOUNTS ----
    overdue = []
    for aid, seg in acc_seg.items():
        if not seg_match(seg["rep"], seg["terr"]):
            continue
        # Grace period: a brand-new account with zero visits yet isn't neglected.
        if seg.get("created") is not None and seg["created"] >= week_ago:
            continue
        last = latest_visit.get(aid)
        if not last:
            overdue.append({"name": seg["name"], "lastVisit": None, "daysSince": None})
        else:
            days = (now_ms - last) // DAY_MS
            if days > 30:
                overdue.append({"name": seg["name"], "lastVisit": datetime.fromtimestamp(last / 1000).strftime("%Y-%m-%d"), "daysSince": days})
    # Same fix as getHomeData's overdue_visits: never-visited accounts are infinitely
    # overdue, not the least urgent - they should surface first, not get pushed behind
    # (and potentially truncated past) every account with some visit history.
    overdue.sort(key=lambda x: x["daysSince"] if x["daysSince"] is not None else float("inf"), reverse=True)

    win_rate = (closed_won / (closed_won + closed_lost)) if (closed_won + closed_lost) > 0 else None
    win_rate_prev = (closed_won_prev / (closed_won_prev + closed_lost_prev)) if (has_window and (closed_won_prev + closed_lost_prev) > 0) else None
    avg_deal_size = (deal_amount_sum / deal_amount_count) if deal_amount_count > 0 else None

    return {
        "hasWindow": has_window,
        "kpis": {
            "totalLeads": total_leads, "openDealCount": open_deal_count,
            "closedWonCount": closed_won, "closedLostCount": closed_lost,
            "totalPipelineValue": total_pipeline_value, "totalWonValue": total_won_value,
            "winRate": win_rate, "averageDealSize": avg_deal_size, "visits": visits_in_period,
        },
        "kpisPrev": ({
            "totalLeads": total_leads_prev, "closedWonCount": closed_won_prev,
            "closedLostCount": closed_lost_prev, "totalWonValue": total_won_value_prev,
            "winRate": win_rate_prev, "visits": visits_prev,
        } if has_window else None),
        "leadsByStatus": map_to_sorted(leads_by_status, "status"),
        "leadsBySource": map_to_sorted(leads_by_source, "source"),
        "dealsByStage": [{"stage": s, "count": deals_by_stage[s]["count"], "totalAmount": deals_by_stage[s]["totalAmount"]} for s in DEAL_STAGES],
        "dealsClosedPerMonth": [{"month": m, "wonCount": per_month[m]["wonCount"], "lostCount": per_month[m]["lostCount"], "wonAmount": per_month[m]["wonAmount"]} for m in sorted(per_month.keys())],
        "visits": {
            "inPeriod": visits_in_period, "overdueCount": len(overdue),
            "overdue": overdue[:25],
            "perMonth": [{"month": m, "count": visits_per_month[m]} for m in sorted(visits_per_month.keys())],
        },
        "filterOptions": {
            "reps": [rep_options[k] for k in sorted(rep_options.keys())],
            "territories": [terr_options[k] for k in sorted(terr_options.keys())],
        },
    }
