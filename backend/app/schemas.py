from pydantic import BaseModel, Field
from typing import List, Optional, Literal

class ItemIn(BaseModel):
    name: str
    qty: int = 1
    unit_price: float | None = None
    sku: str | None = None

class ParsedOrder(BaseModel):
    order_id: Optional[str] = None
    name: str
    phone: Optional[str] = None
    address: Optional[str] = None
    type: Literal["RENTAL","INSTALMENT","OUTRIGHT"]
    items: List[ItemIn] = []
    notes: Optional[str] = None

class ParsedEvent(BaseModel):
    type: Literal["RETURN","COLLECT","INSTALMENT_CANCEL","BUYBACK","NONE"] = "NONE"
    reference_order_id: Optional[str] = None

class ParseRequest(BaseModel):
    text: str

class ParseResponse(BaseModel):
    parsed: ParsedOrder
    event: ParsedEvent
    matched_order_code: Optional[str] = None
    duplicate: bool = False

class OrderUpdate(BaseModel):
    status: Optional[str] = None
    notes: Optional[str] = None
    name: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None

class OrderSummary(BaseModel):
    order_code: str
    type: str
    status: str
    customer: str
    phone: Optional[str]
    total: float
    paid: float
    balance: float

class EventIn(BaseModel):
    order_code: str
    type: Literal["RETURN","COLLECT","INSTALMENT_CANCEL","BUYBACK"]
