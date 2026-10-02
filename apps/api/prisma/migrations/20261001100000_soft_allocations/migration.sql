-- Allocations become a plan, not a reservation: inventory planned for an order stays AVAILABLE (any order or picker may
-- still take it; the plan only says where it is best to pick from). Existing ALLOCATED balances go back to AVAILABLE
-- through the ledger so history stays consistent.
INSERT INTO inventory_movements (movement_type, sku_id, qty, uom_code, uom_qty, from_lpn_id, to_lpn_id, from_location_id, to_location_id, from_status, to_status, occurred_at, reference_type, reference_id, reason, note)
SELECT 'DEALLOCATE', b.sku_id, b.qty, 'PIECE', b.qty, b.lpn_id, b.lpn_id, l.current_location_id, l.current_location_id, 'ALLOCATED', 'AVAILABLE', now(), 'migration', '20261001100000_soft_allocations',
       'Asignaciones como sugerencia', 'La asignacion ya no aparta inventario: el stock planeado vuelve a disponible'
  FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id
 WHERE b.status = 'ALLOCATED' AND b.qty > 0;
