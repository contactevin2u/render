CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS citext;

-- USERS
CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         citext UNIQUE NOT NULL,
  password_hash text NOT NULL,
  full_name     text NOT NULL,
  role          text NOT NULL CHECK (role IN ('admin','ops','finance','driver')),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- CUSTOMERS
CREATE TABLE IF NOT EXISTS customers (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            text NOT NULL,
  phone_primary   text NOT NULL,
  default_address text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ORDERS (simple for now)
CREATE TABLE IF NOT EXISTS orders (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id   uuid NOT NULL REFERENCES customers(id),
  order_code    text UNIQUE NOT NULL,
  order_type    text NOT NULL CHECK (order_type IN ('outright_purchase','instalment','rent')),
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','confirmed','completed','cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

