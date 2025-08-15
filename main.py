import os
from fastapi import FastAPI, Depends, HTTPException, Response, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sqlalchemy import select, func, or_, text as sqltext

from .db import SessionLocal, engine
from . import models
from .schemas import ParseRequest, ParseResponse, ParsedOrder, ParsedEvent, OrderUpdate, OrderSummary, EventIn
from .parser import parse_text
from .utils import sha256_text, norm_phone
from .invoice_pdf import generate_invoice_pdf
from .export_excel import orders_to_excel

models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="OMS FastAPI")

ALLOW = os.getenv("CORS_ORIGIN", "http://localhost:3000").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOW,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

STATUS_MAP = {
    "RETURN": "RETURNED",
    "COLLECT": "RETURNED",
    "INSTALMENT_CANCEL": "CANCELLED",
    "BUYBACK": "CANCELLED",
}

def totals_for_order(db: Session, order: models.Order):
    items = db.execute(select(models.OrderItem).where(models.OrderItem.order_id==order.id)).scalars().all()
    total = sum(float(i.unit_price)*i.qty for i in items)
    paid = db.execute(select(func.coalesce(func.sum(models.Payment.amount),0)).where(models.Payment.order_id==order.id)).scalar() or 0.0
    balance = float(total) - float(paid)
    return total, paid, balance, items

def apply_item_defaults(db: Session, name: str, sku: str | None, unit_price: float | None):
    if sku:
        prod = db.get(models.Product, sku)
        if prod and (unit_price is None or float(unit_price) == 0):
            unit_price = float(prod.default_price or 0)
        return sku, unit_price or 0.0, name
    alias = db.execute(select(models.ProductAlias).where(models.ProductAlias.alias.ilike(name))).scalar_one_or_none()
    if alias:
        prod = db.get(models.Product, alias.sku)
        return alias.sku, float(prod.default_price or 0) if prod else (unit_price or 0.0), name
    prod = db.execute(select(models.Product).where(models.Product.name.ilike(name))).scalar_one_or_none()
    if prod:
        return prod.sku, float(prod.default_price or 0), prod.name
    return sku or "", unit_price or 0.0, name

def get_profile(db: Session) -> models.CompanyProfile | None:
    return db.execute(select(models.CompanyProfile).where(models.CompanyProfile.id==1)).scalar_one_or_none()

# -------- Health (compat with Node) --------
@app.get("/api/health")
async def api_health():
    return {"ok": True}

@app.get("/api/db-health")
async def api_db_health(db: Session = Depends(get_db)):
    r = db.execute(sqltext("select now() as now")).mappings().first()
    return {"ok": True, "db_time": str(r["now"])}

# -------- OpenAI intake (/api compatible) --------
@app.post("/api/intake/parse", response_model=dict)
async def api_intake_parse(req: dict, request: Request, db: Session = Depends(get_db)):
    text = (req.get("text") or req.get("message") or "").strip()
    if not text:
        raise HTTPException(400, "Provide { text }")
    auto_create = str(request.query_params.get("create", req.get("auto_create","true"))).lower() == "true"

    parsed_order, parsed_event = await parse_text(text)
    parsed_order.phone = norm_phone(parsed_order.phone)

    if not auto_create:
        return {"parsed": parsed_order.model_dump(), "created": False}

    # Create immediately
    cust = None
    if parsed_order.phone:
        cust = db.execute(select(models.Customer).where(models.Customer.phone==parsed_order.phone)).scalar_one_or_none()
    if not cust:
        cust = models.Customer(name=parsed_order.name, phone=parsed_order.phone, address=parsed_order.address)
        db.add(cust); db.flush()

    code = parsed_order.order_id or f"ORD{(db.execute(select(func.count(models.Order.id))).scalar() or 0)+1:06d}"
    o = models.Order(order_code=code, customer_id=cust.id, type=parsed_order.type, notes=parsed_order.notes, status="CONFIRMED")
    db.add(o); db.flush()

    for it in parsed_order.items:
        sku, price, nm = apply_item_defaults(db, it.name, it.sku, it.unit_price)
        db.add(models.OrderItem(order_id=o.id, sku=sku, name=nm, qty=it.qty, unit_price=price))

    # Event auto-status if provided
    if parsed_event.type != "NONE":
        db.add(models.Event(order_id=o.id, type=parsed_event.type))
        new_status = STATUS_MAP.get(parsed_event.type)
        if new_status: o.status = new_status

    db.commit()
    return {"parsed": parsed_order.model_dump(), "created": True, "order_code": code}

# -------- Orders (compat endpoints + new) --------
@app.post("/api/orders")
async def api_create_order(payload: dict, db: Session = Depends(get_db)):
    name = payload.get("customer_name"); phone = payload.get("customer_phone_primary"); addr = payload.get("customer_address")
    order_type = payload.get("order_type","OUTRIGHT").replace("outright_purchase","OUTRIGHT").upper()
    line_items = payload.get("line_items", [])
    if not name or not phone or not line_items:
        raise HTTPException(400, "missing required fields")
    cust = db.execute(select(models.Customer).where(models.Customer.phone==phone)).scalar_one_or_none()
    if not cust:
        cust = models.Customer(name=name, phone=phone, address=addr); db.add(cust); db.flush()
    code = f"ORD{(db.execute(select(func.count(models.Order.id))).scalar() or 0)+1:06d}"
    o = models.Order(order_code=code, customer_id=cust.id, type=order_type, status="CONFIRMED")
    db.add(o); db.flush()
    for li in line_items:
        nm = li.get("description") or li.get("name")
        qty = int(li.get("qty",1)); unit = float(li.get("unit_price_myr", li.get("unit_price", 0)) or 0)
        sku = li.get("product_code") or li.get("sku") or ""
        sku, unit, nm = apply_item_defaults(db, nm, sku, unit)
        db.add(models.OrderItem(order_id=o.id, sku=sku, name=nm, qty=qty, unit_price=unit))
    db.commit()
    return {"order_code": code}

@app.get("/api/orders")
async def api_list_orders(db: Session = Depends(get_db)):
    orders = db.execute(select(models.Order).order_by(models.Order.id.desc()).limit(100)).scalars().all()
    out = []
    for o in orders:
        total, paid, balance, _ = totals_for_order(db, o)
        c = db.execute(select(models.Customer).where(models.Customer.id==o.customer_id)).scalar_one()
        out.append({"order_code": o.order_code, "order_type": o.type, "status": o.status, "created_at": o.created_at.isoformat(), "customer_name": c.name, "total_myr": total})
    return out

@app.post("/api/transactions")
async def api_add_transaction(payload: dict, db: Session = Depends(get_db)):
    code = payload.get("order_code"); amount = float(payload.get("amount_myr", payload.get("amount", 0)) or 0); method = payload.get("method","CASH")
    if not code or amount <= 0:
        raise HTTPException(400, "order_code and amount required")
    o = db.execute(select(models.Order).where(models.Order.order_code==code)).scalar_one_or_none()
    if not o: raise HTTPException(404, "Order not found")
    db.add(models.Payment(order_id=o.id, amount=amount, method=method)); db.commit()
    return {"ok": True}

@app.get("/api/outstanding")
async def api_outstanding(type: str | None = Query(None), overdue_only: bool = Query(False), db: Session = Depends(get_db)):
    stmt = select(models.Order).order_by(models.Order.id.desc())
    if type: stmt = stmt.where(models.Order.type==type.upper())
    orders = db.execute(stmt).scalars().all()
    out = []
    for o in orders:
        total, paid, balance, _ = totals_for_order(db, o)
        if not overdue_only or balance > 0.0:
            c = db.execute(select(models.Customer).where(models.Customer.id==o.customer_id)).scalar_one()
            out.append({"order_code": o.order_code, "customer_name": c.name, "phone": c.phone, "order_type": o.type, "status": o.status, "total_myr": total, "paid_myr": paid, "balance_myr": balance})
    return out

# ------- New endpoints from spec (no /api prefix also available) -------
@app.post("/parse", response_model=ParseResponse)
async def parse(req: ParseRequest, db: Session = Depends(get_db)):
    h = sha256_text(req.text)
    parsed_order, parsed_event = await parse_text(req.text)
    parsed_order.phone = norm_phone(parsed_order.phone)
    matched_code = None
    if parsed_order.phone:
        o = db.execute(select(models.Order).join(models.Customer).where(models.Customer.phone==parsed_order.phone).order_by(models.Order.id.desc())).scalars().first()
        if o: matched_code = o.order_code
    return ParseResponse(parsed=parsed_order, event=parsed_event, matched_order_code=matched_code, duplicate=False)

@app.post("/orders")
async def create_order(order: ParsedOrder, db: Session = Depends(get_db)):
    cust = None
    if order.phone:
        cust = db.execute(select(models.Customer).where(models.Customer.phone==order.phone)).scalar_one_or_none()
    if not cust:
        cust = models.Customer(name=order.name, phone=order.phone, address=order.address)
        db.add(cust); db.flush()
    code = order.order_id or f"ORD{(db.execute(select(func.count(models.Order.id))).scalar() or 0)+1:06d}"
    o = models.Order(order_code=code, customer_id=cust.id, type=order.type, notes=order.notes, status="CONFIRMED")
    db.add(o); db.flush()
    for it in order.items:
        sku, price, nm = apply_item_defaults(db, it.name, it.sku, it.unit_price)
        db.add(models.OrderItem(order_id=o.id, sku=sku, name=nm, qty=it.qty, unit_price=price))
    db.commit()
    return {"order_code": code}

@app.get("/orders")
async def list_orders(q: str | None = None, status: str | None = None, db: Session = Depends(get_db)):
    stmt = select(models.Order).join(models.Customer)
    if status: stmt = stmt.where(models.Order.status==status)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(models.Order.order_code.ilike(like), models.Customer.name.ilike(like), models.Customer.phone.ilike(like)))
    stmt = stmt.order_by(models.Order.id.desc())
    orders = db.execute(stmt).scalars().all()
    out = []
    for o in orders:
        total, paid, balance, _ = totals_for_order(db, o)
        c = db.execute(select(models.Customer).where(models.Customer.id==o.customer_id)).scalar_one()
        out.append(OrderSummary(order_code=o.order_code, type=o.type, status=o.status, customer=c.name, phone=c.phone, total=total, paid=paid, balance=balance).model_dump())
    return out

@app.get("/orders/{order_code}/invoice.pdf")
async def invoice_pdf(order_code: str, db: Session = Depends(get_db)):
    o = db.execute(select(models.Order).where(models.Order.order_code==order_code)).scalar_one_or_none()
    if not o: raise HTTPException(404, "Order not found")
    _, _, _, items = totals_for_order(db, o)
    cust = db.execute(select(models.Customer).where(models.Customer.id==o.customer_id)).scalar_one()
    payments = db.execute(select(models.Payment).where(models.Payment.order_id==o.id)).scalars().all()
    profile = get_profile(db)
    pdf = generate_invoice_pdf(o, items, cust, payments=payments, title="INVOICE", profile=profile)
    return Response(content=pdf, media_type="application/pdf")

@app.get("/orders/{order_code}/receipt.pdf")
async def receipt_pdf(order_code: str, db: Session = Depends(get_db)):
    o = db.execute(select(models.Order).where(models.Order.order_code==order_code)).scalar_one_or_none()
    if not o: raise HTTPException(404, "Order not found")
    _, _, _, items = totals_for_order(db, o)
    cust = db.execute(select(models.Customer).where(models.Customer.id==o.customer_id)).scalar_one()
    payments = db.execute(select(models.Payment).where(models.Payment.order_id==o.id)).scalars().all()
    profile = get_profile(db)
    pdf = generate_invoice_pdf(o, items, cust, payments=payments, title="RECEIPT", profile=profile)
    return Response(content=pdf, media_type="application/pdf")

@app.post("/payments")
async def add_payment(payload: dict, db: Session = Depends(get_db)):
    order_code = payload.get("order_code"); amount = float(payload.get("amount",0)); method = payload.get("method","CASH")
    o = db.execute(select(models.Order).where(models.Order.order_code==order_code)).scalar_one_or_none()
    if not o: raise HTTPException(404, "Order not found")
    p = models.Payment(order_id=o.id, amount=amount, method=method)
    db.add(p); db.commit()
    total, paid, balance, _ = totals_for_order(db, o)
    return {"payment_id": p.id, "total": total, "paid": paid, "balance": balance}

@app.post("/catalog/product")
async def create_product(payload: dict, db: Session = Depends(get_db)):
    sku = payload["sku"]; name = payload["name"]; price = float(payload.get("default_price",0))
    if db.get(models.Product, sku): raise HTTPException(409, "SKU exists")
    db.add(models.Product(sku=sku, name=name, default_price=price)); db.commit(); return {"ok": True}

@app.post("/catalog/alias")
async def create_alias(payload: dict, db: Session = Depends(get_db)):
    alias = payload["alias"]; sku = payload["sku"]
    if not db.get(models.Product, sku): raise HTTPException(404, "SKU not found")
    db.add(models.ProductAlias(alias=alias, sku=sku)); db.commit(); return {"ok": True}

@app.get("/suggest/items")
async def suggest_items(q: str, db: Session = Depends(get_db)):
    like = f"%{q}%"
    prods = db.execute(select(models.Product).where(models.Product.name.ilike(like))).scalars().all()
    aliases = db.execute(select(models.ProductAlias).where(models.ProductAlias.alias.ilike(like))).scalars().all()
    out = []
    for p in prods:
        out.append({"sku": p.sku, "name": p.name, "default_price": float(p.default_price or 0)})
    for a in aliases:
        prod = db.get(models.Product, a.sku)
        out.append({"sku": a.sku, "name": a.alias, "default_price": float((prod.default_price if prod else 0) or 0)})
    return out[:20]

@app.get("/export/excel")
async def export_excel(db: Session = Depends(get_db)):
    q = db.execute(
        select(models.Order.order_code, models.Order.type, models.Order.status)
    ).all()
    rows = []
    for (code, typ, status) in q:
        o = db.execute(select(models.Order).where(models.Order.order_code==code)).scalar_one()
        total, paid, balance, _ = totals_for_order(db, o)
        c = db.execute(select(models.Customer).where(models.Customer.id==o.customer_id)).scalar_one()
        rows.append({"order_code": code, "type": typ, "status": status, "customer": c.name, "phone": c.phone, "total": total, "paid": paid, "balance": balance})
    x = orders_to_excel(rows)
    return Response(content=x, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers={"Content-Disposition": "attachment; filename=orders.xlsx"})
