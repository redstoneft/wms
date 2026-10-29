import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db.js';

export async function dashboardRoutes(app: FastifyInstance) {
  const db = getDb();
  const perm = app.requirePermission('dashboard.read');

  /** Real-time operational snapshot: one query per widget, all cheap aggregates. */
  app.get('/dashboard', { preHandler: perm }, async () => {
    const [containers, receipts, lpnsNoLocation, putaway, orders, picking, staging, shipments, incidents, counts, occupancy, transfers, replen] = await Promise.all([
      db.$queryRaw<{ status: string; n: bigint }[]>`SELECT status, count(*) AS n FROM containers WHERE status NOT IN ('CLOSED') GROUP BY status`,
      db.$queryRaw<{ status: string; n: bigint }[]>`SELECT status, count(*) AS n FROM receipts WHERE status NOT IN ('CLOSED') GROUP BY status`,
      db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM lpns l WHERE l.status IN ('OPEN','STORED') AND (l.current_location_id IS NULL OR EXISTS (SELECT 1 FROM locations x WHERE x.id = l.current_location_id AND x.location_type = 'RECEIVING'))`,
      db.$queryRaw<{ status: string; n: bigint }[]>`SELECT status, count(*) AS n FROM putaway_tasks WHERE status IN ('PENDING','ASSIGNED','IN_PROGRESS') GROUP BY status`,
      db.$queryRaw<{ status: string; n: bigint }[]>`SELECT status, count(*) AS n FROM orders WHERE status NOT IN ('SHIPPED','CANCELLED') GROUP BY status`,
      db.$queryRaw<{ status: string; n: bigint }[]>`SELECT status, count(*) AS n FROM pick_tasks WHERE status IN ('PENDING','IN_PROGRESS') GROUP BY status`,
      db.$queryRaw<{ total: bigint; used: bigint }[]>`SELECT count(*) AS total, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM staging_assignments sa WHERE sa.location_id = l.id AND sa.released_at IS NULL)) AS used FROM locations l WHERE l.location_type = 'STAGING' AND l.is_active`,
      db.$queryRaw<{ status: string; n: bigint }[]>`SELECT status, count(*) AS n FROM shipments WHERE status NOT IN ('DEPARTED','CANCELLED') GROUP BY status`,
      db.$queryRaw<{ severity: string; n: bigint }[]>`SELECT severity, count(*) AS n FROM incidents WHERE status IN ('OPEN','IN_REVIEW') GROUP BY severity`,
      db.$queryRaw<{ status: string; n: bigint }[]>`SELECT status, count(*) AS n FROM count_tasks WHERE status NOT IN ('CLOSED','APPROVED','REJECTED') GROUP BY status`,
      db.$queryRaw<{ total: bigint; occupied: bigint; partial: bigint; blocked: bigint }[]>`SELECT count(*) AS total, count(*) FILTER (WHERE status='OCCUPIED') AS occupied, count(*) FILTER (WHERE status='PARTIAL') AS partial, count(*) FILTER (WHERE status IN ('BLOCKED','QUARANTINE')) AS blocked FROM v_location_occupancy WHERE location_type IN ('RESERVE','PICKING')`,
      db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM transfers WHERE status = 'IN_TRANSIT'`,
      db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM replenishment_tasks WHERE status IN ('PENDING','IN_PROGRESS')`,
    ]);
    const toMap = (rows: { status?: string; severity?: string; n: bigint }[]) => Object.fromEntries(rows.map((r) => [(r.status ?? r.severity)!, Number(r.n)]));
    const occ = occupancy[0]!;
    const alerts: { level: 'warn' | 'error'; text: string }[] = [];
    const crit = incidents.find((i) => i.severity === 'CRITICAL');
    if (crit && Number(crit.n) > 0) alerts.push({ level: 'error', text: `${crit.n} incidencia(s) CRÍTICA(S) abiertas` });
    const stalePut = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM putaway_tasks WHERE status IN ('PENDING','ASSIGNED') AND created_at < now() - interval '4 hours'`;
    if (Number(stalePut[0]?.n ?? 0) > 0) alerts.push({ level: 'warn', text: `${stalePut[0]!.n} pallet(s) llevan más de 4 h sin ubicar` });
    const blockedShip = shipments.find((s) => s.status === 'BLOCKED');
    if (blockedShip) alerts.push({ level: 'error', text: `${blockedShip.n} embarque(s) BLOQUEADOS por validación de liberación` });
    const noLocation = Number(lpnsNoLocation[0]?.n ?? 0);
    const util = Number(occ.total) ? Math.round(((Number(occ.occupied) + Number(occ.partial) * 0.5) / Number(occ.total)) * 1000) / 10 : 0;
    if (util > 90) alerts.push({ level: 'warn', text: `Ocupación del almacén al ${util}%` });
    return {
      generated_at: new Date().toISOString(),
      containers: toMap(containers),
      receipts: toMap(receipts),
      pallets_without_location: noLocation,
      putaway_tasks: toMap(putaway),
      orders: toMap(orders),
      pick_tasks: toMap(picking),
      staging: { total: Number(staging[0]?.total ?? 0), used: Number(staging[0]?.used ?? 0) },
      shipments: toMap(shipments),
      incidents: toMap(incidents),
      cycle_counts: toMap(counts),
      transfers_in_transit: Number(transfers[0]?.n ?? 0),
      replenishment_tasks: Number(replen[0]?.n ?? 0),
      occupancy: { total: Number(occ.total), occupied: Number(occ.occupied), partial: Number(occ.partial), blocked: Number(occ.blocked), utilization_pct: util },
      alerts,
    };
  });

  /** KPIs over a period (default last 30 days). */
  app.get('/kpis', { preHandler: perm }, async (req) => {
    const q = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }).parse(req.query);
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - 30 * 86400_000);
    const [inv, recv, pick, load, d2s, prod, cycle, incRate, errUser, errSku, errCust, disc, util] = await Promise.all([
      // inventory accuracy: lines matched / lines counted in closed/approved counts
      db.$queryRaw<{ counted: bigint; matched: bigint }[]>`SELECT count(*) AS counted, count(*) FILTER (WHERE variance = 0) AS matched FROM count_lines cl JOIN count_tasks ct ON ct.id = cl.count_task_id
        WHERE cl.status IN ('MATCHED','ADJUSTED','VARIANCE','REJECTED') AND ct.created_at BETWEEN ${from} AND ${to}`,
      // receiving accuracy: receipt lines with received == expected (expected > 0)
      db.$queryRaw<{ total: bigint; exact: bigint }[]>`SELECT count(*) AS total, count(*) FILTER (WHERE received_qty = expected_qty) AS exact FROM receipt_lines rl JOIN receipts r ON r.id = rl.receipt_id
        WHERE rl.expected_qty > 0 AND r.status IN ('COMPLETED','CLOSED','WITH_INCIDENT') AND r.completed_at BETWEEN ${from} AND ${to}`,
      // picking accuracy: verifications passed / completed
      db.$queryRaw<{ total: bigint; passed: bigint }[]>`SELECT count(*) AS total, count(*) FILTER (WHERE status = 'PASSED') AS passed FROM verifications WHERE status IN ('PASSED','FAILED') AND completed_at BETWEEN ${from} AND ${to}`,
      // loading accuracy: shipments released on first attempt (no release_blocked audit)
      db.$queryRaw<{ total: bigint; clean: bigint }[]>`SELECT count(*) AS total, count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.entity_type='shipment' AND a.entity_id = s.id::text AND a.action='shipment.release_blocked')) AS clean
        FROM shipments s WHERE s.status IN ('RELEASED','DEPARTED') AND s.released_at BETWEEN ${from} AND ${to}`,
      // dock-to-stock: container arrival → LPN put-away completed (hours)
      db.$queryRaw<{ avg_hours: number | null; p90_hours: number | null }[]>`SELECT avg(EXTRACT(EPOCH FROM (t.completed_at - c.arrived_at))/3600)::float8 AS avg_hours,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (t.completed_at - c.arrived_at))/3600)::float8 AS p90_hours
        FROM putaway_tasks t JOIN lpns l ON l.id = t.lpn_id JOIN containers c ON c.id = l.container_id WHERE t.status='COMPLETED' AND c.arrived_at IS NOT NULL AND t.completed_at BETWEEN ${from} AND ${to}`,
      // productivity: picks & receipts per operator-hour (approximated by distinct hours with activity)
      db.$queryRaw<{ kind: string; lines: bigint; hours: bigint }[]>`SELECT 'picking' AS kind, count(*) AS lines, count(DISTINCT (user_id, date_trunc('hour', occurred_at))) AS hours FROM inventory_movements WHERE movement_type='PICK' AND occurred_at BETWEEN ${from} AND ${to}
        UNION ALL SELECT 'receiving', count(*), count(DISTINCT (user_id, date_trunc('hour', occurred_at))) FROM inventory_movements WHERE movement_type='RECEIPT' AND occurred_at BETWEEN ${from} AND ${to}`,
      // order cycle time: created → shipped
      db.$queryRaw<{ avg_hours: number | null; n: bigint }[]>`SELECT avg(EXTRACT(EPOCH FROM (s.departed_at - o.created_at))/3600)::float8 AS avg_hours, count(*) AS n FROM orders o JOIN shipments s ON s.id = o.shipment_id WHERE o.status='SHIPPED' AND s.departed_at BETWEEN ${from} AND ${to}`,
      db.$queryRaw<{ incidents: bigint; movements: bigint }[]>`SELECT (SELECT count(*) FROM incidents WHERE created_at BETWEEN ${from} AND ${to}) AS incidents, (SELECT count(*) FROM inventory_movements WHERE occurred_at BETWEEN ${from} AND ${to}) AS movements`,
      db.$queryRaw<{ username: string; errors: bigint }[]>`SELECT u.username, count(*) AS errors FROM audit_logs a JOIN users u ON u.id = a.user_id WHERE (a.action LIKE 'pick.blocked_%' OR a.action LIKE 'verification.blocked_%' OR a.action = 'shipment.release_blocked') AND a.occurred_at BETWEEN ${from} AND ${to} GROUP BY u.username ORDER BY errors DESC LIMIT 10`,
      db.$queryRaw<{ sku_code: string; errors: bigint }[]>`SELECT s.code AS sku_code, count(*) AS errors FROM incidents i JOIN skus s ON s.id = i.sku_id WHERE i.created_at BETWEEN ${from} AND ${to} GROUP BY s.code ORDER BY errors DESC LIMIT 10`,
      db.$queryRaw<{ customer: string; errors: bigint }[]>`SELECT c.name AS customer, count(*) AS errors FROM incidents i JOIN orders o ON o.id = i.order_id JOIN customers c ON c.id = o.customer_id WHERE i.created_at BETWEEN ${from} AND ${to} GROUP BY c.name ORDER BY errors DESC LIMIT 10`,
      db.$queryRaw<{ n: bigint; abs_units: bigint }[]>`SELECT count(*) AS n, COALESCE(sum(abs(variance)),0)::bigint AS abs_units FROM count_lines WHERE status IN ('ADJUSTED','VARIANCE') AND counted_at BETWEEN ${from} AND ${to}`,
      db.$queryRaw<{ total: bigint; occupied: bigint; partial: bigint }[]>`SELECT count(*) AS total, count(*) FILTER (WHERE status='OCCUPIED') AS occupied, count(*) FILTER (WHERE status='PARTIAL') AS partial FROM v_location_occupancy WHERE location_type IN ('RESERVE','PICKING')`,
    ]);
    const pct = (a: bigint | undefined, b: bigint | undefined) => (b && Number(b) > 0 ? Math.round((Number(a ?? 0n) / Number(b)) * 1000) / 10 : null);
    const pk = prod.find((p) => p.kind === 'picking');
    const rc = prod.find((p) => p.kind === 'receiving');
    const u = util[0]!;
    return {
      period: { from, to },
      inventory_accuracy_pct: pct(inv[0]?.matched, inv[0]?.counted),
      receiving_accuracy_pct: pct(recv[0]?.exact, recv[0]?.total),
      picking_accuracy_pct: pct(pick[0]?.passed, pick[0]?.total),
      loading_accuracy_pct: pct(load[0]?.clean, load[0]?.total),
      dock_to_stock_hours: { avg: d2s[0]?.avg_hours ?? null, p90: d2s[0]?.p90_hours ?? null },
      picking_productivity_lines_per_hour: pk && Number(pk.hours) ? Math.round((Number(pk.lines) / Number(pk.hours)) * 10) / 10 : null,
      receiving_productivity_lines_per_hour: rc && Number(rc.hours) ? Math.round((Number(rc.lines) / Number(rc.hours)) * 10) / 10 : null,
      warehouse_utilization_pct: Number(u.total) ? Math.round(((Number(u.occupied) + Number(u.partial) * 0.5) / Number(u.total)) * 1000) / 10 : null,
      order_cycle_time_hours: cycle[0]?.avg_hours ?? null,
      orders_shipped: Number(cycle[0]?.n ?? 0),
      incidence_rate_per_1000_movements: incRate[0] && Number(incRate[0].movements) ? Math.round((Number(incRate[0].incidents) / Number(incRate[0].movements)) * 1000 * 100) / 100 : null,
      errors_by_user: errUser.map((e) => ({ username: e.username, errors: Number(e.errors) })),
      errors_by_sku: errSku.map((e) => ({ sku: e.sku_code, errors: Number(e.errors) })),
      errors_by_customer: errCust.map((e) => ({ customer: e.customer, errors: Number(e.errors) })),
      stock_discrepancies: { lines: Number(disc[0]?.n ?? 0), abs_units: (disc[0]?.abs_units ?? 0n).toString() },
    };
  });
}
