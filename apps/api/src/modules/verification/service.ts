import type { UomCode } from '@wms/shared';
import type { Tx } from '../../db.js';
import { ConflictError, NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import { resolveSkuBarcode, toBaseQty } from '../../lib/lookup.js';
import { consumeAuthorization } from '../authorizations/routes.js';
import { createIncident } from '../incidents/service.js';

/**
 * Second-person verification. The verifier must differ from the picker; a
 * supervisor can authorize the exception (SAME_USER_VERIFICATION) which is
 * recorded on the verification. The verifier scans every staged LPN and its
 * contents blind; expected quantities come from the ledger (STAGING status).
 */
export async function startVerification(tx: Tx, ctx: ActorContext, input: { order_id: string; authorization_id?: string }) {
  const orows = await tx.$queryRaw<{ id: string; status: string; picker_id: string | null; order_number: string }[]>`SELECT id, status, picker_id, order_number FROM orders WHERE id = ${input.order_id}::uuid FOR UPDATE`;
  const order = orows[0];
  if (!order) throw new NotFoundError('order', input.order_id);
  if (order.status !== 'STAGED') throw new RuleError('ORDER_STATUS', `Order is ${order.status}; it must be fully staged before verification`);
  const active = await tx.verifications.findFirst({ where: { order_id: order.id, status: 'IN_PROGRESS' } });
  if (active) throw new ConflictError('VERIFICATION_IN_PROGRESS', 'A verification is already in progress for this order');
  let authId: string | null = null;
  if (order.picker_id === ctx.userId) {
    if (!input.authorization_id) {
      throw new RuleError('SAME_USER', 'SURTIDOR = VERIFICADOR: the picker cannot verify their own order. A supervisor authorization (SAME_USER_VERIFICATION) is required.', { picker_id: order.picker_id });
    }
    await consumeAuthorization(tx, input.authorization_id, { exception_type: 'SAME_USER_VERIFICATION', entity_type: 'order', entity_id: order.id });
    authId = input.authorization_id;
  }
  const expected = await tx.$queryRaw<{ lpn_id: string; sku_id: string; qty: bigint }[]>`
    SELECT b.lpn_id, b.sku_id, b.qty FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id
     WHERE l.order_id = ${order.id}::uuid AND l.status = 'STAGED' AND b.status = 'STAGING' AND b.qty > 0`;
  if (!expected.length) throw new RuleError('NOTHING_STAGED', 'No staged inventory found for this order');
  const v = await tx.verifications.create({
    data: { order_id: order.id, verifier_id: ctx.userId, same_user_authorization_id: authId, lines: { create: expected.map((e) => ({ sku_id: e.sku_id, lpn_id: e.lpn_id, expected_qty: e.qty })) } },
  });
  await audit(tx, ctx, { action: 'verification.start', entity_type: 'order', entity_id: order.id, after: { verification_id: v.id, same_user_authorized: !!authId, lines: expected.length } });
  return { verification_id: v.id, order_number: order.order_number, lpn_count: new Set(expected.map((e) => e.lpn_id)).size, same_user_authorized: !!authId };
}

export async function verifyScan(tx: Tx, ctx: ActorContext, input: { verification_id: string; lpn_code: string; barcode: string; qty: bigint; uom_code?: UomCode }) {
  const vrows = await tx.$queryRaw<{ id: string; status: string; verifier_id: string; order_id: string }[]>`SELECT id, status, verifier_id, order_id FROM verifications WHERE id = ${input.verification_id}::uuid FOR UPDATE`;
  const v = vrows[0];
  if (!v) throw new NotFoundError('verification', input.verification_id);
  if (v.status !== 'IN_PROGRESS') throw new RuleError('VERIFICATION_STATUS', `Verification is ${v.status}`);
  if (v.verifier_id !== ctx.userId) throw new ConflictError('NOT_YOUR_VERIFICATION', 'Another verifier owns this verification');
  const lpn = await tx.lpns.findUnique({ where: { code: input.lpn_code.toUpperCase() } });
  if (!lpn) throw new NotFoundError('LPN', input.lpn_code);
  if (lpn.order_id !== v.order_id) {
    await audit(tx, ctx, { action: 'verification.blocked_wrong_lpn', entity_type: 'verification', entity_id: v.id, after: { scanned: lpn.code } });
    throw new RuleError('WRONG_LPN', `LPN ${lpn.code} does not belong to this order`);
  }
  const { sku, uom_code } = await resolveSkuBarcode(tx, input.barcode);
  const { base } = await toBaseQty(tx, sku.id, input.qty, input.uom_code ?? uom_code);
  const line = await tx.verification_lines.findFirst({ where: { verification_id: v.id, lpn_id: lpn.id, sku_id: sku.id } });
  if (!line) {
    await audit(tx, ctx, { action: 'verification.blocked_wrong_sku', entity_type: 'verification', entity_id: v.id, after: { lpn: lpn.code, sku: sku.code } });
    throw new RuleError('WRONG_SKU', `SKU ${sku.code} is not expected in LPN ${lpn.code}`);
  }
  if (line.scanned_qty + base > line.expected_qty) {
    await audit(tx, ctx, { action: 'verification.blocked_qty_exceeded', entity_type: 'verification', entity_id: v.id, after: { lpn: lpn.code, sku: sku.code, scanned: (line.scanned_qty + base).toString(), expected: line.expected_qty.toString() } });
    throw new RuleError('QTY_EXCEEDED', `Scanned more ${sku.code} than picked in ${lpn.code}`, { expected: line.expected_qty, already: line.scanned_qty, scanned: base });
  }
  const updated = await tx.verification_lines.update({ where: { id: line.id }, data: { scanned_qty: { increment: base } } });
  await audit(tx, ctx, { action: 'verification.scan', entity_type: 'verification', entity_id: v.id, after: { lpn: lpn.code, sku: sku.code, qty: base.toString() } });
  return { line_id: line.id, sku: sku.code, lpn: lpn.code, scanned: updated.scanned_qty, complete: updated.scanned_qty === updated.expected_qty };
}

export async function completeVerification(tx: Tx, ctx: ActorContext, verificationId: string) {
  const vrows = await tx.$queryRaw<{ id: string; status: string; verifier_id: string; order_id: string }[]>`SELECT id, status, verifier_id, order_id FROM verifications WHERE id = ${verificationId}::uuid FOR UPDATE`;
  const v = vrows[0];
  if (!v) throw new NotFoundError('verification', verificationId);
  if (v.status !== 'IN_PROGRESS') throw new RuleError('VERIFICATION_STATUS', `Verification is ${v.status}`);
  if (v.verifier_id !== ctx.userId) throw new ConflictError('NOT_YOUR_VERIFICATION', 'Another verifier owns this verification');
  const lines = await tx.verification_lines.findMany({ where: { verification_id: v.id } });
  const mismatches = lines.filter((l) => l.scanned_qty !== l.expected_qty);
  // guard: staged inventory must still match what was expected when verification started
  const staged = await tx.$queryRaw<{ lpn_id: string; sku_id: string; qty: bigint }[]>`
    SELECT b.lpn_id, b.sku_id, b.qty FROM inventory_balances b JOIN lpns l ON l.id = b.lpn_id WHERE l.order_id = ${v.order_id}::uuid AND l.status = 'STAGED' AND b.status = 'STAGING' AND b.qty > 0`;
  const changed = staged.length !== lines.length || staged.some((s) => !lines.find((l) => l.lpn_id === s.lpn_id && l.sku_id === s.sku_id && l.expected_qty === s.qty));
  if (mismatches.length || changed) {
    await tx.verifications.update({ where: { id: v.id }, data: { status: 'FAILED', completed_at: new Date(), notes: changed ? 'Staged inventory changed during verification' : `${mismatches.length} line(s) mismatch` } });
    const order = await tx.orders.findUniqueOrThrow({ where: { id: v.order_id } });
    await createIncident(tx, ctx, { incident_type: 'PICKING_ERROR', severity: 'HIGH', title: `Verificación fallida pedido ${order.order_number}`, description: changed ? 'El inventario en staging cambió durante la verificación' : mismatches.map((m) => `sku ${m.sku_id} lpn ${m.lpn_id}: esperado ${m.expected_qty} verificado ${m.scanned_qty}`).join('\n'), entity_type: 'verification', entity_id: v.id, order_id: v.order_id });
    await audit(tx, ctx, { action: 'verification.failed', entity_type: 'order', entity_id: v.order_id, after: { verification_id: v.id, mismatches: mismatches.length, changed } });
    return { status: 'FAILED', mismatches: mismatches.map((m) => ({ lpn_id: m.lpn_id, sku_id: m.sku_id, expected: m.expected_qty, scanned: m.scanned_qty })), changed };
  }
  // PASSED: verified_qty per order line = picked_qty (all picked units were scanned)
  const bySku = new Map<string, bigint>();
  for (const l of lines) bySku.set(l.sku_id, (bySku.get(l.sku_id) ?? 0n) + l.scanned_qty);
  const orderLines = await tx.order_lines.findMany({ where: { order_id: v.order_id } });
  for (const ol of orderLines) {
    const verified = bySku.get(ol.sku_id) ?? 0n;
    await tx.order_lines.update({ where: { id: ol.id }, data: { verified_qty: verified < ol.picked_qty ? verified : ol.picked_qty } });
  }
  await tx.verifications.update({ where: { id: v.id }, data: { status: 'PASSED', completed_at: new Date() } });
  await tx.orders.update({ where: { id: v.order_id }, data: { status: 'VERIFIED', verifier_id: ctx.userId, verified_at: new Date(), version: { increment: 1 } } });
  await audit(tx, ctx, { action: 'verification.passed', entity_type: 'order', entity_id: v.order_id, after: { verification_id: v.id, lines: lines.length } });
  return { status: 'PASSED', lines: lines.length };
}

export async function verificationView(tx: Tx, verificationId: string, actor: ActorContext) {
  const v = await tx.verifications.findUnique({ where: { id: verificationId }, include: { order: { include: { customer: true } }, lines: true } });
  if (!v) throw new NotFoundError('verification', verificationId);
  const reveal = v.status !== 'IN_PROGRESS' || actor.permissions.has('verification.override_same_user');
  const lpns = await tx.lpns.findMany({ where: { id: { in: [...new Set(v.lines.map((l) => l.lpn_id).filter((x): x is string => !!x))] } }, select: { id: true, code: true } });
  const skus = await tx.skus.findMany({ where: { id: { in: [...new Set(v.lines.map((l) => l.sku_id))] } }, select: { id: true, code: true, description: true } });
  return {
    id: v.id,
    status: v.status,
    order: { id: v.order.id, order_number: v.order.order_number, customer: v.order.customer.name },
    verifier_id: v.verifier_id,
    started_at: v.started_at,
    completed_at: v.completed_at,
    lpns: lpns.map((l) => l.code),
    lines: v.lines.map((l) => ({
      id: l.id,
      lpn: lpns.find((x) => x.id === l.lpn_id)?.code ?? null,
      sku: skus.find((s) => s.id === l.sku_id)?.code ?? l.sku_id,
      description: skus.find((s) => s.id === l.sku_id)?.description ?? '',
      scanned_qty: l.scanned_qty,
      expected_qty: reveal ? l.expected_qty : null,
      complete: l.scanned_qty === l.expected_qty,
    })),
    progress: { scanned_lines: v.lines.filter((l) => l.scanned_qty === l.expected_qty).length, total_lines: v.lines.length },
  };
}
