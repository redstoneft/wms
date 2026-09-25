-- Outbound pallets the way the floor works: several pallets per order (closed one by one while picking), each with an
-- optional delivery destination (CEDIS/store) printed on its label; assemblies can produce straight for an order.
ALTER TABLE lpns ADD COLUMN destination varchar(120);
ALTER TABLE assembly_orders ADD COLUMN for_order_id uuid REFERENCES orders(id);
CREATE INDEX assembly_orders_for_order_id_idx ON assembly_orders(for_order_id);
