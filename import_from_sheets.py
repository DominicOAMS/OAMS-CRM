"""
One-time importer — pulls your existing data from the Google Sheet into the local
database, with NO login, service account, or API key.

It reads each tab through the Sheet's public CSV export, so the ONLY requirement is that
the Sheet is link-viewable:
    Google Sheet -> Share -> General access -> "Anyone with the link" -> Viewer

Then run:
    python import_from_sheets.py

It replaces each local tab with the Sheet's current contents. Run it again anytime to
re-sync. (The Attachments tab is skipped - those point at Google Drive files that don't
exist locally.)
"""

import csv
import io
import sys
from urllib.parse import quote
from urllib.request import urlopen, Request

import config
import logic

TABS = ["Leads", "Contacts", "Accounts", "Deals", "Visits"]


def _fetch_csv(tab):
    url = ("https://docs.google.com/spreadsheets/d/%s/gviz/tq?tqx=out:csv&sheet=%s"
           % (config.SPREADSHEET_ID, quote(tab)))
    req = Request(url, headers={"User-Agent": "Mozilla/5.0 (crm-importer)"})
    with urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    # A private sheet redirects to a Google sign-in HTML page instead of CSV.
    head = raw.lstrip()[:200].lower()
    if head.startswith("<!doctype") or head.startswith("<html") or "sign in" in head:
        raise RuntimeError("got a login page, not CSV")
    return raw


def main():
    if not config.SPREADSHEET_ID:
        print("No spreadsheet id set (config.SPREADSHEET_ID / CRM_SPREADSHEET_ID).")
        sys.exit(1)

    print("Importing from spreadsheet %s\n" % config.SPREADSHEET_ID)
    total = 0
    seen = {}  # raw CSV text -> the tab it was imported as
    for tab in TABS:
        try:
            csv_text = _fetch_csv(tab)
        except Exception as e:
            print("  %-10s skipped (%s)" % (tab, e))
            continue
        # Google's CSV export returns the FIRST tab when the requested tab doesn't
        # exist, so identical content to an already-imported tab means "no such tab".
        if csv_text in seen:
            print("  %-10s skipped (no such tab in the Sheet - it mirrored '%s')" % (tab, seen[csv_text]))
            continue
        rows = list(csv.reader(io.StringIO(csv_text)))
        rows = [r for r in rows if any((c or "").strip() for c in r)]  # drop blank rows
        if not rows:
            print("  %-10s empty" % tab)
            continue
        seen[csv_text] = tab
        logic.importSpreadsheetData(tab, rows)  # default mode = replace
        n = max(len(rows) - 1, 0)
        total += n
        print("  %-10s imported %d rows" % (tab, n))

    print("\nDone. %d rows total. Start the app with:  python app.py" % total)
    print("If tabs were skipped with 'login page', set the Sheet to "
          "'Anyone with the link -> Viewer' and re-run.")


if __name__ == "__main__":
    main()
