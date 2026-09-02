import type { FastifyInstance } from 'fastify';
import { authRoutes } from './modules/auth/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { userRoutes } from './modules/users/routes.js';
import { masterDataRoutes } from './modules/masterdata/routes.js';
import { layoutRoutes } from './modules/layout/routes.js';
import { inboundRoutes } from './modules/inbound/routes.js';
import { inventoryRoutes } from './modules/inventory/routes.js';
import { putawayRoutes } from './modules/putaway/routes.js';
import { transferRoutes } from './modules/transfers/routes.js';
import { replenishmentRoutes } from './modules/replenishment/routes.js';
import { countRoutes } from './modules/counts/routes.js';
import { orderRoutes } from './modules/orders/routes.js';
import { pickingRoutes } from './modules/picking/routes.js';
import { verificationRoutes } from './modules/verification/routes.js';
import { shipmentRoutes } from './modules/shipments/routes.js';
import { incidentRoutes } from './modules/incidents/routes.js';
import { returnRoutes } from './modules/returns/routes.js';
import { labelRoutes } from './modules/labels/routes.js';
import { importRoutes } from './modules/imports/routes.js';
import { dashboardRoutes } from './modules/dashboard/routes.js';
import { settingsRoutes } from './modules/settings/routes.js';
import { authorizationRoutes } from './modules/authorizations/routes.js';
import { auditRoutes } from './modules/audit/routes.js';
import { integrationRoutes } from './modules/integrations/routes.js';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(authRoutes);
      await api.register(userRoutes);
      await api.register(masterDataRoutes);
      await api.register(layoutRoutes);
      await api.register(inboundRoutes);
      await api.register(inventoryRoutes);
      await api.register(putawayRoutes);
      await api.register(transferRoutes);
      await api.register(replenishmentRoutes);
      await api.register(countRoutes);
      await api.register(orderRoutes);
      await api.register(pickingRoutes);
      await api.register(verificationRoutes);
      await api.register(shipmentRoutes);
      await api.register(incidentRoutes);
      await api.register(returnRoutes);
      await api.register(labelRoutes);
      await api.register(importRoutes);
      await api.register(dashboardRoutes);
      await api.register(settingsRoutes);
      await api.register(authorizationRoutes);
      await api.register(auditRoutes);
      await api.register(integrationRoutes);
    },
    { prefix: '/api' },
  );
}
