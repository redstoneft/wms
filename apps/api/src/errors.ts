import { sqlMessage, sqlState } from './db.js';

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
  }
}
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', details?: unknown) {
    super(403, 'FORBIDDEN', message, details);
  }
}
export class NotFoundError extends AppError {
  constructor(entity: string, id?: string) {
    super(404, 'NOT_FOUND', id ? `${entity} '${id}' not found` : `${entity} not found`);
  }
}
export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(409, code, message, details);
  }
}
import type { Tx } from './db.js';

/**
 * Business rule violation: the request is well-formed but not allowed by WMS rules.
 * Blocked attempts must remain traceable even though the business transaction is
 * rolled back: services attach side effects (audit rows, incidents, status marks)
 * with `persistAfterRollback`; the global error handler runs them in a fresh
 * transaction after the failed one is gone.
 */
export class RuleError extends AppError {
  readonly afterRollback: Array<(tx: Tx) => Promise<void>> = [];
  constructor(code: string, message: string, details?: unknown) {
    super(422, code, message, details);
  }
  persistAfterRollback(fn: (tx: Tx) => Promise<void>): this {
    this.afterRollback.push(fn);
    return this;
  }
}

/**
 * Maps database-level failures (our triggers and constraints) to API errors so
 * the operator always gets an actionable message and the transaction is gone.
 */
export function translateDbError(e: unknown): AppError | null {
  const state = sqlState(e);
  const raw = sqlMessage(e);
  // raw PostgreSQL text (constraint names, ids) is useful for operators in dev/test but is information leakage in production
  const msg = process.env.NODE_ENV === 'production' ? '' : raw;
  if (!state) return null;
  switch (state) {
    case 'P0002':
      return new RuleError('INSUFFICIENT_INVENTORY', 'Insufficient inventory for this operation', { db: msg });
    case 'P0003':
      return new RuleError('INVALID_MOVEMENT', msg.replace(/^.*INVALID_MOVEMENT:\s*/, ''), { db: msg });
    case 'P0004':
      return new RuleError('LPN_FROZEN', 'LPN is shipped or cancelled and cannot change', { db: msg });
    case 'P0001':
      return new ForbiddenError('Append-only data cannot be modified', { db: msg });
    case '23514': {
      // check_violation
      const msg = raw;
      if (/ck_balance_qty_nonneg/.test(msg)) {
        return new RuleError('INSUFFICIENT_INVENTORY', 'Inventory would become negative; operation rejected', { db: msg });
      }
      if (/ck_ol_/.test(msg)) {
        return new RuleError('ORDER_LINE_QUANTITY_RULE', 'Order line quantity rule violated (picked ≤ required, verified ≤ picked, loaded ≤ verified)', { db: msg });
      }
      return new RuleError('CONSTRAINT_VIOLATION', 'Database rule violated', { db: msg });
    }
    case 'P2025':
      return new NotFoundError('record');
    case 'P2028':
    case 'P2024':
      return new AppError(503, 'SERVICE_BUSY', 'The system is busy, please retry in a moment');
    case 'P2003':
      return new RuleError('REFERENCE_ERROR', 'Referenced record does not exist or is still referenced', { db: msg });
    case 'P2002':
    case '23505': {
      // unique_violation
      const msg = raw;
      if (/ux_authorizations_once/.test(msg)) return new ConflictError('ALREADY_AUTHORIZED', 'This exception was already authorized by another supervisor');
      if (/ux_transfers_one_active_per_lpn/.test(msg)) return new ConflictError('TRANSFER_IN_PROGRESS', 'LPN already has a transfer in progress');
      if (/ux_putaway_one_active_per_lpn/.test(msg)) return new ConflictError('PUTAWAY_IN_PROGRESS', 'LPN already has an active put-away task');
      if (/ux_pick_task_one_active_per_order/.test(msg)) return new ConflictError('PICK_TASK_EXISTS', 'Order already has an active pick task');
      if (/ux_verification_one_active_per_order/.test(msg)) return new ConflictError('VERIFICATION_IN_PROGRESS', 'Order already has a verification in progress');
      if (/ux_movements_idempotency/.test(msg)) return new ConflictError('DUPLICATE_MOVEMENT', 'This movement was already recorded (duplicate request)');
      if (/ux_import_jobs_applied_once/.test(msg)) return new ConflictError('IMPORT_ALREADY_APPLIED', 'This exact file was already imported');
      if (/idempotency_keys_pkey/.test(msg)) return new ConflictError('IDEMPOTENT_REPLAY', 'Duplicate request');
      return new ConflictError('DUPLICATE', 'A record with the same unique value already exists', { db: msg });
    }
    case '22021':
    case '22P02':
    case '22001':
    case '22003':
      return new ValidationError('Invalid input value for the database', { db: msg });
    case '23503':
      return new RuleError('REFERENCE_ERROR', 'Referenced record does not exist or is still referenced', { db: msg });
    case '40001':
    case '40P01':
      return new ConflictError('CONCURRENT_MODIFICATION', 'Concurrent modification detected, please retry');
    case '55P03':
      return new ConflictError('LOCKED', 'Record is locked by another operation, please retry');
    default:
      return null;
  }
}
