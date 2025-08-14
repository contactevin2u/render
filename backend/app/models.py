from sqlalchemy.orm import declarative_base, Mapped, mapped_column, relationship
from sqlalchemy import String, Integer, Text, DateTime, ForeignKey, Numeric, UniqueConstraint
from datetime import datetime

Base = declarative_base()

class Customer(Base):
    __tablename__ = "customers2"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(50), index=True)
    address: Mapped[str | None] = mapped_column(Text)

class Order(Base):
    __tablename__ = "orders2"
    id: Mapped[int] = mapped_column(primary_key=True)
    order_code: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("customers2.id"), index=True)
    type: Mapped[str] = mapped_column(String(20))  # RENTAL | INSTALMENT | OUTRIGHT
    status: Mapped[str] = mapped_column(String(20), default="CONFIRMED")  # DRAFT | CONFIRMED | RETURNED | CANCELLED
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    notes: Mapped[str | None] = mapped_column(Text)

class OrderItem(Base):
    __tablename__ = "order_items2"
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders2.id"), index=True)
    sku: Mapped[str] = mapped_column(String(120), default="")
    name: Mapped[str] = mapped_column(String(255))
    qty: Mapped[int] = mapped_column(Integer)
    unit_price: Mapped[float] = mapped_column(Numeric(12,2))

class Payment(Base):
    __tablename__ = "payments2"
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders2.id"), index=True)
    amount: Mapped[float] = mapped_column(Numeric(12,2))
    method: Mapped[str] = mapped_column(String(50))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

class Event(Base):
    __tablename__ = "events2"
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int | None] = mapped_column(ForeignKey("orders2.id"), index=True)
    type: Mapped[str] = mapped_column(String(40))  # RETURN | COLLECT | INSTALMENT_CANCEL | BUYBACK
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

class Message(Base):
    __tablename__ = "messages2"
    id: Mapped[int] = mapped_column(primary_key=True)
    sha256: Mapped[str] = mapped_column(String(64))
    raw: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    __table_args__ = (UniqueConstraint("sha256", name="uq_messages2_sha"),)

class Product(Base):
    __tablename__ = "products2"
    sku: Mapped[str] = mapped_column(String(120), primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    default_price: Mapped[float] = mapped_column(Numeric(12,2), default=0)

class ProductAlias(Base):
    __tablename__ = "product_aliases2"
    id: Mapped[int] = mapped_column(primary_key=True)
    alias: Mapped[str] = mapped_column(String(255), index=True)
    sku: Mapped[str] = mapped_column(ForeignKey("products2.sku"), index=True)

class CompanyProfile(Base):
    __tablename__ = "company_profile"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_name: Mapped[str] = mapped_column(String(255))
    registration_no: Mapped[str | None] = mapped_column(String(100))
    address: Mapped[str | None] = mapped_column(Text)
    phone: Mapped[str | None] = mapped_column(String(100))
    email: Mapped[str | None] = mapped_column(String(200))
    logo_url: Mapped[str | None] = mapped_column(Text)
    bank_name: Mapped[str | None] = mapped_column(String(120))
    bank_account_name: Mapped[str | None] = mapped_column(String(160))
    bank_account_no: Mapped[str | None] = mapped_column(String(80))
    footer_note: Mapped[str | None] = mapped_column(Text)
    tax_label: Mapped[str | None] = mapped_column(String(50))
    tax_percent: Mapped[float | None] = mapped_column(Numeric(5,2))
