-- =====================================================================
-- WMS integrity layer. Everything here protects inventory at the DB level,
-- independently of application code:
--   * append-only ledger + audit log
--   * balances maintained ONLY by trigger from the ledger, CHECK qty >= 0
--   * one physical location per LPN (location lives on the LPN row)
--   * status/enum CHECK constraints
--   * never-reused document sequences (LPN, receipts, shipments, ...)
--   * uniqueness of "one active task per entity" via partial unique indexes
--   * reconciliation function that rebuilds balances from the ledger
-- =====================================================================

-- ---------- enum-like CHECK constraints ----------
ALTER TABLE inventory_balances
  ADD CONSTRAINT ck_balance_qty_nonneg CHECK (qty >= 0),
  ADD CONSTRAINT ck_balance_status CHECK (status IN
    ('AVAILABLE','ALLOCATED','PICKING','STAGING','LOADED','QUARANTINE','DAMAGED','BLOCKED','IN_TRANSFER'));

ALTER TABLE inventory_movements
  ADD CONSTRAINT ck_mov_qty_pos CHECK (qty > 0),
  ADD CONSTRAINT ck_mov_sides CHECK (from_lpn_id IS NOT NULL OR to_lpn_id IS NOT NULL),
  ADD CONSTRAINT ck_mov_from_status CHECK (from_lpn_id IS NULL OR from_status IS NOT NULL),
  ADD CONSTRAINT ck_mov_to_status CHECK (to_lpn_id IS NULL OR to_status IS NOT NULL),
  ADD CONSTRAINT ck_mov_type CHECK (movement_type IN
    ('RECEIPT','PUTAWAY','TRANSFER_START','TRANSFER_COMPLETE','TRANSFER_CANCEL','REPLENISH_START','REPLENISH_COMPLETE',
     'ALLOCATE','DEALLOCATE','PICK','UNPICK','STAGE','LOAD','UNLOAD','SHIP','ADJUST_IN','ADJUST_OUT',
     'COUNT_ADJUST_IN','COUNT_ADJUST_OUT','QUARANTINE_IN','QUARANTINE_OUT','DAMAGE','DAMAGE_RELEASE','BLOCK','UNBLOCK',
     'RETURN_RECEIPT','SCRAP','LPN_SPLIT','LPN_CONSOLIDATE','INITIAL_LOAD'));

ALTER TABLE lpns
  ADD CONSTRAINT ck_lpn_code_format CHECK (code ~ '^PLT-[0-9]{4}-[0-9]{8}$'),
  ADD CONSTRAINT ck_lpn_status CHECK (status IN
    ('OPEN','STORED','IN_TRANSFER','PICKING','STAGED','LOADED','SHIPPED','CONSUMED','CANCELLED')),
  ADD CONSTRAINT ck_lpn_type CHECK (lpn_type IN ('INBOUND','STORAGE','OUTBOUND','RETURN'));

ALTER TABLE sku_uoms
  ADD CONSTRAINT ck_uom_base_pos CHECK (base_qty > 0),
  ADD CONSTRAINT ck_uom_code CHECK (uom_code IN ('PALLET','CASE','INNER','PIECE')),
  ADD CONSTRAINT ck_uom_piece_is_one CHECK (uom_code <> 'PIECE' OR base_qty = 1);

ALTER TABLE order_lines
  ADD CONSTRAINT ck_ol_required_pos CHECK (required_qty > 0),
  ADD CONSTRAINT ck_ol_nonneg CHECK (allocated_qty >= 0 AND picked_qty >= 0 AND verified_qty >= 0 AND loaded_qty >= 0),
  ADD CONSTRAINT ck_ol_alloc_le_required CHECK (allocated_qty <= required_qty),
  ADD CONSTRAINT ck_ol_picked_le_required CHECK (picked_qty <= required_qty),
  ADD CONSTRAINT ck_ol_verified_le_picked CHECK (verified_qty <= picked_qty),
  ADD CONSTRAINT ck_ol_loaded_le_verified CHECK (loaded_qty <= verified_qty);

ALTER TABLE allocations
  ADD CONSTRAINT ck_alloc_qty_pos CHECK (qty > 0),
  ADD CONSTRAINT ck_alloc_picked CHECK (picked_qty >= 0 AND picked_qty <= qty);

ALTER TABLE pick_task_lines
  ADD CONSTRAINT ck_ptl_qty CHECK (qty > 0 AND picked_qty >= 0 AND picked_qty <= qty);

ALTER TABLE receipt_lines
  ADD CONSTRAINT ck_rl_nonneg CHECK (expected_qty >= 0 AND received_qty >= 0 AND damaged_qty >= 0);

ALTER TABLE locations
  ADD CONSTRAINT ck_loc_type CHECK (location_type IN
    ('RESERVE','PICKING','RECEIVING','STAGING','SHIPPING','QUARANTINE','RETURNS','DAMAGED')),
  ADD CONSTRAINT ck_loc_admin_status CHECK (admin_status IN ('ACTIVE','BLOCKED','QUARANTINE')),
  ADD CONSTRAINT ck_loc_capacity CHECK (pallet_capacity >= 1 AND max_weight_kg > 0);

ALTER TABLE containers
  ADD CONSTRAINT ck_container_status CHECK (status IN
    ('SCHEDULED','ARRIVED','UNLOADING','UNLOADED','RECEIVING','RECEIVED','CLOSED','WITH_INCIDENT'));

ALTER TABLE orders
  ADD CONSTRAINT ck_order_status CHECK (status IN
    ('IMPORTED','ACCEPTED','PARTIALLY_ALLOCATED','ALLOCATED','PICKING','PICKED','STAGED','VERIFIED','LOADING','LOADED','SHIPPED','CANCELLED')),
  ADD CONSTRAINT ck_order_priority CHECK (priority BETWEEN 1 AND 9);

ALTER TABLE shipments
  ADD CONSTRAINT ck_shipment_status CHECK (status IN
    ('OPEN','LOADING','LOADED','RELEASED','DEPARTED','CANCELLED','BLOCKED'));

ALTER TABLE incidents
  ADD CONSTRAINT ck_incident_type CHECK (incident_type IN
    ('SHORTAGE','OVERAGE','WRONG_SKU','DAMAGED','INVENTORY_DIFFERENCE','WRONG_LOCATION','LABEL_ERROR','LOST_PALLET','PICKING_ERROR','LOADING_ERROR','OTHER')),
  ADD CONSTRAINT ck_incident_severity CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  ADD CONSTRAINT ck_incident_status CHECK (status IN ('OPEN','IN_REVIEW','RESOLVED','CLOSED','REJECTED'));

ALTER TABLE replenishment_rules
  ADD CONSTRAINT ck_replen_minmax CHECK (min_qty >= 0 AND max_qty > min_qty);

ALTER TABLE count_lines
  ADD CONSTRAINT ck_count_nonneg CHECK (system_qty >= 0 AND (counted_qty IS NULL OR counted_qty >= 0)
    AND (recount_qty IS NULL OR recount_qty >= 0) AND (final_qty IS NULL OR final_qty >= 0));

-- ---------- append-only tables ----------
CREATE OR REPLACE FUNCTION wms_forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER trg_movements_append_only
  BEFORE UPDATE OR DELETE ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION wms_forbid_change();

CREATE TRIGGER trg_audit_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION wms_forbid_change();

-- TRUNCATE protection (statement-level)
CREATE OR REPLACE FUNCTION wms_forbid_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: TRUNCATE not allowed', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER trg_movements_no_truncate BEFORE TRUNCATE ON inventory_movements EXECUTE FUNCTION wms_forbid_truncate();
CREATE TRIGGER trg_audit_no_truncate BEFORE TRUNCATE ON audit_logs EXECUTE FUNCTION wms_forbid_truncate();

-- LPNs are never deleted (codes are never reused)
CREATE TRIGGER trg_lpns_no_delete BEFORE DELETE ON lpns FOR EACH ROW EXECUTE FUNCTION wms_forbid_change();

-- ---------- balances are derived ONLY from the ledger ----------
-- The application never writes inventory_balances directly. Every INSERT into
-- inventory_movements applies the deltas; CHECK (qty >= 0) aborts the whole
-- transaction if inventory would go negative, and the UNIQUE index makes
-- concurrent updates serialize on the same row.
CREATE OR REPLACE FUNCTION wms_apply_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_rows int;
  v_from_loc uuid;
  v_to_loc uuid;
BEGIN
  -- FROM side: subtract
  IF NEW.from_lpn_id IS NOT NULL THEN
    UPDATE inventory_balances
       SET qty = qty - NEW.qty, version = version + 1, updated_at = now()
     WHERE lpn_id = NEW.from_lpn_id AND sku_id = NEW.sku_id AND status = NEW.from_status;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
      RAISE EXCEPTION 'INSUFFICIENT_INVENTORY: no balance for lpn=% sku=% status=%',
        NEW.from_lpn_id, NEW.sku_id, NEW.from_status USING ERRCODE = 'P0002';
    END IF;
    DELETE FROM inventory_balances
     WHERE lpn_id = NEW.from_lpn_id AND sku_id = NEW.sku_id AND status = NEW.from_status AND qty = 0;
  END IF;

  -- TO side: add
  IF NEW.to_lpn_id IS NOT NULL THEN
    INSERT INTO inventory_balances (id, lpn_id, sku_id, status, qty, version, updated_at)
    VALUES (uuidv7(), NEW.to_lpn_id, NEW.sku_id, NEW.to_status, NEW.qty, 1, now())
    ON CONFLICT (lpn_id, sku_id, status)
    DO UPDATE SET qty = inventory_balances.qty + EXCLUDED.qty,
                  version = inventory_balances.version + 1,
                  updated_at = now();
  END IF;

  -- LPN physical location follows the movement
  IF NEW.to_lpn_id IS NOT NULL AND NEW.to_location_id IS NOT NULL THEN
    UPDATE lpns SET current_location_id = NEW.to_location_id, version = version + 1, updated_at = now()
     WHERE id = NEW.to_lpn_id AND current_location_id IS DISTINCT FROM NEW.to_location_id;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_apply_movement
  AFTER INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION wms_apply_movement();

-- Validate the shape of a movement before it is applied.
CREATE OR REPLACE FUNCTION wms_validate_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  inbound  boolean := NEW.movement_type IN ('RECEIPT','ADJUST_IN','COUNT_ADJUST_IN','RETURN_RECEIPT','INITIAL_LOAD');
  outbound boolean := NEW.movement_type IN ('SHIP','ADJUST_OUT','COUNT_ADJUST_OUT','SCRAP');
  v_lpn_status text;
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
  -- shipped/cancelled LPNs are frozen forever
  IF NEW.to_lpn_id IS NOT NULL THEN
    SELECT status INTO v_lpn_status FROM lpns WHERE id = NEW.to_lpn_id;
    IF v_lpn_status IN ('SHIPPED','CANCELLED') THEN
      RAISE EXCEPTION 'LPN_FROZEN: cannot add inventory to LPN in status %', v_lpn_status USING ERRCODE='P0004';
    END IF;
  END IF;
  IF NEW.occurred_at IS NULL THEN NEW.occurred_at := now(); END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_validate_movement
  BEFORE INSERT ON inventory_movements
  FOR EACH ROW EXECUTE FUNCTION wms_validate_movement();

-- Idempotent inserts at the ledger level too (belt and braces)
CREATE UNIQUE INDEX ux_movements_idempotency ON inventory_movements (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ---------- never-reused document numbers ----------
CREATE SEQUENCE IF NOT EXISTS lpn_seq START 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS receipt_seq START 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS shipment_seq START 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS incident_seq START 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS return_seq START 1 NO CYCLE;
CREATE SEQUENCE IF NOT EXISTS order_seq START 1 NO CYCLE;

CREATE OR REPLACE FUNCTION next_lpn_code() RETURNS text LANGUAGE sql AS $$
  SELECT 'PLT-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('lpn_seq')::text, 8, '0');
$$;
CREATE OR REPLACE FUNCTION next_doc_number(p_prefix text, p_seq text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  EXECUTE format('SELECT nextval(%L)', p_seq) INTO v;
  RETURN p_prefix || '-' || to_char(now(), 'YYYY') || '-' || lpad(v::text, 6, '0');
END $$;

-- ---------- one active thing per entity ----------
CREATE UNIQUE INDEX ux_authorizations_once
  ON authorizations (exception_type, entity_type, entity_id) WHERE status = 'APPROVED';
CREATE UNIQUE INDEX ux_transfers_one_active_per_lpn ON transfers (lpn_id) WHERE status = 'IN_TRANSIT';
CREATE UNIQUE INDEX ux_putaway_one_active_per_lpn ON putaway_tasks (lpn_id) WHERE status IN ('PENDING','ASSIGNED','IN_PROGRESS');
CREATE UNIQUE INDEX ux_staging_one_active_per_order ON staging_assignments (order_id) WHERE released_at IS NULL;
CREATE UNIQUE INDEX ux_pick_task_one_active_per_order ON pick_tasks (order_id) WHERE status IN ('PENDING','IN_PROGRESS');
CREATE UNIQUE INDEX ux_verification_one_active_per_order ON verifications (order_id) WHERE status = 'IN_PROGRESS';
CREATE UNIQUE INDEX ux_replen_one_active_per_rule ON replenishment_tasks (rule_id) WHERE status IN ('PENDING','IN_PROGRESS');
CREATE UNIQUE INDEX ux_import_jobs_applied_once ON import_jobs (import_type, file_sha256) WHERE status = 'APPLIED';

-- ---------- reconciliation ----------
-- Rebuilds balances from the ledger and returns every discrepancy.
CREATE OR REPLACE FUNCTION inventory_reconcile()
RETURNS TABLE (lpn_id uuid, sku_id uuid, status text, ledger_qty bigint, balance_qty bigint) LANGUAGE sql STABLE AS $$
  WITH ledger AS (
    SELECT l.lpn_id, l.sku_id, l.status, sum(l.delta)::bigint AS qty FROM (
      SELECT m.from_lpn_id AS lpn_id, m.sku_id, m.from_status AS status, -m.qty AS delta
        FROM inventory_movements m WHERE m.from_lpn_id IS NOT NULL
      UNION ALL
      SELECT m.to_lpn_id, m.sku_id, m.to_status, m.qty
        FROM inventory_movements m WHERE m.to_lpn_id IS NOT NULL
    ) l GROUP BY l.lpn_id, l.sku_id, l.status
  )
  SELECT COALESCE(a.lpn_id, b.lpn_id), COALESCE(a.sku_id, b.sku_id), COALESCE(a.status, b.status)::text,
         COALESCE(a.qty, 0), COALESCE(b.qty, 0)
    FROM ledger a
    FULL OUTER JOIN inventory_balances b ON b.lpn_id = a.lpn_id AND b.sku_id = a.sku_id AND b.status = a.status
   WHERE COALESCE(a.qty, 0) <> COALESCE(b.qty, 0);
$$;

-- LPN location according to the ledger vs. the LPN row.
CREATE OR REPLACE FUNCTION lpn_location_reconcile()
RETURNS TABLE (lpn_id uuid, ledger_location_id uuid, lpn_location_id uuid) LANGUAGE sql STABLE AS $$
  WITH last_loc AS (
    SELECT DISTINCT ON (m.to_lpn_id) m.to_lpn_id AS lpn_id, m.to_location_id
      FROM inventory_movements m
     WHERE m.to_lpn_id IS NOT NULL AND m.to_location_id IS NOT NULL
     ORDER BY m.to_lpn_id, m.id DESC
  )
  SELECT l.id, ll.to_location_id, l.current_location_id
    FROM lpns l JOIN last_loc ll ON ll.lpn_id = l.id
   WHERE ll.to_location_id IS DISTINCT FROM l.current_location_id;
$$;

-- ---------- reporting views ----------
CREATE OR REPLACE VIEW v_lpn_contents AS
  SELECT b.lpn_id, l.code AS lpn_code, l.status AS lpn_status, l.current_location_id,
         b.sku_id, s.code AS sku_code, s.description AS sku_description, b.status, b.qty,
         (b.qty * s.unit_weight_kg) AS weight_kg
    FROM inventory_balances b
    JOIN lpns l ON l.id = b.lpn_id
    JOIN skus s ON s.id = b.sku_id
   WHERE b.qty > 0;

CREATE OR REPLACE VIEW v_location_occupancy AS
  SELECT loc.id AS location_id, loc.code, loc.barcode, loc.location_type, loc.admin_status, loc.pallet_capacity,
         loc.max_weight_kg, loc.zone_id, loc.rack_id, loc.warehouse_id,
         COALESCE(occ.lpn_count, 0)::int AS lpn_count,
         COALESCE(occ.total_qty, 0)::bigint AS total_qty,
         COALESCE(occ.weight_kg, 0)::numeric AS weight_kg,
         COALESCE(res.reserved_count, 0)::int AS reserved_count,
         CASE
           WHEN loc.admin_status = 'BLOCKED' THEN 'BLOCKED'
           WHEN loc.admin_status = 'QUARANTINE' THEN 'QUARANTINE'
           WHEN COALESCE(occ.lpn_count, 0) = 0 AND COALESCE(res.reserved_count, 0) > 0 THEN 'RESERVED'
           WHEN COALESCE(occ.lpn_count, 0) = 0 THEN 'FREE'
           WHEN COALESCE(occ.lpn_count, 0) + COALESCE(res.reserved_count, 0) >= loc.pallet_capacity THEN 'OCCUPIED'
           ELSE 'PARTIAL'
         END AS status
    FROM locations loc
    LEFT JOIN (
      SELECT l.current_location_id AS location_id, count(DISTINCT l.id) AS lpn_count,
             sum(b.qty) AS total_qty, sum(b.qty * s.unit_weight_kg) AS weight_kg
        FROM lpns l
        JOIN inventory_balances b ON b.lpn_id = l.id AND b.qty > 0
        JOIN skus s ON s.id = b.sku_id
       WHERE l.current_location_id IS NOT NULL
       GROUP BY l.current_location_id
    ) occ ON occ.location_id = loc.id
    LEFT JOIN (
      SELECT x.location_id, count(*) AS reserved_count FROM (
        SELECT suggested_location_id AS location_id FROM putaway_tasks WHERE status IN ('PENDING','ASSIGNED','IN_PROGRESS') AND suggested_location_id IS NOT NULL
        UNION ALL
        SELECT to_location_id FROM transfers WHERE status = 'IN_TRANSIT'
      ) x GROUP BY x.location_id
    ) res ON res.location_id = loc.id;

CREATE OR REPLACE VIEW v_sku_inventory AS
  SELECT s.id AS sku_id, s.code AS sku_code, s.description, b.status, sum(b.qty)::bigint AS qty,
         count(DISTINCT b.lpn_id)::int AS lpn_count
    FROM skus s JOIN inventory_balances b ON b.sku_id = s.id AND b.qty > 0
   GROUP BY s.id, s.code, s.description, b.status;

-- ---------- seed static sequences metadata ----------
INSERT INTO sequences_meta (name, prefix, description) VALUES
  ('lpn_seq', 'PLT', 'License plate numbers, never reused'),
  ('receipt_seq', 'RCV', 'Receipts'),
  ('shipment_seq', 'SHP', 'Shipments'),
  ('incident_seq', 'INC', 'Incidents'),
  ('return_seq', 'RET', 'Returns'),
  ('order_seq', 'ORD', 'Manual orders');
