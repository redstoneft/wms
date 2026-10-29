-- The guided training and the school warehouse (ESCUELA) are removed (owner decision 2026-10-29).
-- Production data of the school warehouse was deleted beforehand; here the structures go away.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['receipts','containers','purchase_orders','orders','shipments','returns','pick_tasks','putaway_tasks','transfers','count_tasks','incidents','assembly_orders'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_training ON %I', t, t);
    EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS is_training', t);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS wms_flag_training();
DROP FUNCTION IF EXISTS wms_is_school_party(text, uuid);
DROP FUNCTION IF EXISTS wms_is_school_lpn(uuid);
DROP FUNCTION IF EXISTS wms_is_school_location(uuid);
DROP FUNCTION IF EXISTS wms_school_warehouse_id();
DROP TABLE IF EXISTS training_progress;
ALTER TABLE users DROP COLUMN IF EXISTS training_completed_at, DROP COLUMN IF EXISTS training_completed_by;
DELETE FROM settings WHERE key = 'training_required';
