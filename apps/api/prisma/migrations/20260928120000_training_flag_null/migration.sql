-- The training flag of an assembly order compared the warehouse with the school warehouse; with no school warehouse
-- (fresh database) the comparison is NULL and the insert violated NOT NULL. Same function, null-safe.
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
  ELSIF TG_TABLE_NAME = 'assembly_orders' THEN NEW.is_training := COALESCE(NEW.warehouse_id = wms_school_warehouse_id(), false);
  END IF;
  RETURN NEW;
END $$;
