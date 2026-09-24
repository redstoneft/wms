-- Assembly in two phases: "surtir para armar" opens the order (inputs moved to the station and blocked), the crew
-- confirms later with the pallets produced and the defective pieces. An open order has no output yet.
ALTER TABLE assembly_orders DROP CONSTRAINT IF EXISTS assembly_orders_output_qty_check;
ALTER TABLE assembly_orders ADD CONSTRAINT assembly_orders_output_qty_check CHECK (output_qty >= 0);
ALTER TABLE assembly_orders
  ADD COLUMN IF NOT EXISTS started_at   timestamptz(6),
  ADD COLUMN IF NOT EXISTS completed_at timestamptz(6),
  ADD COLUMN IF NOT EXISTS completed_by uuid;
UPDATE assembly_orders SET completed_at = created_at, completed_by = created_by WHERE status = 'COMPLETED' AND completed_at IS NULL;
CREATE INDEX IF NOT EXISTS assembly_orders_status_idx ON assembly_orders(status);
