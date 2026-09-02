import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IMPORT_TYPES, zUuid } from '@wms/shared';
import { getDb } from '../../db.js';
import { RuleError } from '../../errors.js';
import { importJob, runImport, TEMPLATES, templateCsv } from './service.js';

export async function importRoutes(app: FastifyInstance) {
  const db = getDb();
  const perm = app.requirePermission('imports.run');

  app.get('/imports/templates', { preHandler: perm }, async () => TEMPLATES);
  app.get('/imports/templates/:type.csv', { preHandler: perm }, async (req, reply) => {
    const type = z.enum(IMPORT_TYPES).parse((req.params as { type: string }).type.toUpperCase());
    reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="template_${type.toLowerCase()}.csv"`);
    return '﻿' + templateCsv(type);
  });

  /** multipart: field `file`; query: type, mode=VALIDATE|APPLY */
  app.post('/imports', { preHandler: perm }, async (req, reply) => {
    const q = z.object({ type: z.enum(IMPORT_TYPES), mode: z.enum(['VALIDATE', 'APPLY']).default('VALIDATE') }).parse(req.query);
    const file = await req.file();
    if (!file) throw new RuleError('NO_FILE', 'Multipart file field required');
    const buf = await file.toBuffer();
    const result = await runImport(req.actor!, q.type, buf, file.filename ?? 'upload', q.mode);
    reply.status(result.status === 'APPLIED' ? 201 : 200);
    return result;
  });

  app.get('/imports', { preHandler: perm }, async (req) => {
    const q = z.object({ type: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return db.import_jobs.findMany({ where: q.type ? { import_type: q.type } : {}, orderBy: { created_at: 'desc' }, take: q.limit, select: { id: true, import_type: true, file_name: true, status: true, total_rows: true, valid_rows: true, error_rows: true, summary: true, created_by: true, created_at: true, applied_at: true } });
  });
  app.get('/imports/:id', { preHandler: perm }, async (req) => importJob(zUuid.parse((req.params as { id: string }).id)));
}
