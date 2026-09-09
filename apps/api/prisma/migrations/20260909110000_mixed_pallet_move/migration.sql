-- Moving a MIXED pallet (several SKUs) records one movement per balance. The first one relocates the LPN, so the
-- FROM-location check rejected the siblings. Siblings recorded in the same transaction (same occurred_at = now())
-- for the same LPN and the same from/to locations are now accepted.
CREATE OR REPLACE FUNCTION wms_validate_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inbound  boolean := NEW.movement_type IN ('RECEIPT','ADJUST_IN','COUNT_ADJUST_IN','RETURN_RECEIPT','INITIAL_LOAD','ASSEMBLY_IN');
  outbound boolean := NEW.movement_type IN ('SHIP','ADJUST_OUT','COUNT_ADJUST_OUT','SCRAP','ASSEMBLY_OUT');
  v_lpn_status text;
  v_from_loc uuid;
  v_sibling boolean;
BEGIN
  IF inbound AND (NEW.from_lpn_id IS NOT NULL OR NEW.to_lpn_id IS NULL) THEN
    RAISE EXCEPTION 'INVALID_MOVEMENT: % must have only a TO side', NEW.movement_type USING ERRCODE='P0003';
  END IF;
  IF outbound AND (NEW.to_lpn_id IS NOT NULL OR NEW.from_lpn_id IS NULL) THEN
    RAISE EXCEPTION 'INVALID_MOVEMENT: % must have only a FROM side', NEW.movement_type USING ERRCODE='P0003';
  END IF;
  IF NOT inbound AND NOT outbound AND (NEW.from_lpn_id IS NULL OR NEW.to_lpn_id IS NULL) THEN
    RAISE EXCEPTION 'INVALID_MOVEMENT: % must have FROM and TO sides', NEW.movement_type USING ERRCODE='P0003';
  END IF;
  IF NEW.from_lpn_id IS NOT NULL AND NEW.to_lpn_id IS NOT NULL AND NEW.from_lpn_id = NEW.to_lpn_id
     AND NEW.from_status = NEW.to_status
     AND NEW.from_location_id IS NOT DISTINCT FROM NEW.to_location_id THEN
    RAISE EXCEPTION 'INVALID_MOVEMENT: no-op movement (same lpn, status and location)' USING ERRCODE='P0003';
  END IF;
  IF NEW.occurred_at IS NULL THEN NEW.occurred_at := now(); END IF;
  IF NEW.from_lpn_id IS NOT NULL THEN
    SELECT current_location_id INTO v_from_loc FROM lpns WHERE id = NEW.from_lpn_id;
    IF NEW.from_location_id IS DISTINCT FROM v_from_loc THEN
      SELECT EXISTS (
        SELECT 1 FROM inventory_movements m
         WHERE m.from_lpn_id = NEW.from_lpn_id AND m.to_lpn_id IS NOT DISTINCT FROM NEW.to_lpn_id
           AND m.from_location_id IS NOT DISTINCT FROM NEW.from_location_id AND m.to_location_id IS NOT DISTINCT FROM NEW.to_location_id
           AND m.movement_type = NEW.movement_type AND m.occurred_at = NEW.occurred_at
      ) INTO v_sibling;
      IF NOT v_sibling THEN
        RAISE EXCEPTION 'INVALID_MOVEMENT: from_location does not match the LPN location (lpn=% at % , movement says %)',
          NEW.from_lpn_id, v_from_loc, NEW.from_location_id USING ERRCODE='P0003';
      END IF;
    END IF;
  END IF;
  IF NEW.to_lpn_id IS NOT NULL THEN
    SELECT status INTO v_lpn_status FROM lpns WHERE id = NEW.to_lpn_id;
    IF v_lpn_status IN ('SHIPPED','CANCELLED') THEN
      RAISE EXCEPTION 'LPN_FROZEN: cannot add inventory to LPN in status %', v_lpn_status USING ERRCODE='P0004';
    END IF;
  END IF;
  RETURN NEW;
END $$;
