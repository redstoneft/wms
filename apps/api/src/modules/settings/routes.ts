import type { FastifyInstance } from 'fastify';
import { zSettings } from '@wms/shared';
import { getDb, withTx, type Tx } from '../../db.js';
import { audit } from '../../lib/audit.js';

export const DEFAULT_SETTINGS = {
  allocation_strategy: 'FIFO',
  session_ttl_hours: 12,
  require_mfa_for_admin: true,
  auto_print_lpn_labels: true,
} as const;

export type SettingsShape = { [K in keyof typeof DEFAULT_SETTINGS]: (typeof DEFAULT_SETTINGS)[K] extends string ? string : (typeof DEFAULT_SETTINGS)[K] extends boolean ? boolean : number };

export async function getSettings(tx?: Tx): Promise<SettingsShape> {
  const db = tx ?? getDb();
  const rows = await db.settings.findMany();
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out as SettingsShape;
}

let cache: { at: number; value: SettingsShape } | null = null;
/** Settings read on hot paths (every request): cached for 15 s, refreshed on write. */
export async function getSettingsCached(): Promise<SettingsShape> {
  if (cache && Date.now() - cache.at < 15_000) return cache.value;
  const value = await getSettings();
  cache = { at: Date.now(), value };
  return value;
}
export function invalidateSettingsCache() {
  cache = null;
}

export async function settingsRoutes(app: FastifyInstance) {
  app.get('/settings', { preHandler: app.requireAuth }, async () => getSettings());
  app.put('/settings', { preHandler: app.requirePermission('settings.manage') }, async (req) => {
    const body = zSettings.parse(req.body);
    return withTx(async (tx) => {
      const before = await getSettings(tx);
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue;
        await tx.settings.upsert({ where: { key: k }, create: { key: k, value: JSON.parse(JSON.stringify(v)), updated_by: req.actor!.userId }, update: { value: JSON.parse(JSON.stringify(v)), updated_by: req.actor!.userId } });
      }
      const after = await getSettings(tx);
      await audit(tx, req.actor!, { action: 'settings.update', entity_type: 'settings', before, after });
      invalidateSettingsCache();
      return after;
    });
  });
}
