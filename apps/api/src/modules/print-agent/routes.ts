// Print agent API: the PC that has the Zebra on USB runs tools/print-agent/wms_print_agent.py, which polls this
// endpoint with the printer's token, prints the ZPL through the Windows RAW queue and reports the result.
// Token auth (no cookie, no session): `X-Agent-Token: wmsp_…`. CSRF does not apply (no cookie is ever sent).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb, withTx } from '../../db.js';
import { NotFoundError, UnauthorizedError } from '../../errors.js';
import { sha256 } from '../../lib/crypto.js';

const STALE_CLAIM_MS = 2 * 60_000; // a claimed job the agent never reported goes back to the queue

async function printerFor(req: FastifyRequest) {
  const token = req.headers['x-agent-token'];
  if (typeof token !== 'string' || token.length < 20) throw new UnauthorizedError('Missing X-Agent-Token');
  const p = await getDb().printers.findFirst({ where: { agent_token_hash: sha256(token), mode: 'AGENT', is_active: true } });
  if (!p) throw new UnauthorizedError('Invalid agent token');
  await touch(p.id, typeof req.headers['x-agent-host'] === 'string' ? req.headers['x-agent-host'] : null);
  return p;
}

/** Marks the printer as seen by a station (python agent or WebUSB browser station). */
async function touch(printerId: string, host: string | null) {
  await getDb().printers.update({ where: { id: printerId }, data: { agent_last_seen_at: new Date(), ...(host ? { agent_host: host.slice(0, 120) } : {}) } });
}

async function pingInfo(p: { id: string; code: string; name: string; dpi: number; label_width_mm: number; label_height_mm: number }) {
  const queued = await getDb().label_prints.count({ where: { printer_id: p.id, status: 'QUEUED' } });
  return { printer: p.code, name: p.name, dpi: p.dpi, label_width_mm: p.label_width_mm, label_height_mm: p.label_height_mm, queued };
}

/** Claims up to `limit` queued labels (oldest first). Claimed = PRINTING; unreported claims expire back to QUEUED. */
async function claimJobs(p: { id: string; code: string }, limit: number) {
  return withTx(async (tx) => {
    await tx.label_prints.updateMany({ where: { printer_id: p.id, status: 'PRINTING', claimed_at: { lt: new Date(Date.now() - STALE_CLAIM_MS) } }, data: { status: 'QUEUED', claimed_at: null } });
    const rows = await tx.$queryRaw<{ id: string; label_type: string; entity_id: string; zpl: string; is_reprint: boolean; created_at: Date }[]>`
      SELECT id, label_type, entity_id, zpl, is_reprint, created_at FROM label_prints
       WHERE printer_id = ${p.id}::uuid AND status = 'QUEUED' ORDER BY created_at LIMIT ${limit} FOR UPDATE SKIP LOCKED`;
    if (rows.length) await tx.label_prints.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: 'PRINTING', claimed_at: new Date() } });
    return { printer: p.code, jobs: rows.map((r) => ({ id: r.id, label_type: r.label_type, entity: r.entity_id, zpl: r.zpl, is_reprint: r.is_reprint, created_at: r.created_at })) };
  });
}

async function reportJob(printerId: string, id: string, body: { ok: boolean; error?: string }) {
  const job = await getDb().label_prints.findFirst({ where: { id, printer_id: printerId } });
  if (!job) throw new NotFoundError('print job', id);
  if (job.status === 'SENT') return { id, status: 'SENT' };
  const status = body.ok ? 'SENT' : 'FAILED';
  await getDb().label_prints.update({ where: { id }, data: { status, error: body.ok ? null : (body.error ?? 'agent error').slice(0, 500), sent_at: body.ok ? new Date() : null } });
  return { id, status };
}

const zLimit = z.object({ limit: z.coerce.number().int().min(1).max(20).default(5), wait: z.coerce.number().int().min(0).max(30).default(0) });

/** Long polling: holds the request up to `wait` seconds until a label is queued, so a station needs no timer of its own
 *  (browser timers stop when the window is hidden; a pending request does not). One short transaction per attempt. */
async function claimJobsWait(p: { id: string; code: string }, q: { limit: number; wait: number }) {
  const deadline = Date.now() + q.wait * 1000;
  for (;;) {
    const r = await claimJobs(p, q.limit);
    if (r.jobs.length || Date.now() >= deadline) return r;
    await new Promise((res) => setTimeout(res, 1000));
  }
}
const zResult = z.object({ ok: z.boolean(), error: z.string().trim().max(500).optional() });

export async function printAgentRoutes(app: FastifyInstance) {
  // ---- token-authenticated (python station on the printer PC)
  app.get('/print-agent/ping', async (req) => pingInfo(await printerFor(req)));
  app.get('/print-agent/jobs', async (req) => claimJobsWait(await printerFor(req), zLimit.parse(req.query)));
  app.post('/print-agent/jobs/:id/result', async (req) => {
    const p = await printerFor(req);
    return reportJob(p.id, z.string().uuid().parse((req.params as { id: string }).id), zResult.parse(req.body));
  });

  // ---- session-authenticated (WebUSB station: a browser tab on the printer PC talks to the Zebra directly)
  const stationPrinter = async (req: FastifyRequest) => {
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const p = await getDb().printers.findFirst({ where: { id, mode: 'AGENT', is_active: true } });
    if (!p) throw new NotFoundError('printer', id);
    const host = typeof req.headers['x-agent-host'] === 'string' ? req.headers['x-agent-host'] : `WebUSB · ${req.actor?.username ?? ''}`;
    await touch(p.id, host);
    return p;
  };
  app.get('/printers/:id/station/ping', { preHandler: app.requirePermission('labels.print') }, async (req) => pingInfo(await stationPrinter(req)));
  app.get('/printers/:id/station/jobs', { preHandler: app.requirePermission('labels.print') }, async (req) => claimJobsWait(await stationPrinter(req), zLimit.parse(req.query)));
  app.post('/printers/:id/station/jobs/:jobId/result', { preHandler: app.requirePermission('labels.print') }, async (req) => {
    const p = await stationPrinter(req);
    return reportJob(p.id, z.string().uuid().parse((req.params as { jobId: string }).jobId), zResult.parse(req.body));
  });
}
