-- =====================================================================
-- Hardening (external audit A10 / A11 / A34)
--  * inventory_balances may ONLY be written by the ledger trigger
--  * lpns.current_location_id may ONLY change through the ledger trigger
--  * a movement's FROM location must match the LPN's real location
--  * transfers remember the status they started from (QUARANTINE/BLOCKED/... are movable)
-- =====================================================================

CREATE OR REPLACE FUNCTION wms_balances_only_via_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'inventory_balances is derived from the ledger: write a movement instead (% blocked)', TG_OP USING ERRCODE = 'P0005';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_balances_only_via_ledger
  BEFORE INSERT OR UPDATE OR DELETE ON inventory_balances
  FOR EACH ROW EXECUTE FUNCTION wms_balances_only_via_ledger();

CREATE OR REPLACE FUNCTION wms_lpn_location_only_via_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_location_id IS DISTINCT FROM OLD.current_location_id AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'lpns.current_location_id can only change through an inventory movement' USING ERRCODE = 'P0005';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_lpn_location_only_via_ledger
  BEFORE UPDATE OF current_location_id ON lpns
  FOR EACH ROW EXECUTE FUNCTION wms_lpn_location_only_via_ledger();

-- FROM side must reflect where the LPN really is (traceability of the ledger)
CREATE OR REPLACE FUNCTION wms_validate_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inbound  boolean := NEW.movement_type IN ('RECEIPT','ADJUST_IN','COUNT_ADJUST_IN','RETURN_RECEIPT','INITIAL_LOAD');
  outbound boolean := NEW.movement_type IN ('SHIP','ADJUST_OUT','COUNT_ADJUST_OUT','SCRAP');
  v_lpn_status text;
  v_from_loc uuid;
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
  IF NEW.from_lpn_id IS NOT NULL THEN
    SELECT current_location_id INTO v_from_loc FROM lpns WHERE id = NEW.from_lpn_id;
    IF NEW.from_location_id IS DISTINCT FROM v_from_loc THEN
      RAISE EXCEPTION 'INVALID_MOVEMENT: from_location does not match the LPN location (lpn=% at % , movement says %)',
        NEW.from_lpn_id, v_from_loc, NEW.from_location_id USING ERRCODE='P0003';
    END IF;
  END IF;
  IF NEW.to_lpn_id IS NOT NULL THEN
    SELECT status INTO v_lpn_status FROM lpns WHERE id = NEW.to_lpn_id;
    IF v_lpn_status IN ('SHIPPED','CANCELLED') THEN
      RAISE EXCEPTION 'LPN_FROZEN: cannot add inventory to LPN in status %', v_lpn_status USING ERRCODE='P0004';
    END IF;
  END IF;
  IF NEW.occurred_at IS NULL THEN NEW.occurred_at := now(); END IF;
  RETURN NEW;
END $$;

ALTER TABLE transfers ADD COLUMN origin_status VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE';
ALTER TABLE transfers ADD CONSTRAINT ck_transfer_origin_status CHECK (origin_status IN ('AVAILABLE','QUARANTINE','BLOCKED','DAMAGED'));
