import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db.js';

const startedAt = Date.now();

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health/live', async () => ({ status: 'ok', uptime_s: Math.round((Date.now() - startedAt) / 1000) }));

  app.get('/health/ready', async (_req, reply) => {
    const t0 = performance.now();
    try {
      await getDb().$queryRaw`SELECT 1`;
      return { status: 'ok', db: 'ok', db_latency_ms: Math.round(performance.now() - t0) };
    } catch (e) {
      reply.status(503);
      return { status: 'degraded', db: 'unreachable', error: (e as Error).message };
    }
  });

  // Prometheus-style plain text metrics (no secrets, no PII)
  app.get('/metrics', { preHandler: app.requirePermission('dashboard.read') }, async (_req, reply) => {
    const db = getDb();
    const [mov, lpns, orders, inc] = await Promise.all([
      db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM inventory_movements`,
      db.$queryRaw<{ status: string; n: bigint }[]>`SELECT status, count(*) AS n FROM lpns GROUP BY status`,
      db.$queryRaw<{ status: string; n: bigint }[]>`SELECT status, count(*) AS n FROM orders GROUP BY status`,
      db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM incidents WHERE status IN ('OPEN','IN_REVIEW')`,
    ]);
    const lines = [
      `# TYPE wms_movements_total counter`,
      `wms_movements_total ${mov[0]?.n ?? 0}`,
      `# TYPE wms_lpns gauge`,
      ...lpns.map((r) => `wms_lpns{status="${r.status}"} ${r.n}`),
      `# TYPE wms_orders gauge`,
      ...orders.map((r) => `wms_orders{status="${r.status}"} ${r.n}`),
      `# TYPE wms_open_incidents gauge`,
      `wms_open_incidents ${inc[0]?.n ?? 0}`,
      `# TYPE wms_process_uptime_seconds gauge`,
      `wms_process_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`,
      `# TYPE wms_process_rss_bytes gauge`,
      `wms_process_rss_bytes ${process.memoryUsage().rss}`,
    ];
    reply.type('text/plain; version=0.0.4');
    return lines.join('\n') + '\n';
  });
}
