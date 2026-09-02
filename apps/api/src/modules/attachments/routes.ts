import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { zUuid } from '@wms/shared';
import { loadConfig } from '../../config.js';
import { getDb } from '../../db.js';
import { NotFoundError } from '../../errors.js';

/** Serves stored photos/documents (content-addressed files under UPLOAD_DIR). Path traversal is impossible: the path comes from the DB row, never from the client. */
export async function attachmentRoutes(app: FastifyInstance) {
  const db = getDb();
  app.get('/attachments/:id/file', { preHandler: app.requireAuth }, async (req, reply) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const att = await db.attachments.findUnique({ where: { id } });
    if (!att) throw new NotFoundError('attachment', id);
    const root = path.resolve(loadConfig().UPLOAD_DIR);
    const full = path.resolve(root, att.storage_path);
    if (!full.startsWith(root + path.sep) || !existsSync(full)) throw new NotFoundError('attachment file', id);
    reply.type(att.mime_type).header('Content-Disposition', `inline; filename="${att.file_name.replace(/["\\\r\n]/g, '')}"`).header('Cache-Control', 'private, max-age=3600').header('X-Content-Type-Options', 'nosniff');
    return reply.send(createReadStream(full));
  });
  app.get('/attachments', { preHandler: app.requireAuth }, async (req) => {
    const q = req.query as { entity_type?: string; entity_id?: string };
    if (!q.entity_type || !q.entity_id) return [];
    return db.attachments.findMany({ where: { entity_type: q.entity_type.slice(0, 40), entity_id: q.entity_id.slice(0, 64) }, orderBy: { created_at: 'desc' } });
  });
}
