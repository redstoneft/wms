// Relocation: a stored pallet moves to a chosen or scanned location in one step. Locations marked manual_only
// (floor blocks) are offered when a person chooses but never suggested by the engine.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, closeApp, expectReconciled, idem, makeFixture, sql, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';

let adm: Client;
let fork: Client;
let f: Fixture;
beforeAll(async () => {
  adm = await admin();
  fork = await userWithRoles('relofork', ['FORKLIFT']);
  f = await makeFixture({ skus: 1, reserveBays: 3, levels: 1 });
});
afterAll(closeApp);

describe('relocate a stored pallet', () => {
  it('offers manual-only locations to a person, never to the engine, and moves the pallet in one step', async () => {
    // reserve[2] becomes a "floor" position: only a person may send pallets there
    const patch = await adm.patch(`/locations/${f.reserve[2]!.id}`, { restrictions: { manual_only: true } });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect(patch.body.restrictions.manual_only).toBe(true);
    const p = await storedPallet(f, 0, f.reserve[0]!.id, 40n);

    // the engine (automatic suggestion) ignores the manual-only slot
    const sug = await fork.post('/putaway/suggest', { lpn_code: p.code });
    expect(sug.status, JSON.stringify(sug.body)).toBe(200);
    const engineCodes = [sug.body.chosen?.code, ...sug.body.alternatives.map((a: { code: string }) => a.code)].filter(Boolean);
    expect(engineCodes).not.toContain(f.reserve[2]!.code);
    expect(engineCodes).toContain(f.reserve[1]!.code);

    // a person relocating sees it, flagged, after the regular ones
    const opts = await fork.get(`/transfers/relocate/options?lpn_code=${p.code}`);
    expect(opts.status, JSON.stringify(opts.body)).toBe(200);
    expect(opts.body.current.code).toBe(f.reserve[0]!.code);
    const codes = opts.body.options.map((o: { code: string }) => o.code);
    expect(codes).not.toContain(f.reserve[0]!.code);
    expect(codes).toContain(f.reserve[1]!.code);
    expect(codes).toContain(f.reserve[2]!.code);
    const floor = opts.body.options.find((o: { code: string }) => o.code === f.reserve[2]!.code);
    expect(floor.manual_only).toBe(true);
    expect(codes.indexOf(f.reserve[1]!.code)).toBeLessThan(codes.indexOf(f.reserve[2]!.code));

    // one step: chosen by code
    const moved = await fork.post('/transfers/relocate', { lpn_code: p.code, location: f.reserve[2]!.code }, idem());
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.to).toBe(f.reserve[2]!.code);
    const row = await sql<{ status: string; loc: string }>(`SELECT l.status, loc.code AS loc FROM lpns l JOIN locations loc ON loc.id = l.current_location_id WHERE l.code = $1`, [p.code]);
    expect(row[0]).toEqual({ status: 'STORED', loc: f.reserve[2]!.code });
    const tr = await sql<{ status: string; n: bigint }>(`SELECT t.status, (SELECT count(*) FROM inventory_movements m WHERE m.transfer_id = t.id) AS n FROM transfers t WHERE t.id = $1::uuid`, [moved.body.transfer_id]);
    expect(tr[0]!.status).toBe('COMPLETED');
    expect(Number(tr[0]!.n)).toBe(2);
    expect((await sql<{ n: bigint }>(`SELECT count(*) AS n FROM audit_logs WHERE action = 'transfer.relocate' AND entity_id = $1`, [moved.body.transfer_id]))[0]!.n).toBe(1n);

    // scanned barcode works too; same place is rejected; a full slot is rejected
    const back = await fork.post('/transfers/relocate', { lpn_code: p.code, location: f.reserve[1]!.barcode }, idem());
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.to).toBe(f.reserve[1]!.code);
    const same = await fork.post('/transfers/relocate', { lpn_code: p.code, location: f.reserve[1]!.code }, idem());
    expect(same.status).toBe(422);
    expect(same.body.error).toBe('SAME_LOCATION');
    await storedPallet(f, 0, f.reserve[0]!.id, 10n);
    const full = await fork.post('/transfers/relocate', { lpn_code: p.code, location: f.reserve[0]!.code }, idem());
    expect(full.status).toBe(422);
    expect(full.body.error).toBe('LOCATION_REJECTED');
    await expectReconciled();
  });
});
