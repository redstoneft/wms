// Tasks an operator creates for themself from the handheld, always stating the purpose ("para qué").
// Pick: the order is accepted/allocated if needed and the pick task is assigned to the operator.
// Count: a blind location count assigned to the operator. Put-away: a task for a pallet left without one.
import type { SelfTaskInput } from '@wms/shared';
import type { Tx } from '../../db.js';
import { ForbiddenError, NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import { lockLpnByCode } from '../../inventory/ledger.js';
import { createCountTask } from '../counts/service.js';
import { acceptOrder, allocateOrder } from '../orders/service.js';
import { createPickTask } from '../picking/service.js';
import { createPutawayTask } from '../putaway/service.js';

export async function createSelfTask(tx: Tx, ctx: ActorContext, input: SelfTaskInput) {
  const purpose = input.purpose.trim();
  // the kind must match what the operator is allowed to execute
  const needs: Record<SelfTaskInput['kind'], 'picking.execute' | 'counts.execute' | 'putaway.execute'> = { PICK: 'picking.execute', COUNT: 'counts.execute', PUTAWAY: 'putaway.execute' };
  if (!ctx.permissions.has(needs[input.kind])) throw new ForbiddenError(`Your role cannot execute ${input.kind} tasks`);
  switch (input.kind) {
    case 'PICK': {
      const number = input.reference.trim().toUpperCase();
      const order = await tx.orders.findFirst({ where: { order_number: { equals: number, mode: 'insensitive' } } });
      if (!order) throw new NotFoundError('order', number);
      if (order.status === 'IMPORTED') await acceptOrder(tx, ctx, order.id);
      const fresh = await tx.orders.findUniqueOrThrow({ where: { id: order.id } });
      if (['ACCEPTED', 'PARTIALLY_ALLOCATED'].includes(fresh.status)) await allocateOrder(tx, ctx, { order_id: order.id, allow_partial: true });
      const r = await createPickTask(tx, ctx, order.id, ctx.userId);
      await tx.pick_tasks.update({ where: { id: r.task.id }, data: { purpose } });
      await audit(tx, ctx, { action: 'task.self_created', entity_type: 'pick_task', entity_id: r.task.id, after: { kind: 'PICK', order: fresh.order_number, lines: r.lines, staging: r.staging.code }, reason: purpose });
      return { kind: 'PICK' as const, id: r.task.id, order_number: fresh.order_number, lines: r.lines, staging: r.staging.code, next: '/wm/pick' };
    }
    case 'COUNT': {
      const task = await createCountTask(tx, ctx, { count_type: 'LOCATION', location_barcodes: [input.reference.trim()], assigned_to: ctx.userId, is_blind: true, notes: purpose });
      await audit(tx, ctx, { action: 'task.self_created', entity_type: 'count_task', entity_id: task.id, after: { kind: 'COUNT', location: input.reference.trim() }, reason: purpose });
      return { kind: 'COUNT' as const, id: task.id, next: '/wm/count' };
    }
    case 'PUTAWAY': {
      const lpn = await lockLpnByCode(tx, input.reference.trim().toUpperCase());
      if (['SHIPPED', 'CANCELLED', 'CONSUMED'].includes(lpn.status)) throw new RuleError('LPN_FROZEN', `LPN ${lpn.code} is ${lpn.status}`);
      const task = await createPutawayTask(tx, ctx, lpn);
      await tx.putaway_tasks.update({ where: { id: task.id }, data: { purpose, assigned_to: ctx.userId } });
      await audit(tx, ctx, { action: 'task.self_created', entity_type: 'putaway_task', entity_id: task.id, after: { kind: 'PUTAWAY', lpn: lpn.code, suggested: task.suggested_location_id }, reason: purpose });
      return { kind: 'PUTAWAY' as const, id: task.id, lpn: lpn.code, next: '/wm/putaway' };
    }
  }
}
