import type { IncidentSeverity, IncidentType } from '@wms/shared';
import type { Tx } from '../../db.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';

export interface NewIncident {
  incident_type: IncidentType;
  severity?: IncidentSeverity;
  title: string;
  description?: string | null;
  entity_type?: string | null;
  entity_id?: string | null;
  sku_id?: string | null;
  lpn_id?: string | null;
  location_id?: string | null;
  order_id?: string | null;
  shipment_id?: string | null;
  receipt_id?: string | null;
  qty?: bigint | null;
  assigned_to?: string | null;
}

/** Creates an incident inside the caller's transaction (used by automatic detection). */
export async function createIncident(tx: Tx, ctx: ActorContext, inc: NewIncident) {
  const num = await tx.$queryRaw<{ n: string }[]>`SELECT next_doc_number('INC', 'incident_seq') AS n`;
  const row = await tx.incidents.create({
    data: {
      incident_number: num[0]!.n,
      incident_type: inc.incident_type,
      severity: inc.severity ?? 'MEDIUM',
      title: inc.title,
      description: inc.description ?? null,
      entity_type: inc.entity_type ?? null,
      entity_id: inc.entity_id ?? null,
      sku_id: inc.sku_id ?? null,
      lpn_id: inc.lpn_id ?? null,
      location_id: inc.location_id ?? null,
      order_id: inc.order_id ?? null,
      shipment_id: inc.shipment_id ?? null,
      receipt_id: inc.receipt_id ?? null,
      qty: inc.qty ?? null,
      reported_by: ctx.userId,
      assigned_to: inc.assigned_to ?? null,
    },
  });
  await audit(tx, ctx, { action: 'incident.create', entity_type: 'incident', entity_id: row.id, after: row });
  return row;
}
