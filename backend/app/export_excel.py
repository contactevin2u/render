from io import BytesIO
from openpyxl import Workbook

def orders_to_excel(rows):
    wb = Workbook()
    ws = wb.active
    ws.title = "orders"
    headers = ["order_code","type","status","customer","phone","total","paid","balance"]
    ws.append(headers)
    for r in rows:
        ws.append([r.get(h) for h in headers])
    out = BytesIO()
    wb.save(out)
    return out.getvalue()
