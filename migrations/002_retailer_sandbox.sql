-- The simulated retailer (Kestrel Goods, fictional). These tables stand in for
-- an external system. AFTERCARE reaches them only through the RetailerGateway
-- port, never through the case repository.
CREATE TABLE sim_orders (
  order_id            TEXT PRIMARY KEY,
  customer_ref        TEXT NOT NULL,
  line_id             TEXT NOT NULL,
  product_name        TEXT NOT NULL,
  category            TEXT NOT NULL,
  keywords_json       TEXT NOT NULL,
  price_cents         INTEGER NOT NULL CHECK (price_cents > 0),
  currency            TEXT NOT NULL,
  seller              TEXT NOT NULL,
  ordered_on          TEXT NOT NULL,
  delivered_on        TEXT NOT NULL,
  serial_numbers_json TEXT NOT NULL,
  serial_location     TEXT,
  open_return         TEXT
);

CREATE TABLE sim_carrier_scans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     TEXT NOT NULL REFERENCES sim_orders (order_id),
  carrier      TEXT NOT NULL,
  tracking_ref TEXT NOT NULL,
  delivered_on TEXT NOT NULL
);

CREATE TABLE sim_policies (
  policy_id TEXT NOT NULL,
  version   TEXT NOT NULL,
  body_json TEXT NOT NULL,
  PRIMARY KEY (policy_id, version)
);

CREATE TABLE sim_returns (
  rma_id              TEXT PRIMARY KEY,
  idempotency_key     TEXT NOT NULL UNIQUE,
  customer_ref        TEXT NOT NULL,
  order_id            TEXT NOT NULL,
  line_id             TEXT NOT NULL,
  reason              TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('processing', 'authorized', 'refused')),
  refund_amount_cents INTEGER NOT NULL,
  currency            TEXT NOT NULL,
  return_shipping     TEXT NOT NULL,
  label_url           TEXT,
  refusal_reason      TEXT,
  reads               INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL
);

-- Scripted outcomes for upcoming calls, consumed first in, first out.
CREATE TABLE sim_outcome_queue (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL CHECK (operation IN ('create_return', 'lookup')),
  outcome   TEXT NOT NULL,
  note      TEXT
);

CREATE TABLE sim_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- What the retailer actually received and did. Shown in the Lab only because this is a simulation.
CREATE TABLE sim_request_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  operation   TEXT NOT NULL,
  request_key TEXT,
  outcome     TEXT NOT NULL,
  detail      TEXT
);
