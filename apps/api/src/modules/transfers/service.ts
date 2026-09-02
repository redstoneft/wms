import type { Tx } from '../../db.js';
import { ConflictError, NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import { lockBalances, lockLocation, lockLocationByBarcode, lockLpn, lockLpnByCode, moveLpn, recordMovement } from '../../inventory/ledger.js';
import { checkLocationAccepts } from '../../inventory/location-rules.js';

/**
 * Transfers are two-phase so inventory never "disappears":
 *   start    : AVAILABLE@origin  → IN_TRANSFER@origin  (LPN status IN_TRANSFER, destination reserved)
 *   complete : IN_TRANSFER@origin → AVAILABLE@destination (scan at destination must match)
 *   cancel   : IN_TRANSFER@origin → AVAILABLE@origin
 * Only AVAILABLE inventory can be transferred; allocated/picking/quarantine stock is protected.
 */
export async function startTransfer(tx: Tx, ctx: ActorContext, input: { lpn_code: string; to_location_barcode: string; reason?: string; transfer_type?: 'LOCATION' | 'REPLENISHMENT' }) {
  const lpn = await lockLpnByCode(tx, input.lpn_code);
  if (lpn.status !== 'STORED') throw new RuleError('LPN_STATUS', `LPN ${lpn.code} is ${lpn.status}; only stored pallets can be transferred`);
  if (!lpn.current_location_id) throw new RuleError('LPN_NO_LOCATION', `LPN ${lpn.code} has no location`);
  const to = await lockLocationByBarcode(tx, input.to_location_barcode);
  if (to.id === lpn.current_location_id) throw new RuleError('SAME_LOCATION', 'Destination equals current location');
  if (!['RESERVE', 'PICKING', 'QUARANTINE', 'DAMAGED', 'RETURNS'].includes(to.location_type)) {
    throw new RuleError('LOCATION_TYPE', `Cannot transfer into a ${to.location_type} location`);
  }
  const balances = await lockBalances(tx, lpn.id);
  if (balances.length === 0) throw new RuleError('EMPTY_LPN', `LPN ${lpn.code} is empty`);
  const notAvailable = balances.filter((b) => b.status !== 'AVAILABLE');
  if (notAvailable.length) {
    throw new RuleError('LPN_NOT_AVAILABLE', `LPN ${lpn.code} has inventory in ${[...new Set(notAvailable.map((b) => b.status))].join(', ')}; release/deallocate first`);
  }
  const fit = await checkLocationAccepts(tx, to, lpn);
  if (!fit.ok) throw new RuleError('LOCATION_REJECTED', `Location ${to.code} cannot accept LPN ${lpn.code}: ${fit.reasons.join(', ')}`, fit);

  const crossWarehouse = to.warehouse_id !== lpn.warehouse_id;
  const transfer = await tx.transfers.create({
    data: { transfer_type: crossWarehouse ? 'WAREHOUSE' : (input.transfer_type ?? 'LOCATION'), lpn_id: lpn.id, from_location_id: lpn.current_location_id, to_location_id: to.id, started_by: ctx.userId, reason: input.reason ?? null },
  });
  for (const b of balances) {
    await recordMovement(tx, ctx, {
      movement_type: input.transfer_type === 'REPLENISHMENT' ? 'REPLENISH_START' : 'TRANSFER_START',
      sku_id: b.sku_id,
      qty: b.qty,
      from_lpn_id: lpn.id,
      to_lpn_id: lpn.id,
      from_location_id: lpn.current_location_id,
      to_location_id: lpn.current_location_id,
      from_status: 'AVAILABLE',
      to_status: 'IN_TRANSFER',
      transfer_id: transfer.id,
      reference_type: 'transfer',
      reference_id: transfer.id,
      reason: input.reason ?? null,
      idempotency_suffix: `TSTART:${lpn.id}:${b.sku_id}`,
    });
  }
  await tx.lpns.update({ where: { id: lpn.id }, data: { status: 'IN_TRANSFER', version: { increment: 1 } } });
  await audit(tx, ctx, { action: 'transfer.start', entity_type: 'transfer', entity_id: transfer.id, after: { lpn: lpn.code, from: lpn.current_location_id, to: to.code }, reason: input.reason ?? null });
  return { transfer, lpn_code: lpn.code, to_location: { id: to.id, code: to.code, barcode: to.barcode } };
}

export async function completeTransfer(tx: Tx, ctx: ActorContext, input: { transfer_id: string; lpn_code: string; location_barcode: string }) {
  const rows = await tx.$queryRaw<{ id: string; lpn_id: string; to_location_id: string; from_location_id: string; status: string; transfer_type: string }[]>`
    SELECT id, lpn_id, to_location_id, from_location_id, status, transfer_type FROM transfers WHERE id = ${input.transfer_id}::uuid FOR UPDATE`;
  const t = rows[0];
  if (!t) throw new NotFoundError('transfer', input.transfer_id);
  if (t.status === 'COMPLETED') throw new ConflictError('TRANSFER_COMPLETED', 'Transfer already completed');
  if (t.status !== 'IN_TRANSIT') throw new RuleError('TRANSFER_STATUS', `Transfer is ${t.status}`);
  const lpn = await lockLpn(tx, t.lpn_id);
  if (lpn.code !== input.lpn_code.trim().toUpperCase()) throw new RuleError('WRONG_LPN', `Scanned LPN ${input.lpn_code} does not belong to this transfer (${lpn.code})`);
  const scanned = await lockLocationByBarcode(tx, input.location_barcode);
  if (scanned.id !== t.to_location_id) {
    const expected = await tx.locations.findUnique({ where: { id: t.to_location_id } });
    throw new RuleError('WRONG_LOCATION', `UBICACIÓN INCORRECTA: expected ${expected?.code}, scanned ${scanned.code}`, { expected: expected?.code, scanned: scanned.code });
  }
  const fit = await checkLocationAccepts(tx, scanned, lpn);
  if (!fit.ok) throw new RuleError('LOCATION_REJECTED', `Location ${scanned.code} can no longer accept LPN ${lpn.code}: ${fit.reasons.join(', ')}`, fit);
  const toStatus = scanned.location_type === 'QUARANTINE' ? 'QUARANTINE' : scanned.location_type === 'DAMAGED' ? 'DAMAGED' : 'AVAILABLE';
  const movements = await moveLpn(tx, ctx, {
    movement_type: t.transfer_type === 'REPLENISHMENT' ? 'REPLENISH_COMPLETE' : 'TRANSFER_COMPLETE',
    lpn,
    to_location_id: scanned.id,
    only_status: 'IN_TRANSFER',
    to_status: toStatus,
    transfer_id: t.id,
    reference_type: 'transfer',
    reference_id: t.id,
  });
  await tx.transfers.update({ where: { id: t.id }, data: { status: 'COMPLETED', completed_by: ctx.userId, completed_at: new Date() } });
  // warehouse → warehouse: the pallet now belongs to the destination warehouse
  await tx.lpns.update({ where: { id: lpn.id }, data: { status: 'STORED', warehouse_id: scanned.warehouse_id, version: { increment: 1 } } });
  await tx.replenishment_tasks.updateMany({ where: { transfer_id: t.id, status: 'IN_PROGRESS' }, data: { status: 'COMPLETED', completed_at: new Date() } });
  await audit(tx, ctx, { action: 'transfer.complete', entity_type: 'transfer', entity_id: t.id, after: { lpn: lpn.code, location: scanned.code, movements: movements.map(String) } });
  return { transfer_id: t.id, lpn_code: lpn.code, location: scanned.code, movements };
}

export async function cancelTransfer(tx: Tx, ctx: ActorContext, transferId: string, reason: string) {
  const rows = await tx.$queryRaw<{ id: string; lpn_id: string; from_location_id: string; status: string }[]>`
    SELECT id, lpn_id, from_location_id, status FROM transfers WHERE id = ${transferId}::uuid FOR UPDATE`;
  const t = rows[0];
  if (!t) throw new NotFoundError('transfer', transferId);
  if (t.status !== 'IN_TRANSIT') throw new RuleError('TRANSFER_STATUS', `Transfer is ${t.status}`);
  const lpn = await lockLpn(tx, t.lpn_id);
  const balances = await lockBalances(tx, lpn.id);
  for (const b of balances.filter((x) => x.status === 'IN_TRANSFER')) {
    await recordMovement(tx, ctx, {
      movement_type: 'TRANSFER_CANCEL',
      sku_id: b.sku_id,
      qty: b.qty,
      from_lpn_id: lpn.id,
      to_lpn_id: lpn.id,
      from_location_id: lpn.current_location_id,
      to_location_id: lpn.current_location_id,
      from_status: 'IN_TRANSFER',
      to_status: 'AVAILABLE',
      transfer_id: t.id,
      reason,
      idempotency_suffix: `TCANCEL:${lpn.id}:${b.sku_id}`,
    });
  }
  await tx.transfers.update({ where: { id: t.id }, data: { status: 'CANCELLED', completed_by: ctx.userId, completed_at: new Date(), reason } });
  await tx.lpns.update({ where: { id: lpn.id }, data: { status: 'STORED', version: { increment: 1 } } });
  await tx.replenishment_tasks.updateMany({ where: { transfer_id: t.id, status: 'IN_PROGRESS' }, data: { status: 'PENDING', transfer_id: null } });
  await audit(tx, ctx, { action: 'transfer.cancel', entity_type: 'transfer', entity_id: t.id, reason });
  return { ok: true, lpn_code: lpn.code };
}

export { lockLocation };
