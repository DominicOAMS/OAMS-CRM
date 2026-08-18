"""
Quote PDF generation for a Deal - a plain, honest document (no fabricated company
letterhead/address, since this app has no "company profile" of its own to draw one
from): quote date, the deal and who prepared it, who it's for (Account + a best-effort
matched Contact), an itemized products table (falling back to a single line using the
Deal's own Amount if it has no line items yet), and a total.
"""

import io
from datetime import datetime

from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer

import logic


def _find_deal(dealId):
    data = logic.getSheetData("Deals")
    cols = [c["name"] for c in data["columns"]]
    if "Deal ID" not in cols:
        return None, cols
    id_i = cols.index("Deal ID")
    for row in data["rows"]:
        if id_i < len(row) and str(row[id_i]) == str(dealId):
            return row, cols
    return None, cols


def _find_contact_for_account(account_name):
    if not account_name:
        return None
    data = logic.getSheetData("Contacts")
    cols = [c["name"] for c in data["columns"]]
    name_i = cols.index("Account Name") if "Account Name" in cols else (cols.index("Account") if "Account" in cols else -1)
    if name_i == -1:
        return None
    first_i = cols.index("First Name") if "First Name" in cols else -1
    last_i = cols.index("Last Name") if "Last Name" in cols else -1
    email_i = cols.index("Email") if "Email" in cols else -1
    phone_i = cols.index("Phone") if "Phone" in cols else -1
    target = account_name.strip().lower()
    for row in data["rows"]:
        if name_i < len(row) and str(row[name_i] or "").strip().lower() == target:
            first = row[first_i] if 0 <= first_i < len(row) else ""
            last = row[last_i] if 0 <= last_i < len(row) else ""
            name = (str(first or "") + " " + str(last or "")).strip()
            return {
                "name": name,
                "email": row[email_i] if 0 <= email_i < len(row) else "",
                "phone": row[phone_i] if 0 <= phone_i < len(row) else "",
            }
    return None


def _peso(v):
    return "₱{:,.2f}".format(v or 0.0)


def generate_quote_pdf(dealId):
    row, cols = _find_deal(dealId)
    if row is None:
        raise Exception("Deal not found: " + str(dealId))

    def get(name):
        i = cols.index(name) if name in cols else -1
        return row[i] if 0 <= i < len(row) else ""

    deal_name = get("Deal Name") or "Untitled Deal"
    account_name = str(get("Account") or "").strip()
    sales_rep = get("Sales Rep") or ""
    amount = logic._to_float(get("Amount")) or 0.0

    line_items = logic.listDealLineItems(dealId)
    contact = _find_contact_for_account(account_name)

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=LETTER, topMargin=0.6 * inch, bottomMargin=0.6 * inch,
                             leftMargin=0.6 * inch, rightMargin=0.6 * inch)
    styles = getSampleStyleSheet()

    elements = [
        Paragraph("QUOTATION", styles["Title"]),
        Spacer(1, 4),
        Paragraph("Quote Date: %s" % datetime.now().strftime("%Y-%m-%d"), styles["Normal"]),
        Paragraph("Deal: %s (Ref: %s)" % (deal_name, dealId), styles["Normal"]),
    ]
    if sales_rep:
        elements.append(Paragraph("Prepared by: %s" % sales_rep, styles["Normal"]))
    elements.append(Spacer(1, 14))

    elements.append(Paragraph("Quoted To:", styles["Heading3"]))
    elements.append(Paragraph(account_name or "—", styles["Normal"]))
    if contact and contact["name"]:
        contact_line = contact["name"]
        if contact["email"]:
            contact_line += " &middot; " + contact["email"]
        if contact["phone"]:
            contact_line += " &middot; " + contact["phone"]
        elements.append(Paragraph(contact_line, styles["Normal"]))
    elements.append(Spacer(1, 18))

    table_data = [["Product", "Qty", "Unit Price", "Line Total"]]
    if line_items:
        for it in line_items:
            table_data.append([
                it["productName"] or "—",
                str(it["quantity"]),
                _peso(it["unitPrice"]),
                _peso(it["lineTotal"]),
            ])
        total_amount = sum(it["lineTotal"] for it in line_items)
    else:
        table_data.append([deal_name, "1", _peso(amount), _peso(amount)])
        total_amount = amount

    table = Table(table_data, colWidths=[3.2 * inch, 0.7 * inch, 1.3 * inch, 1.3 * inch])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0088ff")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
        ("ALIGN", (0, 0), (0, -1), "LEFT"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e1e5eb")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f9fbfd")]),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    elements.append(table)
    elements.append(Spacer(1, 10))

    total_table = Table([["Total", _peso(total_amount)]], colWidths=[5.2 * inch, 1.3 * inch])
    total_table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 12),
        ("ALIGN", (1, 0), (1, 0), "RIGHT"),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
    ]))
    elements.append(total_table)

    doc.build(elements)
    return buf.getvalue()
