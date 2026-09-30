-- Put-away reservations become "soft": a destination the engine suggested on its own does not block the slot for anyone
-- else. Only a destination a person chose (planned) or a pallet already on its way (IN_PROGRESS) reserves the slot.
ALTER TABLE putaway_tasks ADD COLUMN planned boolean NOT NULL DEFAULT false;

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
        SELECT suggested_location_id AS location_id FROM putaway_tasks
         WHERE suggested_location_id IS NOT NULL AND (status = 'IN_PROGRESS' OR (planned AND status IN ('PENDING','ASSIGNED')))
        UNION ALL
        SELECT to_location_id FROM transfers WHERE status = 'IN_TRANSIT'
      ) x GROUP BY x.location_id
    ) res ON res.location_id = loc.id;
