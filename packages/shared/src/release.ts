// THE ABSOLUTE RELEASE RULE.
// A shipment may only be released when, for EVERY order and EVERY SKU line,
// loaded == required. Totals are irrelevant. Shared between API (enforcement)
// and UI (explanation).

export interface ReleaseLineInput {
  order_number: string;
  sku_code: string;
  required_qty: bigint;
  picked_qty: bigint;
  verified_qty: bigint;
  loaded_qty: bigint;
}

export interface ReleaseLineResult extends ReleaseLineInput {
  ok: boolean;
  problems: ReleaseProblem[];
}

export type ReleaseProblem =
  | 'SHORT_LOADED'
  | 'OVER_LOADED'
  | 'NOT_PICKED'
  | 'NOT_VERIFIED'
  | 'SKU_OMITTED';

export interface ReleaseCheckInput {
  lines: ReleaseLineInput[];
  /** loaded SKUs that are not on any order line of the shipment */
  unexpected_loaded: { order_number: string | null; sku_code: string; qty: bigint }[];
  open_critical_incidents: number;
  orders_not_verified: string[];
  verification_incomplete: string[];
}

export interface ReleaseCheckResult {
  can_release: boolean;
  lines: ReleaseLineResult[];
  blocking_reasons: string[];
  totals: { required: bigint; loaded: bigint };
}

export function evaluateRelease(input: ReleaseCheckInput): ReleaseCheckResult {
  const reasons: string[] = [];
  let required = 0n;
  let loaded = 0n;

  const lines: ReleaseLineResult[] = input.lines.map((l) => {
    const problems: ReleaseProblem[] = [];
    required += l.required_qty;
    loaded += l.loaded_qty;
    if (l.loaded_qty === 0n && l.required_qty > 0n) problems.push('SKU_OMITTED');
    else if (l.loaded_qty < l.required_qty) problems.push('SHORT_LOADED');
    if (l.loaded_qty > l.required_qty) problems.push('OVER_LOADED');
    if (l.picked_qty < l.required_qty) problems.push('NOT_PICKED');
    if (l.verified_qty < l.required_qty) problems.push('NOT_VERIFIED');
    return { ...l, ok: problems.length === 0, problems };
  });

  for (const l of lines) {
    for (const p of l.problems) {
      reasons.push(`${l.order_number} / ${l.sku_code}: ${p} (required=${l.required_qty} picked=${l.picked_qty} verified=${l.verified_qty} loaded=${l.loaded_qty})`);
    }
  }
  for (const u of input.unexpected_loaded) {
    reasons.push(`${u.order_number ?? '?'} / ${u.sku_code}: WRONG_SKU loaded (${u.qty}) not required by shipment`);
  }
  if (input.open_critical_incidents > 0) reasons.push(`${input.open_critical_incidents} open CRITICAL/HIGH incident(s) linked to this shipment`);
  for (const o of input.orders_not_verified) reasons.push(`${o}: order not verified by a second person`);
  for (const o of input.verification_incomplete) reasons.push(`${o}: verification incomplete`);
  if (lines.length === 0) reasons.push('shipment has no order lines');

  return {
    can_release: reasons.length === 0,
    lines,
    blocking_reasons: reasons,
    totals: { required, loaded },
  };
}
