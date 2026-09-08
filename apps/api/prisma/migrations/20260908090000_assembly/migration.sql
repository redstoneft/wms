-- Assembly orders: components consumed (ASSEMBLY_OUT) and finished product produced onto new pallets (ASSEMBLY_IN).

CREATE TABLE assembly_orders (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  code                varchar(30) NOT NULL UNIQUE,
  warehouse_id        uuid NOT NULL REFERENCES warehouses(id),
  station_location_id uuid NOT NULL REFERENCES locations(id),
  output_sku_id       uuid NOT NULL REFERENCES skus(id),
  output_qty          bigint NOT NULL CHECK (output_qty > 0),
  consumed_qty        bigint NOT NULL CHECK (consumed_qty > 0),
  scrap_qty           bigint NOT NULL DEFAULT 0 CHECK (scrap_qty >= 0),
  scrap_reason        text,
  incident_id         uuid,
  notes               text,
  status              varchar(20) NOT NULL DEFAULT 'COMPLETED',
  created_by          uuid NOT NULL,
  created_at          timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX assembly_orders_created_at_idx ON assembly_orders(created_at);
CREATE INDEX assembly_orders_output_sku_id_idx ON assembly_orders(output_sku_id);

CREATE TABLE assembly_inputs (
  id       uuid PRIMARY KEY DEFAULT uuidv7(),
  order_id uuid NOT NULL REFERENCES assembly_orders(id) ON DELETE CASCADE,
  lpn_id   uuid NOT NULL REFERENCES lpns(id),
  sku_id   uuid NOT NULL REFERENCES skus(id),
  qty      bigint NOT NULL CHECK (qty > 0)
);
CREATE INDEX assembly_inputs_order_id_idx ON assembly_inputs(order_id);
CREATE INDEX assembly_inputs_lpn_id_idx ON assembly_inputs(lpn_id);

CREATE TABLE assembly_outputs (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  order_id        uuid NOT NULL REFERENCES assembly_orders(id) ON DELETE CASCADE,
  lpn_id          uuid NOT NULL REFERENCES lpns(id),
  cases           integer NOT NULL CHECK (cases > 0),
  pieces_per_case integer NOT NULL CHECK (pieces_per_case > 0),
  qty             bigint NOT NULL CHECK (qty > 0),
  putaway_task_id uuid
);
CREATE INDEX assembly_outputs_order_id_idx ON assembly_outputs(order_id);
CREATE INDEX assembly_outputs_lpn_id_idx ON assembly_outputs(lpn_id);

CREATE SEQUENCE IF NOT EXISTS assembly_seq START 1 NO CYCLE;

-- new movement types
ALTER TABLE inventory_movements DROP CONSTRAINT ck_mov_type;
ALTER TABLE inventory_movements ADD CONSTRAINT ck_mov_type CHECK (movement_type IN
    ('RECEIPT','PUTAWAY','TRANSFER_START','TRANSFER_COMPLETE','TRANSFER_CANCEL','REPLENISH_START','REPLENISH_COMPLETE',
     'ALLOCATE','DEALLOCATE','PICK','UNPICK','STAGE','LOAD','UNLOAD','SHIP','ADJUST_IN','ADJUST_OUT',
     'COUNT_ADJUST_IN','COUNT_ADJUST_OUT','QUARANTINE_IN','QUARANTINE_OUT','DAMAGE','DAMAGE_RELEASE','BLOCK','UNBLOCK',
     'RETURN_RECEIPT','SCRAP','LPN_SPLIT','LPN_CONSOLIDATE','INITIAL_LOAD','ASSEMBLY_OUT','ASSEMBLY_IN'));

-- ASSEMBLY_IN has only a TO side, ASSEMBLY_OUT only a FROM side (same shape as receipt / scrap)
CREATE OR REPLACE FUNCTION wms_validate_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inbound  boolean := NEW.movement_type IN ('RECEIPT','ADJUST_IN','COUNT_ADJUST_IN','RETURN_RECEIPT','INITIAL_LOAD','ASSEMBLY_IN');
  outbound boolean := NEW.movement_type IN ('SHIP','ADJUST_OUT','COUNT_ADJUST_OUT','SCRAP','ASSEMBLY_OUT');
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
