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
  const host = typeof req.headers['x-agent-host'] === 'string' ? req.headers['x-agent-host'].slice(0, 120) : null;
  await getDb().printers.update({ where: { id: p.id }, data: { agent_last_seen_at: new Date(), ...(host ? { agent_host: host } : {}) } });
  return p;
}

export async function printAgentRoutes(app: FastifyInstance) {
  app.get('/print-agent/ping', async (req) => {
    const p = await printerFor(req);
    const queued = await getDb().label_prints.count({ where: { printer_id: p.id, status: 'QUEUED' } });
    return { printer: p.code, name: p.name, dpi: p.dpi, label_width_mm: p.label_width_mm, label_height_mm: p.label_height_mm, queued };
  });

  /** Claims up to `limit` queued labels (oldest first). Claimed = PRINTING; unreported claims expire back to QUEUED. */
  app.get('/print-agent/jobs', async (req) => {
    const p = await printerFor(req);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(20).default(5) }).parse(req.query);
    return withTx(async (tx) => {
      await tx.label_prints.updateMany({ where: { printer_id: p.id, status: 'PRINTING', claimed_at: { lt: new Date(Date.now() - STALE_CLAIM_MS) } }, data: { status: 'QUEUED', claimed_at: null } });
      const rows = await tx.$queryRaw<{ id: string; label_type: string; entity_id: string; zpl: string; is_reprint: boolean; created_at: Date }[]>`
        SELECT id, label_type, entity_id, zpl, is_reprint, created_at FROM label_prints
         WHERE printer_id = ${p.id}::uuid AND status = 'QUEUED' ORDER BY created_at LIMIT ${q.limit} FOR UPDATE SKIP LOCKED`;
      if (rows.length) await tx.label_prints.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { status: 'PRINTING', claimed_at: new Date() } });
      return { printer: p.code, jobs: rows.map((r) => ({ id: r.id, label_type: r.label_type, entity: r.entity_id, zpl: r.zpl, is_reprint: r.is_reprint, created_at: r.created_at })) };
    });
  });

  app.post('/print-agent/jobs/:id/result', async (req) => {
    const p = await printerFor(req);
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const body = z.object({ ok: z.boolean(), error: z.string().trim().max(500).optional() }).parse(req.body);
    const job = await getDb().label_prints.findFirst({ where: { id, printer_id: p.id } });
    if (!job) throw new NotFoundError('print job', id);
    if (job.status === 'SENT') return { id, status: 'SENT' };
    const status = body.ok ? 'SENT' : 'FAILED';
    await getDb().label_prints.update({ where: { id }, data: { status, error: body.ok ? null : (body.error ?? 'agent error').slice(0, 500), sent_at: body.ok ? new Date() : null } });
    return { id, status };
  });
}
