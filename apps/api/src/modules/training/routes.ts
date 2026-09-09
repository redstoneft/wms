import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { zReason, zUuid } from '@wms/shared';
import * as svc from './service.js';

const zStep = z.enum(['RECEIVE', 'PUTAWAY', 'TRANSFER', 'REPLENISH', 'COUNT', 'ASSEMBLY', 'PICK', 'STAGE', 'VERIFY', 'LOAD']);

export async function trainingRoutes(app: FastifyInstance) {
  app.get('/training', { preHandler: app.requireAuth }, async (req) => svc.myTraining(req.actor!));
  app.post('/training/steps/:step/prepare', { preHandler: app.requireAuth }, async (req) => svc.prepare(req.actor!, zStep.parse((req.params as { step: string }).step.toUpperCase())));
  app.post('/training/steps/:step/check', { preHandler: app.requireAuth }, async (req) => svc.check(req.actor!, zStep.parse((req.params as { step: string }).step.toUpperCase())));
  app.get('/training/labels.html', { preHandler: app.requireAuth }, async (_req, reply) => {
    reply.type('text/html; charset=utf-8');
    return svc.practiceLabelsHtml();
  });

  // supervisors manage training (waiving it is an exception authorization); admins have every permission
  const manage = app.requirePermission('exceptions.authorize');
  app.get('/training/users', { preHandler: manage }, async () => svc.trainingUsers());
  /** Empties the school warehouse (practice pallets written off, practice documents cancelled). Audited. */
  app.post('/training/school/reset', { preHandler: manage }, async (req) => {
    const body = z.object({ reason: zReason }).parse(req.body);
    return svc.resetSchool(req.actor!, body.reason);
  });
  app.post('/training/users/:id/reset', { preHandler: manage }, async (req) => svc.resetTraining(req.actor!, zUuid.parse((req.params as { id: string }).id)));
  app.post('/training/users/:id/waive', { preHandler: manage }, async (req) => {
    const body = z.object({ reason: zReason }).parse(req.body);
    return svc.waiveTraining(req.actor!, zUuid.parse((req.params as { id: string }).id), body.reason);
  });
}
