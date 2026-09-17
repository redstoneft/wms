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
      if (!order) {
        if (!input.new_order) throw new NotFoundError('order', number);
        // a brand-new order built on the floor: free picking (scan pallets whenever, close when done)
        const customer = await tx.customers.findUnique({ where: { code: input.new_order.customer_code } });
        if (!customer) throw new NotFoundError('customer', input.new_order.customer_code);
        const created = await tx.orders.create({ data: { order_number: number, customer_id: customer.id, destination: input.new_order.destination ?? null, order_date: new Date(), status: 'ACCEPTED', source: 'MANUAL', notes: purpose, created_by: ctx.userId } });
        const task = await tx.pick_tasks.create({ data: { order_id: created.id, assigned_to: ctx.userId, mode: 'FREE', purpose } });
        await audit(tx, ctx, { action: 'order.create', entity_type: 'order', entity_id: created.id, after: { order_number: number, customer: customer.code, source: 'MANUAL', free_pick: true }, reason: purpose });
        await audit(tx, ctx, { action: 'task.self_created', entity_type: 'pick_task', entity_id: task.id, after: { kind: 'PICK', mode: 'FREE', order: number }, reason: purpose });
        return { kind: 'PICK' as const, id: task.id, mode: 'FREE' as const, order_number: number, lines: 0, staging: null, next: '/wm/pick' };
      }
      // an open free-pick task of this order that is already mine: just continue it
      const mine = await tx.pick_tasks.findFirst({ where: { order_id: order.id, mode: 'FREE', status: { in: ['PENDING', 'IN_PROGRESS'] } } });
      if (mine) {
        if (mine.assigned_to && mine.assigned_to !== ctx.userId) throw new RuleError('TASK_TAKEN', `Order ${order.order_number} is being picked by someone else`);
        return { kind: 'PICK' as const, id: mine.id, mode: 'FREE' as const, order_number: order.order_number, lines: 0, staging: null, next: '/wm/pick' };
      }
      if (order.status === 'IMPORTED') await acceptOrder(tx, ctx, order.id);
      const fresh = await tx.orders.findUniqueOrThrow({ where: { id: order.id } });
      if (['ACCEPTED', 'PARTIALLY_ALLOCATED'].includes(fresh.status)) await allocateOrder(tx, ctx, { order_id: order.id, allow_partial: true });
      const r = await createPickTask(tx, ctx, order.id, ctx.userId);
      await tx.pick_tasks.update({ where: { id: r.task.id }, data: { purpose } });
      await audit(tx, ctx, { action: 'task.self_created', entity_type: 'pick_task', entity_id: r.task.id, after: { kind: 'PICK', order: fresh.order_number, lines: r.lines, staging: r.staging.code }, reason: purpose });
      return { kind: 'PICK' as const, id: r.task.id, mode: 'ALLOCATED' as const, order_number: fresh.order_number, lines: r.lines, staging: r.staging.code, next: '/wm/pick' };
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
