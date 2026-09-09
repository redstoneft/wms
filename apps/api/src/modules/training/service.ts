// Guided, mandatory training for warehouse mode. Every step is a REAL operation performed on the handheld screens
// against the school warehouse (ESCUELA); the server prepares the scenario (a receipt to receive, a pallet to move,
// an order to pick…) and verifies from the ledger/audit that THIS user actually did it before unlocking the next step.
import type { ActorContext } from '../../lib/context.js';
import type { Permission } from '@wms/shared';
import type { Tx } from '../../db.js';
import { getDb, withTx } from '../../db.js';
import { NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import { SYSTEM_ACTOR } from '../../lib/context.js';
import { createInventory, createLpn, lockLpn, lpnContents, removeInventory } from '../../inventory/ledger.js';
import { cancelTransfer } from '../transfers/service.js';
import { closeReceivingLpn, createReceipt, receiveScan } from '../inbound/service.js';
import { acceptOrder, allocateOrder, createOrder, orderDetail } from '../orders/service.js';
import { createPickTask, pickScan, pickTaskView, stageLpn, startPickTask } from '../picking/service.js';
import { completeVerification, startVerification, verifyScan } from '../verification/service.js';
import { createShipment, departShipment, loadScan, releaseShipment } from '../shipments/service.js';
import { createCountTask } from '../counts/service.js';
import { upsertRule } from '../replenishment/service.js';
import { getSettingsCached } from '../settings/routes.js';
import { ensureSchool, SCHOOL, type School } from './school.js';

/** Synthetic actors for scenario preparation (no FK to users; audit shows the username). */
const TRAINER: ActorContext = { ...SYSTEM_ACTOR, userId: '00000000-0000-7000-8000-000000000002', username: 'escuela', requestId: 'training' };
const TRAINER_PICKER: ActorContext = { ...SYSTEM_ACTOR, userId: '00000000-0000-7000-8000-000000000003', username: 'escuela-surtidor', requestId: 'training' };

export type StepKey = 'RECEIVE' | 'PUTAWAY' | 'TRANSFER' | 'REPLENISH' | 'COUNT' | 'ASSEMBLY' | 'PICK' | 'STAGE' | 'VERIFY' | 'LOAD';
interface StepDef {
  key: StepKey;
  label: string;
  page: string;
  perm: Permission;
  goal: string;
}
export const STEPS: StepDef[] = [
  { key: 'RECEIVE', label: 'Recibir', page: '/wm/receive', perm: 'receiving.scan', goal: 'Recibir una entrega escaneando producto y cantidades, y completar la recepción.' },
  { key: 'PUTAWAY', label: 'Ubicar', page: '/wm/putaway', perm: 'putaway.execute', goal: 'Llevar un pallet recibido a la ubicación que el sistema indica.' },
  { key: 'TRANSFER', label: 'Traslados', page: '/wm/transfer', perm: 'transfers.execute', goal: 'Mover un pallet de una ubicación a otra en dos pasos (salida y llegada).' },
  { key: 'REPLENISH', label: 'Reabasto', page: '/wm/replenish', perm: 'replenishment.execute', goal: 'Bajar un pallet de reserva a la cara de picking cuando el sistema lo pide.' },
  { key: 'COUNT', label: 'Conteo', page: '/wm/count', perm: 'counts.execute', goal: 'Hacer un conteo ciego de una ubicación.' },
  { key: 'ASSEMBLY', label: 'Armado', page: '/wm/assembly', perm: 'assembly.execute', goal: 'Convertir un pallet de cuerpos en tarimas de producto terminado.' },
  { key: 'PICK', label: 'Surtir', page: '/wm/pick', perm: 'picking.execute', goal: 'Surtir un pedido siguiendo la ruta dirigida: ubicación, pallet, cantidad.' },
  { key: 'STAGE', label: 'Staging', page: '/wm/stage', perm: 'picking.execute', goal: 'Llevar los pallets surtidos al carril de staging asignado.' },
  { key: 'VERIFY', label: 'Verificar', page: '/wm/verify', perm: 'verification.execute', goal: 'Verificar a ciegas un pedido que surtió otra persona.' },
  { key: 'LOAD', label: 'Cargar', page: '/wm/load', perm: 'loading.execute', goal: 'Subir al camión cada pallet del embarque escaneándolo.' },
];

interface Progress {
  step: string;
  status: string;
  prepared: Record<string, unknown> | null;
  prepared_at: Date | null;
  completed_at: Date | null;
  attempts: number;
}

export function applicableSteps(ctx: ActorContext): StepDef[] {
  return STEPS.filter((s) => ctx.permissions.has(s.perm));
}

/** Cheap status for /auth/me (drives the gate in the web app). */
export async function trainingStatusForMe(ctx: ActorContext): Promise<{ required: boolean; completed: boolean; current_page: string | null; steps_done: number; steps_total: number }> {
  const settings = await getSettingsCached();
  const steps = applicableSteps(ctx);
  const isAdmin = ctx.roles.includes('ADMIN');
  const user = await getDb().users.findUnique({ where: { id: ctx.userId }, select: { training_completed_at: true } });
  const completed = !!user?.training_completed_at;
  const required = settings.training_required && !isAdmin && !completed && steps.length > 0;
  if (!required) return { required: false, completed, current_page: null, steps_done: 0, steps_total: steps.length };
  const done = await getDb().training_progress.findMany({ where: { user_id: ctx.userId, status: 'COMPLETED' }, select: { step: true } });
  const doneSet = new Set(done.map((d) => d.step));
  const current = steps.find((s) => !doneSet.has(s.key));
  return { required: true, completed, current_page: current?.page ?? null, steps_done: steps.filter((s) => doneSet.has(s.key)).length, steps_total: steps.length };
}

// ---------------------------------------------------------------------
// scenario helpers (all in the school warehouse)
// ---------------------------------------------------------------------
async function schoolPallet(tx: Tx, school: School, skuIdx: number, locationId: string, pieces: bigint, cases: number) {
  const sku = school.skus[skuIdx]!;
  const lpn = await createLpn(tx, TRAINER, { warehouse_id: school.warehouse_id, lpn_type: 'STORAGE', location_id: locationId, cases_count: cases });
  await tx.lpns.update({ where: { id: lpn.id }, data: { status: 'STORED' } });
  await createInventory(tx, TRAINER, { movement_type: 'INITIAL_LOAD', to_lpn: lpn, sku_id: sku.id, qty: pieces, uom_code: 'CASE', uom_qty: BigInt(cases), status: 'AVAILABLE', location_id: locationId, reason: 'Escuela: pallet de práctica' });
  return { id: lpn.id, code: lpn.code };
}
async function freeReserve(tx: Tx, school: School, n = 1) {
  const out = [];
  for (const l of school.reserve) {
    const busy = await tx.lpns.count({ where: { current_location_id: l.id, status: { notIn: ['SHIPPED', 'CANCELLED', 'CONSUMED'] } } });
    const reserved = await tx.$queryRaw<{ n: bigint }[]>`SELECT (SELECT count(*) FROM putaway_tasks p WHERE p.suggested_location_id = ${l.id}::uuid AND p.status IN ('PENDING','ASSIGNED','IN_PROGRESS')) + (SELECT count(*) FROM transfers t WHERE t.to_location_id = ${l.id}::uuid AND t.status = 'IN_TRANSIT') AS n`;
    if (!busy && (reserved[0]?.n ?? 0n) === 0n) out.push(l);
    if (out.length === n) break;
  }
  if (out.length < n) throw new RuleError('SCHOOL_FULL', 'El almacén escuela no tiene posiciones libres; pide al supervisor que embarque o consuma los pallets de práctica');
  return out;
}
/** A stored practice pallet of the SKU with at least `min` AVAILABLE pieces, not claimed by any active task. */
async function storedPallet(tx: Tx, school: School, skuIdx: number, min: bigint, locType: 'RESERVE' | 'PICKING' = 'RESERVE') {
  const sku = school.skus[skuIdx]!;
  const rows = await tx.$queryRaw<{ id: string; code: string; qty: bigint }[]>`
    SELECT l.id, l.code, b.qty FROM lpns l JOIN inventory_balances b ON b.lpn_id = l.id AND b.status = 'AVAILABLE' AND b.sku_id = ${sku.id}::uuid
      JOIN locations loc ON loc.id = l.current_location_id
     WHERE l.warehouse_id = ${school.warehouse_id}::uuid AND l.status = 'STORED' AND loc.location_type = ${locType} AND b.qty >= ${min}
       AND NOT EXISTS (SELECT 1 FROM allocations a WHERE a.lpn_id = l.id AND a.status = 'ACTIVE')
       AND NOT EXISTS (SELECT 1 FROM transfers t WHERE t.lpn_id = l.id AND t.status = 'IN_TRANSIT')
       AND NOT EXISTS (SELECT 1 FROM putaway_tasks p WHERE p.lpn_id = l.id AND p.status IN ('PENDING','ASSIGNED','IN_PROGRESS'))
     ORDER BY l.created_at LIMIT 1`;
  return rows[0] ?? null;
}
async function ensureStock(tx: Tx, school: School, skuIdx: number, min: bigint) {
  const have = await storedPallet(tx, school, skuIdx, min);
  if (have) return have;
  const sku = school.skus[skuIdx]!;
  const cases = Number((min + sku.case_qty - 1n) / sku.case_qty) + 4;
  const [loc] = await freeReserve(tx, school);
  return schoolPallet(tx, school, skuIdx, loc!.id, BigInt(cases) * sku.case_qty, cases);
}
/** Prepares an order for the trainee's warehouse: created, accepted, allocated. */
async function schoolOrder(tx: Tx, school: School, tag: string) {
  await ensureStock(tx, school, 0, 12n);
  await ensureStock(tx, school, 1, 4n);
  const order = await createOrder(tx, TRAINER, { order_number: `CAP-${tag}-${Date.now().toString(36).toUpperCase()}`, customer_code: school.customer.code, destination: 'Escuela', priority: 1, source: 'MANUAL', lines: [{ sku_code: school.skus[0]!.code, qty: 2n, uom_code: 'CASE' }, { sku_code: school.skus[1]!.code, qty: 1n, uom_code: 'CASE' }] });
  await acceptOrder(tx, TRAINER, order.id);
  await allocateOrder(tx, TRAINER, { order_id: order.id, allow_partial: false });
  return order;
}
/** The trainer picks and stages an order (so the trainee can verify / load it). */
async function trainerPickAndStage(tx: Tx, school: School, orderId: string) {
  const { task } = await createPickTask(tx, TRAINER_PICKER, orderId, TRAINER_PICKER.userId);
  await startPickTask(tx, TRAINER_PICKER, task.id);
  const view = await pickTaskView(tx, task.id);
  for (const line of view.lines as { id: string; location_barcode: string; lpn_code: string; qty: string }[]) {
    await pickScan(tx, TRAINER_PICKER, { pick_task_id: task.id, line_id: line.id, step: 'LOCATION', scanned: line.location_barcode });
    await pickScan(tx, TRAINER_PICKER, { pick_task_id: task.id, line_id: line.id, step: 'LPN', scanned: line.lpn_code });
    await pickScan(tx, TRAINER_PICKER, { pick_task_id: task.id, line_id: line.id, step: 'QTY', qty: BigInt(line.qty), uom_code: 'PIECE' });
  }
  const od = await orderDetail(tx, orderId);
  const lane = od.staging_assignments[0]?.location;
  if (!lane) throw new RuleError('NO_STAGING_ASSIGNED', 'La escuela no tiene carril de staging asignado');
  for (const l of od.lpns.filter((x) => x.status === 'PICKING')) await stageLpn(tx, TRAINER_PICKER, { lpn_code: l.code, staging_location_barcode: lane.barcode });
  void school;
  return { order: od, lane };
}
async function trainerVerify(tx: Tx, school: School, orderId: string) {
  const v = await startVerification(tx, TRAINER, { order_id: orderId });
  const od = await orderDetail(tx, orderId);
  for (const l of od.lpns.filter((x) => x.status === 'STAGED')) {
    const bal = await tx.inventory_balances.findMany({ where: { lpn_id: l.id, qty: { gt: 0n } }, include: { sku: { include: { barcodes: true } } } });
    for (const b of bal) {
      const piece = b.sku.barcodes.find((bc) => bc.uom_code === 'PIECE')?.barcode ?? b.sku.code;
      await verifyScan(tx, TRAINER, { verification_id: v.verification_id, lpn_code: l.code, barcode: piece, qty: b.qty });
    }
  }
  await completeVerification(tx, TRAINER, v.verification_id);
  void school;
}

// ---------------------------------------------------------------------
// prepare: builds the scenario for a step and returns what the trainee must scan
// ---------------------------------------------------------------------
async function prepareStep(tx: Tx, ctx: ActorContext, school: School, step: StepKey): Promise<Record<string, unknown>> {
  const s0 = school.skus[0]!;
  const s1 = school.skus[1]!;
  const s2 = school.skus[2]!;
  switch (step) {
    case 'RECEIVE': {
      const r = await createReceipt(tx, TRAINER, { receiving_location_id: school.dock.id, notes: `Capacitación ${ctx.username}`, expected: [{ sku_code: s0.code, qty: 4n, uom_code: 'CASE' }, { sku_code: s1.code, qty: 2n, uom_code: 'CASE' }] });
      return { receipt_id: r.id, receipt_number: r.receipt_number, dock: school.dock.code, lines: [{ barcode: s0.case, cases: 4, sku: s0.code }, { barcode: s1.case, cases: 2, sku: s1.code }] };
    }
    case 'PUTAWAY': {
      // pallets this trainee received (still at the dock with a pending task) or a fresh one from the trainer
      const mine = await tx.$queryRaw<{ code: string }[]>`
        SELECT l.code FROM lpns l JOIN putaway_tasks p ON p.lpn_id = l.id AND p.status = 'PENDING'
         WHERE l.warehouse_id = ${school.warehouse_id}::uuid AND l.current_location_id = ${school.dock.id}::uuid
           AND EXISTS (SELECT 1 FROM inventory_movements m WHERE m.to_lpn_id = l.id AND m.movement_type = 'RECEIPT' AND m.user_id = ${ctx.userId}::uuid)
         ORDER BY l.created_at DESC LIMIT 2`;
      if (mine.length) return { lpns: mine.map((m) => m.code) };
      const r = await createReceipt(tx, TRAINER, { receiving_location_id: school.dock.id, expected: [{ sku_code: s0.code, qty: 4n, uom_code: 'CASE' }] });
      const scan = await receiveScan(tx, TRAINER, { receipt_id: r.id, barcode: s0.case, qty: 4n, cases_count: 4, damaged: false });
      await closeReceivingLpn(tx, TRAINER, scan.lpn.code);
      return { lpns: [scan.lpn.code] };
    }
    case 'TRANSFER': {
      const p = await ensureStock(tx, school, 1, 4n);
      const [free] = await freeReserve(tx, school);
      return { lpn: p.code, suggested: free!.code };
    }
    case 'REPLENISH': {
      // an empty pick face (previous trainees leave theirs full; the pick step drains them over time)
      let pick = null as School['picking'][number] | null;
      for (const l of school.picking) {
        const n = await tx.lpns.count({ where: { current_location_id: l.id, status: { notIn: ['SHIPPED', 'CANCELLED', 'CONSUMED'] } } });
        const pending = await tx.replenishment_tasks.count({ where: { to_location_id: l.id, status: { in: ['PENDING', 'IN_PROGRESS'] } } });
        if (!n && !pending) {
          pick = l;
          break;
        }
      }
      if (!pick) throw new RuleError('PICK_FACES_FULL', 'Las caras de picking de la escuela están llenas; pide al supervisor que las vacíe (surtir pedidos de práctica) para practicar el reabasto');
      await ensureStock(tx, school, 0, 12n);
      const rule = await upsertRule(tx, TRAINER, { sku_code: s0.code, pick_location_barcode: pick.barcode, min_qty: 6n, max_qty: 60n });
      await tx.replenishment_tasks.create({ data: { rule_id: rule.id, sku_id: s0.id, to_location_id: pick.id, qty: 60n, status: 'PENDING' } });
      return { sku: s0.code, pick_location: pick.code };
    }
    case 'COUNT': {
      const p = await ensureStock(tx, school, 1, 4n);
      const loc = await tx.lpns.findUniqueOrThrow({ where: { id: p.id }, select: { current_location: { select: { code: true, barcode: true } } } });
      const task = await createCountTask(tx, TRAINER, { count_type: 'LOCATION', location_barcodes: [loc.current_location!.barcode], assigned_to: ctx.userId, is_blind: true, notes: `Capacitación ${ctx.username}` });
      return { task_id: task.id, location: loc.current_location!.code, lpn: p.code, product_barcode: s1.piece };
    }
    case 'ASSEMBLY': {
      const p = await schoolPallet(tx, school, 2, school.station.id, 24n, 1);
      return { lpn: p.code, station: school.station.code, sku: s2.code, product_barcode: s2.case, pieces: 24, pallets: 2, cases_per_pallet: 1, pieces_per_case: 12 };
    }
    case 'PICK': {
      const order = await schoolOrder(tx, school, ctx.username.slice(0, 8).toUpperCase());
      const { task } = await createPickTask(tx, TRAINER, order.id, ctx.userId);
      return { order_id: order.id, order_number: order.order_number, task_id: task.id };
    }
    case 'STAGE': {
      // the order the trainee picked, if it is waiting for staging; otherwise the trainer picks a fresh one
      const picked = await tx.orders.findFirst({ where: { picker_id: ctx.userId, status: 'PICKED', customer: { code: school.customer.code } }, orderBy: { created_at: 'desc' } });
      if (picked) {
        const od = await orderDetail(tx, picked.id);
        return { order_id: picked.id, order_number: picked.order_number, lane: od.staging_assignments[0]?.location.code ?? school.staging.code, lpns: od.lpns.filter((l) => l.status === 'PICKING').map((l) => l.code) };
      }
      const order = await schoolOrder(tx, school, ctx.username.slice(0, 8).toUpperCase());
      const { task } = await createPickTask(tx, TRAINER_PICKER, order.id, TRAINER_PICKER.userId);
      await startPickTask(tx, TRAINER_PICKER, task.id);
      const view = await pickTaskView(tx, task.id);
      for (const line of view.lines as { id: string; location_barcode: string; lpn_code: string; qty: string }[]) {
        await pickScan(tx, TRAINER_PICKER, { pick_task_id: task.id, line_id: line.id, step: 'LOCATION', scanned: line.location_barcode });
        await pickScan(tx, TRAINER_PICKER, { pick_task_id: task.id, line_id: line.id, step: 'LPN', scanned: line.lpn_code });
        await pickScan(tx, TRAINER_PICKER, { pick_task_id: task.id, line_id: line.id, step: 'QTY', qty: BigInt(line.qty), uom_code: 'PIECE' });
      }
      const od = await orderDetail(tx, order.id);
      return { order_id: order.id, order_number: order.order_number, lane: od.staging_assignments[0]?.location.code ?? school.staging.code, lpns: od.lpns.filter((l) => l.status === 'PICKING').map((l) => l.code) };
    }
    case 'VERIFY': {
      const order = await schoolOrder(tx, school, ctx.username.slice(0, 8).toUpperCase());
      const { lane } = await trainerPickAndStage(tx, school, order.id);
      return { order_id: order.id, order_number: order.order_number, lane: lane.code, products: [{ barcode: s0.piece, sku: s0.code }, { barcode: s1.piece, sku: s1.code }] };
    }
    case 'LOAD': {
      const verified = await tx.orders.findFirst({ where: { status: 'VERIFIED', customer: { code: school.customer.code }, verifications: { some: { verifier_id: ctx.userId, status: 'PASSED' } }, shipment_id: null }, orderBy: { created_at: 'desc' } });
      let order: { id: string; order_number: string };
      if (verified) order = verified;
      else {
        order = await schoolOrder(tx, school, ctx.username.slice(0, 8).toUpperCase());
        await trainerPickAndStage(tx, school, order.id);
        await trainerVerify(tx, school, order.id);
      }
      const sh = await createShipment(tx, TRAINER, { carrier_id: school.carrier.id, vehicle: 'Camión escuela', plates: 'CAP-000', driver_name: 'Práctica', dock_location_id: school.ship.id, order_ids: [order.id] });
      const od = await orderDetail(tx, order.id);
      return { shipment_id: sh.id, shipment_number: sh.shipment_number, order_number: order.order_number, dock: school.ship.code, lpns: od.lpns.filter((l) => l.status === 'STAGED').map((l) => l.code) };
    }
  }
}

// ---------------------------------------------------------------------
// check: did THIS user do it? (evidence from the ledger / task tables, after prepared_at)
// ---------------------------------------------------------------------
async function checkStep(tx: Tx, ctx: ActorContext, school: School, step: StepKey, p: Record<string, unknown>, since: Date): Promise<{ ok: boolean; hint: string; evidence?: Record<string, unknown> }> {
  const uid = ctx.userId;
  switch (step) {
    case 'RECEIVE': {
      const r = await tx.receipts.findUnique({ where: { id: String(p.receipt_id) }, select: { status: true, receipt_number: true } });
      const lpns = await tx.$queryRaw<{ code: string }[]>`SELECT DISTINCT l.code FROM lpns l JOIN inventory_movements m ON m.to_lpn_id = l.id AND m.movement_type = 'RECEIPT' AND m.user_id = ${uid}::uuid WHERE l.receipt_id = ${String(p.receipt_id)}::uuid`;
      if (!lpns.length) return { ok: false, hint: `Aún no hay pallets recibidos por ti en la recepción ${String(p.receipt_number)}. Entra a Recibir, elige esa recepción y escanea el producto.` };
      if (lpns.length < 2) return { ok: false, hint: 'Falta recibir el segundo producto (CAP002C, 2 cajas) en un pallet nuevo.' };
      if (!r || !['COMPLETED', 'CLOSED', 'WITH_INCIDENT'].includes(r.status)) return { ok: false, hint: 'Ya recibiste los pallets; ahora pulsa "Completar recepción" en la pantalla de Recibir.' };
      return { ok: true, hint: '', evidence: { lpns: lpns.map((l) => l.code), receipt: r.receipt_number } };
    }
    case 'PUTAWAY': {
      const codes = p.lpns as string[];
      const done = await tx.$queryRaw<{ code: string; loc: string }[]>`SELECT l.code, loc.code AS loc FROM putaway_tasks t JOIN lpns l ON l.id = t.lpn_id JOIN locations loc ON loc.id = t.final_location_id WHERE t.status = 'COMPLETED' AND t.assigned_to = ${uid}::uuid AND t.completed_at >= ${since} AND l.code = ANY(${codes}::text[])`;
      if (!done.length) return { ok: false, hint: `Todavía no ubicaste el pallet ${codes[0]}. En Ubicar: escanea el LPN, lleva el pallet y escanea la ubicación que te indica.` };
      return { ok: true, hint: '', evidence: { placed: done } };
    }
    case 'TRANSFER': {
      const t = await tx.$queryRaw<{ id: string; to: string }[]>`SELECT t.id, d.code AS "to" FROM transfers t JOIN lpns l ON l.id = t.lpn_id JOIN locations d ON d.id = t.to_location_id WHERE t.status = 'COMPLETED' AND t.completed_by = ${uid}::uuid AND t.completed_at >= ${since} AND l.code = ${String(p.lpn)}`;
      if (!t.length) {
        const started = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM transfers t JOIN lpns l ON l.id = t.lpn_id WHERE l.code = ${String(p.lpn)} AND t.status = 'IN_TRANSIT'`;
        return { ok: false, hint: started[0]!.n > 0n ? 'El traslado está en tránsito: en Traslados → "En tránsito", elige el traslado, escanea el LPN y la ubicación destino para completarlo.' : `Aún no iniciaste el traslado del pallet ${String(p.lpn)}: Traslados → Nuevo traslado → escanea el LPN y la ubicación destino.` };
      }
      return { ok: true, hint: '', evidence: { transfer: t[0] } };
    }
    case 'REPLENISH': {
      const t = await tx.$queryRaw<{ id: string }[]>`SELECT t.id FROM transfers t JOIN locations d ON d.id = t.to_location_id WHERE t.transfer_type = 'REPLENISHMENT' AND t.status = 'COMPLETED' AND t.completed_by = ${uid}::uuid AND t.completed_at >= ${since} AND d.warehouse_id = ${school.warehouse_id}::uuid`;
      if (!t.length) return { ok: false, hint: `Aún no completaste el reabasto de ${String(p.sku)} hacia ${String(p.pick_location)}: en Reabasto elige la tarea, pulsa INICIAR, lleva el pallet y escanea LPN y ubicación.` };
      return { ok: true, hint: '', evidence: { transfer: t[0] } };
    }
    case 'COUNT': {
      const lines = await tx.count_lines.findMany({ where: { count_task_id: String(p.task_id) }, select: { counted_by: true, status: true } });
      const counted = lines.filter((l) => l.counted_by === uid).length;
      if (!lines.length || counted < lines.length) return { ok: false, hint: `Faltan líneas por contar en ${String(p.location)}: escanea la ubicación, el LPN ${String(p.lpn)}, el producto y captura las piezas. Luego pulsa TERMINAR.` };
      const task = await tx.count_tasks.findUnique({ where: { id: String(p.task_id) }, select: { status: true } });
      if (task && ['PENDING', 'IN_PROGRESS'].includes(task.status)) return { ok: false, hint: 'Ya contaste todo; pulsa TERMINAR en la pantalla de Conteo para cerrar la tarea.' };
      return { ok: true, hint: '', evidence: { task_status: task?.status, lines: lines.length } };
    }
    case 'ASSEMBLY': {
      const a = await tx.assembly_orders.findFirst({ where: { created_by: uid, warehouse_id: school.warehouse_id, created_at: { gte: since } }, select: { code: true, output_qty: true, outputs: { select: { lpn: { select: { code: true } } } } } });
      if (!a) return { ok: false, hint: `Aún no registraste el armado: Armado → estación ${String(p.station)} → LPN ${String(p.lpn)} → ${String(p.pieces)} piezas → producto ${String(p.product_barcode)} → ${String(p.pallets)} tarimas × ${String(p.cases_per_pallet)} caja × ${String(p.pieces_per_case)} pzas.` };
      return { ok: true, hint: '', evidence: { order: a.code, pallets: a.outputs.map((o) => o.lpn.code) } };
    }
    case 'PICK': {
      const task = await tx.pick_tasks.findUnique({ where: { id: String(p.task_id) }, select: { status: true, assigned_to: true } });
      const picks = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM inventory_movements WHERE movement_type = 'PICK' AND user_id = ${uid}::uuid AND order_id = ${String(p.order_id)}::uuid`;
      if (!picks[0] || picks[0].n === 0n) return { ok: false, hint: `Aún no surtiste nada del pedido ${String(p.order_number)}: en Surtir elige ese pedido y sigue la ruta (ubicación → pallet → cantidad).` };
      if (task?.status !== 'COMPLETED') return { ok: false, hint: 'Falta terminar el pedido: surte todas las líneas hasta que la pantalla diga PEDIDO SURTIDO.' };
      return { ok: true, hint: '', evidence: { picks: Number(picks[0].n) } };
    }
    case 'STAGE': {
      const stages = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM inventory_movements WHERE movement_type = 'STAGE' AND user_id = ${uid}::uuid AND order_id = ${String(p.order_id)}::uuid`;
      const order = await tx.orders.findUnique({ where: { id: String(p.order_id) }, select: { status: true } });
      if (!stages[0] || stages[0].n === 0n) return { ok: false, hint: `Aún no llevaste ningún pallet del pedido ${String(p.order_number)} a staging: en Staging escanea el LPN de salida y luego el carril ${String(p.lane)}.` };
      if (order?.status === 'PICKED') return { ok: false, hint: 'Falta un pallet por llevar a staging: repite el escaneo con el otro LPN.' };
      return { ok: true, hint: '', evidence: { staged: Number(stages[0].n), order_status: order?.status } };
    }
    case 'VERIFY': {
      const v = await tx.verifications.findFirst({ where: { order_id: String(p.order_id), verifier_id: uid, status: 'PASSED' }, select: { id: true } });
      if (!v) {
        const open = await tx.verifications.findFirst({ where: { order_id: String(p.order_id), verifier_id: uid, status: 'IN_PROGRESS' } });
        return { ok: false, hint: open ? 'La verificación está abierta: escanea cada pallet, el producto y captura las piezas; al final pulsa TERMINAR.' : `Aún no verificaste el pedido ${String(p.order_number)}: en Verificar elígelo y escanea pallet, producto y cantidad a ciegas.` };
      }
      return { ok: true, hint: '', evidence: { verification: v.id } };
    }
    case 'LOAD': {
      const loads = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM inventory_movements WHERE movement_type = 'LOAD' AND user_id = ${uid}::uuid AND shipment_id = ${String(p.shipment_id)}::uuid`;
      const expected = (p.lpns as string[]).length;
      if (!loads[0] || loads[0].n === 0n) return { ok: false, hint: `Aún no cargaste ningún pallet del embarque ${String(p.shipment_number)}: en Cargar elígelo y escanea cada pallet al subirlo.` };
      if (Number(loads[0].n) < expected) return { ok: false, hint: `Cargaste ${loads[0].n} de ${expected} pallets; escanea los que faltan.` };
      return { ok: true, hint: '', evidence: { loaded: Number(loads[0].n) } };
    }
  }
}

/** Housekeeping after a passed step: ship out practice orders so staging lanes and pallets do not pile up in the school. */
async function tidySchool(tx: Tx, school: School, step: StepKey, p: Record<string, unknown>) {
  try {
    if (step === 'STAGE') {
      const orderId = String(p.order_id);
      await trainerVerify(tx, school, orderId);
      const sh = await createShipment(tx, TRAINER, { carrier_id: school.carrier.id, vehicle: 'Camión escuela', plates: 'CAP-000', driver_name: 'Práctica', dock_location_id: school.ship.id, order_ids: [orderId] });
      const od = await orderDetail(tx, orderId);
      for (const l of od.lpns.filter((x) => x.status === 'STAGED')) await loadScan(tx, TRAINER, { shipment_id: sh.id, lpn_code: l.code });
      const v = await tx.shipments.findUniqueOrThrow({ where: { id: sh.id }, select: { version: true } });
      await releaseShipment(tx, TRAINER, { shipment_id: sh.id, version: v.version });
      await departShipment(tx, TRAINER, sh.id);
    }
    if (step === 'LOAD') {
      const shipmentId = String(p.shipment_id);
      const v = await tx.shipments.findUniqueOrThrow({ where: { id: shipmentId }, select: { version: true, status: true } });
      if (['OPEN', 'LOADING', 'BLOCKED'].includes(v.status)) await releaseShipment(tx, TRAINER, { shipment_id: shipmentId, version: v.version });
      await departShipment(tx, TRAINER, shipmentId);
    }
  } catch (e) {
    // housekeeping must never block the trainee's progress
    await audit(tx, TRAINER, { action: 'training.tidy_failed', entity_type: 'training', entity_id: step, after: { error: (e as Error).message } });
  }
}

function instructionsFor(step: StepKey, p: Record<string, unknown> | null, school: School): string[] {
  const c = (v: unknown) => String(v ?? '…');
  switch (step) {
    case 'RECEIVE':
      return [
        `Entra a RECIBIR y elige la recepción ${c(p?.receipt_number)} (andén ${school.dock.code}).`,
        `Escanea la caja CAP001C (o escríbela), elige PALLET NUEVO y captura 4 cajas. Registra y cierra el pallet.`,
        `Escanea CAP002C, PALLET NUEVO, 2 cajas. Registra y cierra el pallet.`,
        `Pulsa COMPLETAR RECEPCIÓN. Imprime las etiquetas LPN si hay impresora; si no, anota los códigos que aparecen.`,
      ];
    case 'PUTAWAY':
      return [`Entra a UBICAR y escanea el pallet ${c((p?.lpns as string[] | undefined)?.[0])}.`, 'Lee la ubicación que te indica, lleva el pallet y escanea la etiqueta de esa ubicación. Si escaneas otra, el sistema lo rechaza.', ...((p?.lpns as string[] | undefined)?.length === 2 ? [`Repite con el pallet ${c((p?.lpns as string[])[1])}.`] : [])];
    case 'TRANSFER':
      return [`Entra a TRASLADOS → NUEVO TRASLADO. Escanea el pallet ${c(p?.lpn)} y luego una ubicación libre del rack escuela, por ejemplo ${c(p?.suggested)}.`, 'El pallet queda EN TRÁNSITO. Regresa al menú de Traslados → EN TRÁNSITO, elige tu traslado.', 'Escanea el LPN y después la ubicación destino para completarlo.'];
    case 'REPLENISH':
      return [`Entra a REABASTO y elige la tarea de ${c(p?.sku)} hacia ${c(p?.pick_location)}.`, 'Pulsa INICIAR: te dice qué pallet de reserva bajar.', `Lleva ese pallet a ${c(p?.pick_location)}, escanea el LPN y la ubicación.`];
    case 'COUNT':
      return [`Entra a CONTEO y elige la tarea de la ubicación ${c(p?.location)}.`, `Escanea la ubicación ${c(p?.location)}, luego el pallet ${c(p?.lpn)} y el producto ${c(p?.product_barcode)}.`, 'Cuenta las piezas de verdad (es conteo ciego: el sistema no te dice cuántas hay) y captúralas.', 'Pulsa TERMINAR.'];
    case 'ASSEMBLY':
      return [`Entra a ARMADO y escanea la estación LOC-${c(p?.station)}.`, `Escanea el pallet ${c(p?.lpn)} y captura ${c(p?.pieces)} piezas consumidas. Pulsa "Listo, sin más insumos".`, `Escanea el producto terminado ${c(p?.product_barcode)}. Captura ${c(p?.pallets)} tarimas, ${c(p?.cases_per_pallet)} caja por tarima y ${c(p?.pieces_per_case)} piezas por caja.`, 'Sin merma. Confirma y registra el armado. Imprime las etiquetas de las tarimas nuevas.'];
    case 'PICK':
      return [`Entra a SURTIR y elige el pedido ${c(p?.order_number)}.`, 'Sigue la ruta: escanea la ubicación que indica, luego el pallet, luego captura la cantidad en cajas.', 'Repite con cada línea hasta que diga PEDIDO SURTIDO.'];
    case 'STAGE':
      return [`Entra a STAGING. Escanea el pallet de salida ${c((p?.lpns as string[] | undefined)?.[0])} y luego el carril ${c(p?.lane)}.`, ...(((p?.lpns as string[] | undefined)?.length ?? 0) > 1 ? [`Repite con ${c((p?.lpns as string[])[1])}.`] : []), 'Si escaneas otro carril, el sistema lo rechaza: cada pedido tiene su carril.'];
    case 'VERIFY':
      return [`Entra a VERIFICAR y elige el pedido ${c(p?.order_number)} (lo surtió otra persona; tú no puedes verificar lo que surtes).`, 'Escanea un pallet del pedido, escanea el producto y cuenta las piezas a ciegas. Repite por cada pallet y producto.', 'Pulsa TERMINAR. Si algo no cuadra, el sistema lo marca.'];
    case 'LOAD':
      return [`Entra a CARGAR y elige el embarque ${c(p?.shipment_number)} (pedido ${c(p?.order_number)}, andén ${c(p?.dock)}).`, 'Escanea cada pallet al subirlo al camión. Un pallet dos veces o de otro pedido se rechaza.', 'Cuando todos estén arriba, la pantalla lo confirma.'];
  }
}

function codesFor(step: StepKey, p: Record<string, unknown> | null, school: School): { label: string; value: string }[] {
  if (!p) return [];
  const out: { label: string; value: string }[] = [];
  const push = (label: string, v: unknown) => v && out.push({ label, value: String(v) });
  switch (step) {
    case 'RECEIVE':
      push('Recepción', p.receipt_number);
      push('Andén', school.dock.barcode);
      for (const l of p.lines as { barcode: string; cases: number }[]) push(`Caja (${l.cases} cajas)`, l.barcode);
      break;
    case 'PUTAWAY':
      (p.lpns as string[]).forEach((l, i) => push(`Pallet ${i + 1}`, l));
      break;
    case 'TRANSFER':
      push('Pallet', p.lpn);
      push('Destino sugerido', `LOC-${String(p.suggested)}`);
      break;
    case 'REPLENISH':
      push('Producto', p.sku);
      push('Cara de picking', `LOC-${String(p.pick_location)}`);
      break;
    case 'COUNT':
      push('Ubicación', `LOC-${String(p.location)}`);
      push('Pallet', p.lpn);
      push('Producto', p.product_barcode);
      break;
    case 'ASSEMBLY':
      push('Estación', `LOC-${String(p.station)}`);
      push('Pallet de cuerpos', p.lpn);
      push('Producto terminado', p.product_barcode);
      break;
    case 'PICK':
      push('Pedido', p.order_number);
      break;
    case 'STAGE':
      (p.lpns as string[]).forEach((l, i) => push(`Pallet ${i + 1}`, l));
      push('Carril', `LOC-${String(p.lane)}`);
      break;
    case 'VERIFY':
      push('Pedido', p.order_number);
      for (const pr of p.products as { barcode: string; sku: string }[]) push(`Producto ${pr.sku}`, pr.barcode);
      break;
    case 'LOAD':
      push('Embarque', p.shipment_number);
      (p.lpns as string[]).forEach((l, i) => push(`Pallet ${i + 1}`, l));
      break;
  }
  return out;
}

// ---------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------
export async function myTraining(ctx: ActorContext) {
  return withTx(async (tx) => {
    const settings = await getSettingsCached();
    const school = await ensureSchool(tx);
    const user = await tx.users.findUniqueOrThrow({ where: { id: ctx.userId }, select: { training_completed_at: true } });
    const steps = applicableSteps(ctx);
    const rows = await tx.training_progress.findMany({ where: { user_id: ctx.userId } });
    const byStep = new Map(rows.map((r) => [r.step, r as unknown as Progress]));
    let current: StepKey | null = null;
    const out = steps.map((s) => {
      const p = byStep.get(s.key);
      const status = p?.status === 'COMPLETED' ? 'COMPLETED' : current === null ? 'CURRENT' : 'LOCKED';
      if (status === 'CURRENT') current = s.key;
      const prepared = (p?.prepared as Record<string, unknown> | null) ?? null;
      return { key: s.key, label: s.label, page: s.page, goal: s.goal, status, prepared: !!prepared, prepared_at: p?.prepared_at ?? null, completed_at: p?.completed_at ?? null, attempts: p?.attempts ?? 0, instructions: instructionsFor(s.key, prepared, school), codes: codesFor(s.key, prepared, school) };
    });
    const isAdmin = ctx.roles.includes('ADMIN');
    return {
      required: settings.training_required && !isAdmin && !user.training_completed_at && steps.length > 0,
      completed_at: user.training_completed_at,
      steps_done: out.filter((s) => s.status === 'COMPLETED').length,
      steps_total: out.length,
      current,
      steps: out,
      school: { warehouse: SCHOOL.warehouse.code, dock: school.dock.code, staging: school.staging.code, ship: school.ship.code },
    };
  });
}

export async function prepare(ctx: ActorContext, step: StepKey) {
  const def = STEPS.find((s) => s.key === step);
  if (!def) throw new NotFoundError('training step', step);
  if (!ctx.permissions.has(def.perm)) throw new RuleError('STEP_NOT_APPLICABLE', `Tu rol no tiene la operación ${def.label}`);
  return withTx(async (tx) => {
    const school = await ensureSchool(tx);
    const existing = await tx.training_progress.findUnique({ where: { user_id_step: { user_id: ctx.userId, step } } });
    if (existing?.status === 'COMPLETED') throw new RuleError('STEP_DONE', 'Este paso ya está completado');
    const prepared = await prepareStep(tx, ctx, school, step);
    await tx.training_progress.upsert({
      where: { user_id_step: { user_id: ctx.userId, step } },
      create: { user_id: ctx.userId, step, status: 'PENDING', prepared: prepared as object, prepared_at: new Date() },
      update: { prepared: prepared as object, prepared_at: new Date() },
    });
    await audit(tx, ctx, { action: 'training.prepare', entity_type: 'training', entity_id: step, after: prepared });
    return { step, prepared: true, instructions: instructionsFor(step, prepared, school), codes: codesFor(step, prepared, school) };
  });
}

export async function check(ctx: ActorContext, step: StepKey) {
  return withTx(async (tx) => {
    const school = await ensureSchool(tx);
    const row = await tx.training_progress.findUnique({ where: { user_id_step: { user_id: ctx.userId, step } } });
    if (!row || !row.prepared) throw new RuleError('STEP_NOT_PREPARED', 'Primero pulsa "Preparar ejercicio"');
    if (row.status === 'COMPLETED') return { ok: true, step, hint: 'Paso ya completado', training_completed: false };
    const res = await checkStep(tx, ctx, school, step, row.prepared as Record<string, unknown>, row.prepared_at ?? new Date(0));
    await tx.training_progress.update({ where: { user_id_step: { user_id: ctx.userId, step } }, data: { attempts: { increment: 1 }, ...(res.ok ? { status: 'COMPLETED', completed_at: new Date(), evidence: (res.evidence ?? {}) as object } : {}) } });
    let trainingCompleted = false;
    if (res.ok) {
      await audit(tx, ctx, { action: 'training.step_completed', entity_type: 'training', entity_id: step, after: res.evidence ?? {} });
      await tidySchool(tx, school, step, row.prepared as Record<string, unknown>);
      const steps = applicableSteps(ctx);
      const done = await tx.training_progress.count({ where: { user_id: ctx.userId, status: 'COMPLETED', step: { in: steps.map((s) => s.key) } } });
      if (done >= steps.length) {
        await tx.users.update({ where: { id: ctx.userId }, data: { training_completed_at: new Date(), training_completed_by: ctx.userId } });
        await audit(tx, ctx, { action: 'training.completed', entity_type: 'user', entity_id: ctx.userId, after: { steps: steps.map((s) => s.key) } });
        trainingCompleted = true;
      }
    }
    return { ok: res.ok, step, hint: res.hint, evidence: res.evidence ?? null, training_completed: trainingCompleted };
  });
}

// ---- admin ----
export async function trainingUsers() {
  const db = getDb();
  const users = await db.users.findMany({ where: { is_active: true }, select: { id: true, username: true, full_name: true, training_completed_at: true, training_completed_by: true, user_roles: { select: { role: { select: { code: true } } } } }, orderBy: { username: 'asc' } });
  const progress = await db.training_progress.findMany({ select: { user_id: true, step: true, status: true, completed_at: true, attempts: true } });
  return users.map((u) => ({
    id: u.id,
    username: u.username,
    full_name: u.full_name,
    roles: u.user_roles.map((r) => r.role.code),
    completed_at: u.training_completed_at,
    waived: !!u.training_completed_at && u.training_completed_by !== u.id,
    steps: progress.filter((p) => p.user_id === u.id).map((p) => ({ step: p.step, status: p.status, completed_at: p.completed_at, attempts: p.attempts })),
  }));
}
export async function resetTraining(ctx: ActorContext, userId: string) {
  return withTx(async (tx) => {
    await tx.training_progress.deleteMany({ where: { user_id: userId } });
    await tx.users.update({ where: { id: userId }, data: { training_completed_at: null, training_completed_by: null } });
    await audit(tx, ctx, { action: 'training.reset', entity_type: 'user', entity_id: userId });
    return { ok: true as const };
  });
}
export async function waiveTraining(ctx: ActorContext, userId: string, reason: string) {
  return withTx(async (tx) => {
    await tx.users.update({ where: { id: userId }, data: { training_completed_at: new Date(), training_completed_by: ctx.userId } });
    await audit(tx, ctx, { action: 'training.waived', entity_type: 'user', entity_id: userId, reason });
    return { ok: true as const };
  });
}

/** Printable sheet with every barcode used in the school: locations and practice products. Print once, laminate. */
export async function practiceLabelsHtml(): Promise<string> {
  const bwipjs = (await import('bwip-js')).default;
  const school = await withTx((tx) => ensureSchool(tx));
  const png = async (text: string) => `data:image/png;base64,${(await bwipjs.toBuffer({ bcid: 'code128', text, scale: 2, height: 10, includetext: true, textxalign: 'center' })).toString('base64')}`;
  const items: { title: string; code: string; note: string }[] = [
    { title: 'Andén de recibo', code: school.dock.barcode, note: 'Recibir · llegada de pallets' },
    { title: 'Staging / estación de armado', code: school.staging.barcode, note: 'Staging · Armado' },
    { title: 'Andén de embarque', code: school.ship.barcode, note: 'Cargar' },
    ...school.reserve.map((l) => ({ title: `Rack escuela ${l.code.replace('ESC-ALM-', '')}`, code: l.barcode, note: 'Reserva · Ubicar / Traslados / Conteo' })),
    ...school.picking.map((l) => ({ title: `Picking escuela ${l.code.replace('ESC-PCK-', '')}`, code: l.barcode, note: 'Reabasto · Surtir' })),
    ...school.skus.flatMap((s) => [
      { title: `${s.code} · pieza`, code: s.piece, note: 'Escanear como producto (pieza)' },
      { title: `${s.code} · caja (${s.case_qty} pzas)`, code: s.case, note: 'Escanear como caja' },
    ]),
  ];
  const cells = await Promise.all(items.map(async (i) => `<div class="l"><div class="t">${i.title}</div><img src="${await png(i.code)}" alt="${i.code}"><div class="n">${i.note}</div></div>`));
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Etiquetas de práctica · Almacén escuela</title>
<style>body{font-family:Arial,sans-serif;margin:12mm}h1{font-size:18px;margin:0 0 4px}p{margin:0 0 10px;color:#444;font-size:12px}.g{display:grid;grid-template-columns:repeat(3,1fr);gap:6mm}.l{border:1px dashed #999;padding:4mm;text-align:center;break-inside:avoid}.t{font-weight:700;font-size:13px}.n{font-size:11px;color:#555}img{max-width:100%;margin:3px 0}@media print{h1,p{display:none}}</style></head>
<body><h1>Etiquetas de práctica · Almacén escuela (ESCUELA)</h1><p>Imprime esta hoja una vez, recorta y pega en el área de capacitación. Todo lo que se escanee con estas etiquetas ocurre en el almacén escuela, nunca en el inventario real.</p><div class="g">${cells.join('')}</div></body></html>`;
}

/**
 * Empties the school: practice pallets are written off (ADJUST_OUT, audited), open practice documents are cancelled,
 * staging lanes released. The ledger stays append-only; nothing outside the school warehouse is touched.
 */
export async function resetSchool(ctx: ActorContext, reason: string) {
  return withTx(async (tx) => {
    const school = await ensureSchool(tx);
    const wh = school.warehouse_id;
    const inTransit = await tx.$queryRaw<{ id: string }[]>`SELECT t.id FROM transfers t JOIN lpns l ON l.id = t.lpn_id WHERE l.warehouse_id = ${wh}::uuid AND t.status = 'IN_TRANSIT'`;
    for (const t of inTransit) await cancelTransfer(tx, ctx, t.id, `Reset escuela: ${reason}`);
    await tx.$executeRaw`UPDATE replenishment_tasks SET status = 'CANCELLED', completed_at = now() WHERE status IN ('PENDING','IN_PROGRESS') AND to_location_id IN (SELECT id FROM locations WHERE warehouse_id = ${wh}::uuid)`;
    await tx.$executeRaw`UPDATE putaway_tasks SET status = 'CANCELLED' WHERE status IN ('PENDING','ASSIGNED','IN_PROGRESS') AND lpn_id IN (SELECT id FROM lpns WHERE warehouse_id = ${wh}::uuid)`;
    await tx.$executeRaw`UPDATE count_tasks SET status = 'CLOSED', completed_at = now() WHERE status IN ('PENDING','IN_PROGRESS','RECOUNT','PENDING_APPROVAL') AND created_by IN (${TRAINER.userId}::uuid)`;
    await tx.$executeRaw`UPDATE receipts SET status = 'CANCELLED', closed_at = now() WHERE status IN ('OPEN','IN_PROGRESS') AND receiving_location_id IN (SELECT id FROM locations WHERE warehouse_id = ${wh}::uuid)`;
    const orders = await tx.orders.findMany({ where: { customer: { code: school.customer.code }, status: { notIn: ['SHIPPED', 'CANCELLED'] } }, select: { id: true } });
    for (const o of orders) {
      await tx.pick_tasks.updateMany({ where: { order_id: o.id, status: { in: ['PENDING', 'IN_PROGRESS'] } }, data: { status: 'CANCELLED' } });
      await tx.verifications.updateMany({ where: { order_id: o.id, status: 'IN_PROGRESS' }, data: { status: 'CANCELLED', completed_at: new Date() } });
      await tx.allocations.updateMany({ where: { order_line: { order_id: o.id }, status: 'ACTIVE' }, data: { status: 'RELEASED' } });
      await tx.staging_assignments.updateMany({ where: { order_id: o.id, released_at: null }, data: { released_at: new Date() } });
      await tx.orders.update({ where: { id: o.id }, data: { status: 'CANCELLED', version: { increment: 1 } } });
    }
    await tx.$executeRaw`UPDATE shipments SET status = 'CANCELLED' WHERE status IN ('OPEN','LOADING','LOADED','BLOCKED') AND dock_location_id IN (SELECT id FROM locations WHERE warehouse_id = ${wh}::uuid)`;
    const lpns = await tx.lpns.findMany({ where: { warehouse_id: wh, status: { notIn: ['SHIPPED', 'CANCELLED', 'CONSUMED'] } }, select: { id: true } });
    let written = 0n;
    for (const l of lpns) {
      const lpn = await lockLpn(tx, l.id);
      for (const c of await lpnContents(tx, lpn.id)) {
        await removeInventory(tx, ctx, { movement_type: 'ADJUST_OUT', from_lpn: lpn, sku_id: c.sku_id, qty: c.qty, status: c.status, reference_type: 'training_reset', reason: `Reset escuela: ${reason}` });
        written += c.qty;
      }
      await tx.lpns.update({ where: { id: lpn.id }, data: { status: 'CANCELLED', version: { increment: 1 } } });
    }
    await audit(tx, ctx, { action: 'training.school_reset', entity_type: 'warehouse', entity_id: wh, after: { lpns: lpns.length, pieces: written.toString(), orders: orders.length, transfers: inTransit.length }, reason });
    return { ok: true as const, lpns: lpns.length, pieces: written.toString(), orders: orders.length };
  });
}
