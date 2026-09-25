-- Delivery calendar: what the whiteboard at the office door shows (customer, date, time, sites), kept from the
-- handheld and displayed full screen on a TV through a read-only board link.
CREATE TABLE delivery_appointments (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  title         varchar(120) NOT NULL,
  customer_id   uuid REFERENCES customers(id),
  order_id      uuid REFERENCES orders(id),
  delivery_date date NOT NULL,
  delivery_time varchar(5),
  notes         text,
  status        varchar(20) NOT NULL DEFAULT 'PLANNED',
  created_by    uuid NOT NULL,
  updated_by    uuid,
  created_at    timestamptz(6) NOT NULL DEFAULT now(),
  updated_at    timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT ck_delivery_status CHECK (status IN ('PLANNED','DONE','CANCELLED'))
);
CREATE INDEX delivery_appointments_date_idx ON delivery_appointments(delivery_date);

-- read-only board links (the TV opens /board?k=<token>)
CREATE TABLE delivery_boards (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  name       varchar(80) NOT NULL,
  token_hash varchar(64) NOT NULL UNIQUE,
  created_by uuid NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  revoked_at timestamptz(6)
);
