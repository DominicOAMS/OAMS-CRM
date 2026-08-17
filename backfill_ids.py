"""
One-time (re-runnable) fix for records that predate their sheet's internal ID column -
everything imported from the original Google Sheet via import_from_sheets.py, before
Lead ID / Account ID / Contact ID existed as columns there. Without an ID, a Lead/Account
can't be addressed by Attachments, Log Visit, View Visits, Add Contact, or the Home
dashboard's overdue-accounts widget - they all key off these columns, not row position.

For each target sheet: adds the ID column if it's missing entirely, then assigns a fresh
unique ID (same format logic.py uses for new records) to every row that doesn't already
have one. Existing IDs are never touched, so this is safe to re-run any time - already-
backfilled rows are simply skipped, and re-importing more old data later just means
running this again to cover the new rows.

Run:  python backfill_ids.py
"""

import sheets
from logic import _uid

TARGETS = [
    ("Leads", "Lead ID", "LEAD"),
    ("Accounts", "Account ID", "ACC"),
    ("Contacts", "Contact ID", "CON"),
]


def backfill():
    for sheet_name, id_col, prefix in TARGETS:
        ws = sheets.get_worksheet(sheet_name)
        if ws is None:
            print("%-10s skipped (sheet not found)" % sheet_name)
            continue

        headers = sheets.header_row(ws)
        if id_col not in headers:
            sheets.add_columns(ws, [id_col])
            headers = sheets.header_row(ws)
            print("%-10s added missing column '%s'" % (sheet_name, id_col))
        idx = headers.index(id_col)
        col1 = idx + 1

        vals = sheets.get_all_values(ws)  # [headers, *rows]
        filled = 0
        for row_offset, row in enumerate(vals[1:]):
            row1 = row_offset + 2
            current = row[idx] if idx < len(row) else ""
            if not str(current).strip():
                sheets.update_cell(ws, row1, col1, _uid(prefix))
                filled += 1
        total = len(vals) - 1
        print("%-10s backfilled %d of %d row(s) (%d already had an ID)" %
              (sheet_name, filled, total, total - filled))


if __name__ == "__main__":
    backfill()
