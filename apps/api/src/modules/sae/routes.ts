import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../../db.js';
import { compareStock, SAE_ENTITIES, syncAll } from './sync.js';
import { fetchAll, saeConfig } from './supabase.js';

export async function saeRoutes(app: FastifyInstance) {
  const db = getDb();

  /** Configuration presence (never the keys), freshness of both mirrors, and last run per entity. */
  app.get('/sae/status', { preHandler: app.requirePermission('imports.run') }, async () => {
    const cfg = saeConfig();
    const runs = await db.$queryRaw<Record<string, unknown>[]>`
      SELECT DISTINCT ON (entity) entity, id, status, trigger, started_at, finished_at, source_rows, created, updated, skipped,
             COALESCE(jsonb_array_length(errors), 0) AS error_count, notes
        FROM integration_runs WHERE source = 'SAE' ORDER BY entity, started_at DESC`;
    let erpFresh: string | null = null;
    let rawFresh: string | null = null;
    try {
      if (cfg.erp) erpFresh = ((await fetchAll<{ actualizado_en: string }>(cfg.erp, 'sae_inventario', { select: 'actualizado_en', order: 'actualizado_en.desc', limit: '1' }, { timeoutMs: 8000 }))[0]?.actualizado_en ?? null);
      if (cfg.raw) rawFresh = ((await fetchAll<{ _synced_at: string }>(cfg.raw, 'sae_inve01', { select: '_synced_at', order: '_synced_at.desc', limit: '1' }, { timeoutMs: 8000 }))[0]?._synced_at ?? null);
    } catch {
      /* reported as null */
    }
    const counts = await db.$queryRaw<{ skus: bigint; customers: bigint; suppliers: bigint; pos: bigint; orders: bigint }[]>`
      SELECT (SELECT count(*) FROM skus WHERE external_source = 'SAE') AS skus,
             (SELECT count(*) FROM customers WHERE external_source IN ('SAE','PEDIDOS')) AS customers,
             (SELECT count(*) FROM suppliers WHERE external_source = 'SAE') AS suppliers,
             (SELECT count(*) FROM purchase_orders WHERE external_source = 'SAE') AS pos,
             (SELECT count(*) FROM orders WHERE source = 'SAE') AS orders`;
    return {
      configured: { erp: !!cfg.erp, raw: !!cfg.raw, erp_host: cfg.erp ? new URL(cfg.erp.url).host : null, raw_host: cfg.raw ? new URL(cfg.raw.url).host : null },
      po_since_days: cfg.poSinceDays,
      interval_minutes: cfg.intervalMinutes,
      source_freshness: { erp_updated_at: erpFresh, raw_synced_at: rawFresh },
      wms_counts: counts[0],
      last_runs: runs,
      entities: SAE_ENTITIES,
    };
  });

  app.post('/sae/sync', { preHandler: app.requirePermission('imports.run') }, async (req) => {
    const body = z.object({ entities: z.array(z.enum(SAE_ENTITIES)).min(1).optional() }).parse(req.body ?? {});
    return { results: await syncAll(req.actor!, 'MANUAL', body.entities ?? SAE_ENTITIES) };
  });

  app.get('/sae/runs', { preHandler: app.requirePermission('imports.run') }, async (req) => {
    const q = z.object({ entity: z.enum(SAE_ENTITIES).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return db.integration_runs.findMany({ where: { source: 'SAE', ...(q.entity ? { entity: q.entity } : {}) }, orderBy: { started_at: 'desc' }, take: q.limit });
  });

  app.get('/sae/stock-compare', { preHandler: app.requirePermission('inventory.read') }, async () => compareStock());
}
