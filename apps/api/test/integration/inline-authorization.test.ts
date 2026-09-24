// Supervisor authorization on the handheld (credentials typed on the spot) and self-override for permission holders.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, idem, makeFixture, storedPallet, userWithRoles, type Client, type Fixture } from '../helpers.js';

let f: Fixture;
let fork: Client;
let fork2: Client;
let sup: Client;
let sup2: Client;
const pwOf = (c: Client) => `Pw-${c.username}-Test-1!`; // helper convention

beforeAll(async () => {
  f = await makeFixture({ skus: 1 });
  fork = await userWithRoles('iafork', ['FORKLIFT']);
  fork2 = await userWithRoles('iafork2', ['FORKLIFT']);
  sup = await userWithRoles('iasup', ['SUPERVISOR']);
  sup2 = await userWithRoles('iasup2', ['SUPERVISOR']);
});
afterAll(closeApp);

describe('inline supervisor authorization', () => {
  it('operator: wrong location → the supervisor authorizes with their credentials on the handheld; wrong password counts as a failed login; self cannot authorize', async () => {
    const p = await storedPallet(f, 0, f.dock.id, 10n);
    const start = await fork.post('/putaway/start', { lpn_code: p.code });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const taskId: string = start.body.task.id;
    const wrongLoc = [f.reserve[14]!, f.reserve[15]!].find((l) => l.barcode !== start.body.target.barcode)!; // a free slot far from the suggestion
    const blocked = await fork.post('/putaway/confirm', { task_id: taskId, lpn_code: p.code, location_barcode: wrongLoc.barcode }, idem());
    expect(blocked.status).toBe(422);
    expect(blocked.body.error).toBe('WRONG_LOCATION');
    // wrong password
    const bad = await fork.post('/authorizations/inline', { username: sup.username, password: 'nope', exception_type: 'PUTAWAY_LOCATION_OVERRIDE', entity_type: 'putaway_task', entity_id: taskId, reason: 'rack lleno' });
    expect(bad.status).toBe(401);
    // another operator's credentials are not a supervisor's; one's own are a self-authorization
    const notSup = await fork.post('/authorizations/inline', { username: fork2.username, password: pwOf(fork2), exception_type: 'PUTAWAY_LOCATION_OVERRIDE', entity_type: 'putaway_task', entity_id: taskId, reason: 'rack lleno' });
    expect(notSup.status).toBe(403);
    const own = await fork.post('/authorizations/inline', { username: fork.username, password: pwOf(fork), exception_type: 'PUTAWAY_LOCATION_OVERRIDE', entity_type: 'putaway_task', entity_id: taskId, reason: 'rack lleno' });
    expect(own.status).toBe(422);
    expect(own.body.error).toBe('SELF_AUTHORIZATION');
    // the real thing
    const auth = await fork.post('/authorizations/inline', { username: sup.username, password: pwOf(sup), exception_type: 'PUTAWAY_LOCATION_OVERRIDE', entity_type: 'putaway_task', entity_id: taskId, reason: 'rack lleno' });
    expect(auth.status, JSON.stringify(auth.body)).toBe(201);
    expect(auth.body.supervisor).toBe(sup.username);
    const ok = await fork.post('/putaway/confirm', { task_id: taskId, lpn_code: p.code, location_barcode: wrongLoc.barcode, authorization_id: auth.body.id }, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.overridden).toBe(true);
    expect(ok.body.location).toBe(wrongLoc.code);
    // a supervisor cannot inline-authorize their own exception
    const p2 = await storedPallet(f, 0, f.dock.id, 10n);
    const s2 = await sup.post('/putaway/start', { lpn_code: p2.code });
    const self = await sup.post('/authorizations/inline', { username: sup.username, password: pwOf(sup), exception_type: 'PUTAWAY_LOCATION_OVERRIDE', entity_type: 'putaway_task', entity_id: s2.body.task.id, reason: 'quiero ubicarla yo mismo' });
    expect(self.status).toBe(422);
    expect(self.body.error).toBe('SELF_AUTHORIZATION');
    // …but another supervisor can
    const other = await sup.post('/authorizations/inline', { username: sup2.username, password: pwOf(sup2), exception_type: 'PUTAWAY_LOCATION_OVERRIDE', entity_type: 'putaway_task', entity_id: s2.body.task.id, reason: 'otro supervisor' });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
  });

  it('a supervisor doing the put-away overrides on their own authority with a reason (no ID), audited as self-override', async () => {
    const p = await storedPallet(f, 0, f.dock.id, 10n);
    const start = await sup.post('/putaway/start', { lpn_code: p.code });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const wrongLoc = [f.reserve[16]!, f.reserve[17]!].find((l) => l.barcode !== start.body.target.barcode)!;
    const noReason = await sup.post('/putaway/confirm', { task_id: start.body.task.id, lpn_code: p.code, location_barcode: wrongLoc.barcode }, idem());
    expect(noReason.status).toBe(422);
    expect(noReason.body.error).toBe('REASON_REQUIRED');
    const ok = await sup.post('/putaway/confirm', { task_id: start.body.task.id, lpn_code: p.code, location_barcode: wrongLoc.barcode, override_reason: 'posición sugerida dañada' }, idem());
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.overridden).toBe(true);
  });
});
