import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { evaluateRelease, type ReleaseLineInput } from './release.js';

const line = (sku: string, required: bigint, loaded: bigint, picked = required, verified = required): ReleaseLineInput => ({
  order_number: 'PED-1',
  sku_code: sku,
  required_qty: required,
  picked_qty: picked,
  verified_qty: verified,
  loaded_qty: loaded,
});
const base = { unexpected_loaded: [], open_critical_incidents: 0, orders_not_verified: [], verification_incomplete: [] };

describe('THE ABSOLUTE RELEASE RULE', () => {
  it('releases only when every SKU has loaded == required', () => {
    const r = evaluateRelease({ ...base, lines: [line('A', 10n, 10n), line('B', 10n, 10n)] });
    expect(r.can_release).toBe(true);
    expect(r.blocking_reasons).toEqual([]);
  });

  it('BLOCKS the textbook case: totals match (20/20) but SKU-A=20, SKU-B=0', () => {
    const r = evaluateRelease({ ...base, lines: [line('A', 10n, 20n), line('B', 10n, 0n)] });
    expect(r.totals).toEqual({ required: 20n, loaded: 20n });
    expect(r.can_release).toBe(false);
    expect(r.lines[0]!.problems).toContain('OVER_LOADED');
    expect(r.lines[1]!.problems).toContain('SKU_OMITTED');
  });

  it('blocks shortages, overages, omitted SKUs, unverified, unpicked, wrong SKUs, incidents', () => {
    expect(evaluateRelease({ ...base, lines: [line('A', 10n, 9n)] }).lines[0]!.problems).toContain('SHORT_LOADED');
    expect(evaluateRelease({ ...base, lines: [line('A', 10n, 11n)] }).lines[0]!.problems).toContain('OVER_LOADED');
    expect(evaluateRelease({ ...base, lines: [line('A', 10n, 0n)] }).lines[0]!.problems).toContain('SKU_OMITTED');
    expect(evaluateRelease({ ...base, lines: [line('A', 10n, 10n, 10n, 5n)] }).lines[0]!.problems).toContain('NOT_VERIFIED');
    expect(evaluateRelease({ ...base, lines: [line('A', 10n, 10n, 8n, 8n)] }).lines[0]!.problems).toContain('NOT_PICKED');
    expect(evaluateRelease({ ...base, lines: [line('A', 10n, 10n)], unexpected_loaded: [{ order_number: 'PED-1', sku_code: 'Z', qty: 1n }] }).can_release).toBe(false);
    expect(evaluateRelease({ ...base, lines: [line('A', 10n, 10n)], open_critical_incidents: 1 }).can_release).toBe(false);
    expect(evaluateRelease({ ...base, lines: [line('A', 10n, 10n)], orders_not_verified: ['PED-1'] }).can_release).toBe(false);
    expect(evaluateRelease({ ...base, lines: [line('A', 10n, 10n)], verification_incomplete: ['PED-1'] }).can_release).toBe(false);
    expect(evaluateRelease({ ...base, lines: [] }).can_release).toBe(false);
  });

  it('property: can_release ⇔ every line loaded==required==picked==verified and no extra conditions', () => {
    const arbLine = fc.record({
      sku: fc.string({ minLength: 1, maxLength: 6 }),
      required: fc.bigInt({ min: 1n, max: 1000n }),
      picked: fc.bigInt({ min: 0n, max: 1000n }),
      verified: fc.bigInt({ min: 0n, max: 1000n }),
      loaded: fc.bigInt({ min: 0n, max: 1000n }),
    });
    fc.assert(
      fc.property(fc.array(arbLine, { minLength: 1, maxLength: 20 }), (ls) => {
        const r = evaluateRelease({ ...base, lines: ls.map((l) => ({ order_number: 'O', sku_code: l.sku, required_qty: l.required, picked_qty: l.picked, verified_qty: l.verified, loaded_qty: l.loaded })) });
        const expected = ls.every((l) => l.loaded === l.required && l.picked >= l.required && l.verified >= l.required);
        return r.can_release === expected;
      }),
    );
  });

  it('property: totals matching never implies release when any SKU mismatches', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 500n }), fc.bigInt({ min: 1n, max: 500n }), fc.bigInt({ min: 1n, max: 499n }), (a, b, delta) => {
        // load a+delta of A and b-delta of B: totals equal, per-SKU wrong
        const bl = b - delta;
        if (bl < 0n) return true;
        const r = evaluateRelease({ ...base, lines: [line('A', a, a + delta), line('B', b, bl)] });
        return r.totals.required === r.totals.loaded && r.can_release === false;
      }),
    );
  });
});
