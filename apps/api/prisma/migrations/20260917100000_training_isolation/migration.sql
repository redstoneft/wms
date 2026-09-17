-- Training isolation: everything done in the school warehouse (ESCUELA) is flagged is_training and hidden from the
-- operational screens. The flag is set by BEFORE INSERT triggers from the document's relations, so no service can forget it.
-- Also: purpose ("para qué") of tasks that operators create themselves from the handheld.

ALTER TABLE receipts        ADD COLUMN is_training boolean NOT NULL DEFAULT false;
ALTER TABLE containers      ADD COLUMN is_training boolean NOT NULL DEFAULT false;
ALTER TABLE purchase_orders ADD COLUMN is_training boolean NOT NULL DEFAULT false;
ALTER TABLE orders          ADD COLUMN is_training boolean NOT NULL DEFAULT false;
ALTER TABLE shipments       ADD COLUMN is_training boolean NOT NULL DEFAULT false;
ALTER TABLE returns         ADD COLUMN is_training boolean NOT NULL DEFAULT false;
ALTER TABLE pick_tasks      ADD COLUMN is_training boolean NOT NULL DEFAULT false;
ALTER TABLE putaway_tasks   ADD COLUMN is_training boolean NOT NULL DEFAULT false;
ALTER TABLE transfers       ADD COLUMN is_training boolean NOT NULL DEFAULT false;
ALTER TABLE count_tasks     ADD COLUMN is_training boolean NOT NULL DEFAULT false;
ALTER TABLE incidents       ADD COLUMN is_training boolean NOT NULL DEFAULT false;
ALTER TABLE assembly_orders ADD COLUMN is_training boolean NOT NULL DEFAULT false;
ALTER TABLE pick_tasks      ADD COLUMN purpose text;
ALTER TABLE putaway_tasks   ADD COLUMN purpose text;

CREATE OR REPLACE FUNCTION wms_school_warehouse_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM warehouses WHERE code = 'ESCUELA' LIMIT 1 $$;
CREATE OR REPLACE FUNCTION wms_is_school_location(p uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT l.warehouse_id = wms_school_warehouse_id() FROM locations l WHERE l.id = p), false) $$;
CREATE OR REPLACE FUNCTION wms_is_school_lpn(p uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT l.warehouse_id = wms_school_warehouse_id() FROM lpns l WHERE l.id = p), false) $$;
CREATE OR REPLACE FUNCTION wms_is_school_party(p_table text, p uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE c text;
BEGIN
  IF p IS NULL THEN RETURN false; END IF;
  IF p_table = 'customers' THEN SELECT code INTO c FROM customers WHERE id = p;
  ELSIF p_table = 'suppliers' THEN SELECT code INTO c FROM suppliers WHERE id = p;
  ELSE SELECT code INTO c FROM carriers WHERE id = p; END IF;
  RETURN c LIKE 'CAP-%';
END $$;

CREATE OR REPLACE FUNCTION wms_flag_training() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'receipts' THEN NEW.is_training := wms_is_school_location(NEW.receiving_location_id);
  ELSIF TG_TABLE_NAME = 'containers' THEN NEW.is_training := wms_is_school_party('suppliers', NEW.supplier_id) OR wms_is_school_location(NEW.dock_location_id);
  ELSIF TG_TABLE_NAME = 'purchase_orders' THEN NEW.is_training := wms_is_school_party('suppliers', NEW.supplier_id);
  ELSIF TG_TABLE_NAME = 'orders' THEN NEW.is_training := wms_is_school_party('customers', NEW.customer_id);
  ELSIF TG_TABLE_NAME = 'shipments' THEN NEW.is_training := wms_is_school_party('carriers', NEW.carrier_id) OR wms_is_school_location(NEW.dock_location_id);
  ELSIF TG_TABLE_NAME = 'returns' THEN NEW.is_training := wms_is_school_party('customers', NEW.customer_id);
  ELSIF TG_TABLE_NAME = 'pick_tasks' THEN NEW.is_training := COALESCE((SELECT o.is_training FROM orders o WHERE o.id = NEW.order_id), false);
  ELSIF TG_TABLE_NAME = 'putaway_tasks' THEN NEW.is_training := wms_is_school_lpn(NEW.lpn_id);
  ELSIF TG_TABLE_NAME = 'transfers' THEN NEW.is_training := wms_is_school_lpn(NEW.lpn_id);
  ELSIF TG_TABLE_NAME = 'count_tasks' THEN NEW.is_training := COALESCE((SELECT bool_or(wms_is_school_location(x::uuid)) FROM jsonb_array_elements_text(COALESCE(NEW.scope::jsonb->'location_ids', '[]'::jsonb)) x), false)
       OR COALESCE((SELECT z.warehouse_id = wms_school_warehouse_id() FROM zones z WHERE z.id = NULLIF(NEW.scope::jsonb->>'zone_id', '')::uuid), false);
  ELSIF TG_TABLE_NAME = 'incidents' THEN NEW.is_training := wms_is_school_lpn(NEW.lpn_id) OR wms_is_school_location(NEW.location_id)
       OR COALESCE((SELECT o.is_training FROM orders o WHERE o.id = NEW.order_id), false) OR COALESCE((SELECT r.is_training FROM receipts r WHERE r.id = NEW.receipt_id), false);
  ELSIF TG_TABLE_NAME = 'assembly_orders' THEN NEW.is_training := NEW.warehouse_id = wms_school_warehouse_id();
  END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['receipts','containers','purchase_orders','orders','shipments','returns','pick_tasks','putaway_tasks','transfers','count_tasks','incidents','assembly_orders'] LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_training BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION wms_flag_training()', t, t);
  END LOOP;
END $$;

-- backfill what training already created
UPDATE receipts SET is_training = true WHERE wms_is_school_location(receiving_location_id);
UPDATE containers SET is_training = true WHERE wms_is_school_party('suppliers', supplier_id) OR wms_is_school_location(dock_location_id);
UPDATE purchase_orders SET is_training = true WHERE wms_is_school_party('suppliers', supplier_id);
UPDATE orders SET is_training = true WHERE wms_is_school_party('customers', customer_id);
UPDATE shipments SET is_training = true WHERE wms_is_school_party('carriers', carrier_id) OR wms_is_school_location(dock_location_id);
UPDATE returns SET is_training = true WHERE wms_is_school_party('customers', customer_id);
UPDATE pick_tasks p SET is_training = true FROM orders o WHERE o.id = p.order_id AND o.is_training;
UPDATE putaway_tasks SET is_training = true WHERE wms_is_school_lpn(lpn_id);
UPDATE transfers SET is_training = true WHERE wms_is_school_lpn(lpn_id);
UPDATE count_tasks SET is_training = true WHERE COALESCE((SELECT bool_or(wms_is_school_location(x::uuid)) FROM jsonb_array_elements_text(COALESCE(scope::jsonb->'location_ids', '[]'::jsonb)) x), false);
UPDATE incidents i SET is_training = true WHERE wms_is_school_lpn(i.lpn_id) OR wms_is_school_location(i.location_id)
   OR EXISTS (SELECT 1 FROM orders o WHERE o.id = i.order_id AND o.is_training) OR EXISTS (SELECT 1 FROM receipts r WHERE r.id = i.receipt_id AND r.is_training);
UPDATE assembly_orders SET is_training = true WHERE warehouse_id = wms_school_warehouse_id();
