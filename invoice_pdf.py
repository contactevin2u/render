from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from io import BytesIO
from datetime import datetime
import urllib.request

HEADER_Y = 820
LEFT_X = 40
RIGHT_X = 560

def draw_key_value(c, x, y, k, v):
    c.drawString(x, y, f"{k}:")
    c.drawRightString(RIGHT_X, y, v)

def draw_profile(c, profile):
    y = HEADER_Y
    if profile:
        if getattr(profile, "logo_url", None):
            try:
                data = urllib.request.urlopen(profile.logo_url).read()
                img = ImageReader(BytesIO(data))
                c.drawImage(img, LEFT_X, y-40, width=120, height=40, preserveAspectRatio=True, mask='auto')
            except Exception:
                pass
        c.setFont("Helvetica-Bold", 14)
        c.drawRightString(RIGHT_X, y, getattr(profile, "company_name", "") or "")
        c.setFont("Helvetica", 9)
        lines = [
            f"Reg: {profile.registration_no}" if getattr(profile, "registration_no", None) else None,
            getattr(profile, "address", None),
            f"Phone: {profile.phone}" if getattr(profile, "phone", None) else None,
            f"Email: {profile.email}" if getattr(profile, "email", None) else None,
        ]
        y2 = y-16
        for line in [l for l in lines if l]:
            c.drawRightString(RIGHT_X, y2, line[:90])
            y2 -= 12

def generate_invoice_pdf(order, items, customer, payments=None, title="INVOICE", profile=None) -> bytes:
    buf = BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setTitle(title)

    draw_profile(c, profile)

    c.setFont("Helvetica-Bold", 16)
    c.drawString(LEFT_X, 760, f"{title} #{order.order_code}")
    c.setFont("Helvetica", 10)
    draw_key_value(c, LEFT_X, 742, "Date", datetime.utcnow().strftime("%Y-%m-%d"))
    draw_key_value(c, LEFT_X, 727, "Customer", customer.name)
    if getattr(customer, "phone", None):
        draw_key_value(c, LEFT_X, 712, "Phone", customer.phone)
    if getattr(customer, "address", None):
        c.drawString(LEFT_X, 697, f"Address: {customer.address[:90]}")

    y = 670
    c.setFont("Helvetica-Bold", 11)
    c.drawString(LEFT_X, y, "Item")
    c.drawRightString(480, y, "Qty")
    c.drawRightString(520, y, "Unit")
    c.drawRightString(RIGHT_X, y, "Total")
    c.line(LEFT_X, y-5, RIGHT_X, y-5)

    c.setFont("Helvetica", 10)
    total = 0
    y -= 20
    for it in items:
        line_total = float(it.unit_price) * it.qty
        total += line_total
        c.drawString(LEFT_X, y, it.name)
        c.drawRightString(480, y, str(it.qty))
        c.drawRightString(520, y, f"{float(it.unit_price):.2f}")
        c.drawRightString(RIGHT_X, y, f"{line_total:.2f}")
        y -= 16

    c.line(400, y-5, RIGHT_X, y-5)
    c.setFont("Helvetica-Bold", 12)
    c.drawRightString(520, y-20, "Total")
    c.drawRightString(RIGHT_X, y-20, f"{total:.2f}")

    if payments:
        paid = sum(float(getattr(p, "amount", 0)) for p in payments)
        c.setFont("Helvetica", 10)
        c.drawRightString(520, y-40, "Paid")
        c.drawRightString(RIGHT_X, y-40, f"{paid:.2f}")
        c.setFont("Helvetica-Bold", 12)
        c.drawRightString(520, y-60, "Balance")
        c.drawRightString(RIGHT_X, y-60, f"{(total-paid):.2f}")

    if profile:
        c.setFont("Helvetica", 9)
        footer_y = 80
        bank = []
        if getattr(profile, "bank_name", None) or getattr(profile, "bank_account_no", None):
            bank.append(f"Bank: {profile.bank_name or ''}  Acc: {profile.bank_account_no or ''}  Name: {profile.bank_account_name or ''}")
        if getattr(profile, "footer_note", None):
            bank.append(profile.footer_note)
        for i, line in enumerate(bank):
            c.drawString(LEFT_X, footer_y + i*12, line[:100])

    c.showPage(); c.save()
    buf.seek(0)
    return buf.read()
