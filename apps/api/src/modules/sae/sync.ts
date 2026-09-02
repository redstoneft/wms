// Aspel SAE → WMS synchronisation.
//
// Direction: SAE (via its Supabase mirrors) is the master for SKUs, customers,
// suppliers and purchase orders; the PEDIDOS project is the master for customer
// orders (retail POs parsed from the customers' documents). The WMS never pushes
// data back and NEVER creates or changes inventory from SAE: physical stock only
// enters through receiving/counts. Existencias de SAE are compared, not applied.
//
// Rules of engagement
//  * idempotent: re-running never duplicates anything (external_ref / codes)
//  * conservative: rows the WMS already operates on (orders in picking, POs with
//    receipts) are never rewritten; differences are reported, not forced
//  * everything is logged in integration_runs + audit
import type { Tx } from '../../db.js';
import { getDb, withTx } from '../../db.js';
import { audit } from '../../lib/audit.js';
import type { ActorContext } from '../../lib/context.js';
import { cancelOrder, createOrder } from '../orders/service.js';
import { createIncident } from '../incidents/service.js';
import { fetchAll, key, num, requireSource, saeConfig } from './supabase.js';

export const SAE_ENTITIES = ['skus', 'customers', 'suppliers', 'purchase_orders', 'customer_orders'] as const;
export type SaeEntity = (typeof SAE_ENTITIES)[number];

export interface SyncResult {
  entity: SaeEntity;
  run_id: string;
  status: 'OK' | 'FAILED';
  source_rows: number;
  created: number;
  updated: number;
  skipped: number;
  errors: { ref: string; message: string }[];
  notes?: string;
}

class Counters {
  source_rows = 0;
  created = 0;
  updated = 0;
  skipped = 0;
  errors: { ref: string; message: string }[] = [];
  err(ref: string, message: string) {
    if (this.errors.length < 500) this.errors.push({ ref, message });
    this.skipped++;
  }
}

async function withRun(entity: SaeEntity, trigger: 'SCHEDULED' | 'MANUAL', ctx: ActorContext, fn: (c: Counters) => Promise<string | void>): Promise<SyncResult> {
  const db = getDb();
  const run = await db.integration_runs.create({ data: { source: 'SAE', entity, trigger, user_id: ctx.userId === '00000000-0000-7000-8000-000000000000' ? null : ctx.userId } });
  const c = new Counters();
  let status: 'OK' | 'FAILED' = 'OK';
  let notes: string | undefined;
  try {
    notes = (await fn(c)) ?? undefined;
  } catch (e) {
    status = 'FAILED';
    notes = (e as Error).message;
  }
  await db.integration_runs.update({
    where: { id: run.id },
    data: { status, finished_at: new Date(), source_rows: c.source_rows, created: c.created, updated: c.updated, skipped: c.skipped, errors: c.errors.length ? c.errors : undefined, notes: notes ?? null },
  });
  await withTx((tx) => audit(tx, ctx, { action: `integration.sae.${entity}`, entity_type: 'integration_run', entity_id: run.id, after: { status, source_rows: c.source_rows, created: c.created, updated: c.updated, skipped: c.skipped, errors: c.errors.length, notes } }));
  return { entity, run_id: run.id, status, source_rows: c.source_rows, created: c.created, updated: c.updated, skipped: c.skipped, errors: c.errors, notes };
}

// ---------------------------------------------------------------------------
// SKUs — ONE WMS SKU PER PHYSICAL PRODUCT
//
// SAE registers the same product under several keys (BASE, PIEZA "-1", CAJA
// "." variants, customer item numbers such as 636570). The WMS keeps a single
// SKU per product, identified by its GTIN when the platform knows it, otherwise
// by the SAE model (sku_alias.modelo, or the key without leading/trailing dots).
// Every SAE key becomes an alias barcode of that SKU with the packaging level it
// represents (CAJA → CASE when the case size is known), so scanning or importing
// any of the keys resolves to the same inventory line.
// ---------------------------------------------------------------------------
interface RawArticle { cve_art: string; descr: string | null; lin_prod: string | null; uni_med: string | null; uni_emp: number | null; fac_conv: number | null; peso: number | null; con_lote: string | null; status: string }
interface Alias { cve_art: string; modelo: string; capa: string }
interface Producto { sku_interno: string; gtin: string | null; activo: boolean }
interface PedidoLinea { sku_interno: string; gtin: string | null; piezas_por_caja: number | null }
/** SAE "claves alternas" (CVES_ALTER01): alternate keys of an article; GTIN-looking ones are the product's barcode. */
interface AltKey { cve_art: string; cve_alter: string }
/** SAE observations (OBS_DOCF01) referenced by document lines (PAR_FACTF01.cve_obs): operators often type the GTIN there. */
interface ObsRow { cve_obs: number | string; str_obs: string | null }
interface ParObs { cve_art: string; cve_obs: number | string | null }
/** Retail-chain catalogue matches from the price scraper (cerezo_sku_modelo): GTIN → model, with a confidence score. */
interface CerezoRow { sku: string; modelo: string | null; metodo: string | null; confianza: number | null }

/** GS1 mod-10 check digit (GTIN-8/12/13/14). Used for GTINs *parsed* from free text; explicit catalogue values are trusted. */
export function gtinCheckDigitOk(g: string): boolean {
  if (!/^[0-9]{8}$|^[0-9]{12,14}$/.test(g)) return false;
  const d = g.split('').map(Number);
  const check = d.pop()!;
  let sum = 0;
  for (let i = d.length - 1, w = 3; i >= 0; i--, w = 4 - w) sum += d[i]! * w;
  return (10 - (sum % 10)) % 10 === check;
}

/** Tables the mirrors may not (yet) replicate: absence is reported, never fatal. */
async function optionalFetch<T>(src: { url: string; key: string }, table: string, missing: string[]): Promise<T[]> {
  try {
    const rows = await fetchAll<Record<string, unknown>>(src, table, { select: '*' });
    return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v])) as T);
  } catch (e) {
    missing.push(`${table} (${(e as Error).message.slice(0, 60)})`);
    return [];
  }
}

/** Extra GTIN sources, in order of trust, as synthetic catalogue rows: SAE alternate keys, SAE line observations, retail-chain matches. */
export function extraGtinSources(alts: AltKey[], obs: ObsRow[], pars: ParObs[], cerezo: CerezoRow[], knownModels: Set<string>, c: Counters): { rows: (Producto & { source: string })[]; aliases: Map<string, string[]> } {
  const rows: (Producto & { source: string })[] = [];
  const aliases = new Map<string, string[]>();
  // 1. claves alternas: explicit, trusted
  for (const a of alts) {
    const art = key(a.cve_art);
    const alt = key(a.cve_alter);
    if (!art || !alt) continue;
    if (GTIN_RE.test(alt)) rows.push({ sku_interno: art, gtin: alt, activo: true, source: 'alternas' });
    else if (alt.length >= 3) aliases.set(art, [...(aliases.get(art) ?? []), alt]);
  }
  // 2. observaciones de partida: parsed, only GTINs with a valid check digit, unambiguous per article
  const obsText = new Map(obs.map((o) => [String(o.cve_obs), key(o.str_obs)]));
  const perArt = new Map<string, Map<string, number>>();
  for (const l of pars) {
    if (l.cve_obs === null || l.cve_obs === undefined) continue;
    const txt = obsText.get(String(l.cve_obs));
    if (!txt) continue;
    for (const tok of txt.match(/[0-9]{12,14}/g) ?? []) {
      if (!gtinCheckDigitOk(tok)) continue;
      const art = key(l.cve_art);
      const m = perArt.get(art) ?? new Map<string, number>();
      m.set(tok, (m.get(tok) ?? 0) + 1);
      perArt.set(art, m);
    }
  }
  for (const [art, m] of perArt) {
    const ranked = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const total = ranked.reduce((a, [, n]) => a + n, 0);
    const [top, n] = ranked[0]!;
    if (ranked.length === 1 || n / total >= 0.8) rows.push({ sku_interno: art, gtin: top, activo: true, source: 'observaciones' });
    else c.errors.push({ ref: art, message: `observaciones de partida con GTIN ambiguo: ${ranked.map(([g, k]) => `${g}×${k}`).join(', ')}; no se adoptó` });
  }
  // 3. retail-chain matches: high confidence, one model per GTIN and one GTIN per model, model known to SAE
  const good = cerezo.filter((r) => r.modelo && GTIN_RE.test(key(r.sku)) && gtinCheckDigitOk(key(r.sku)) && (key(r.metodo) === 'codigo' || num(r.confianza) >= 95));
  const byGtin = new Map<string, Set<string>>();
  const byModel = new Map<string, Set<string>>();
  for (const r of good) {
    byGtin.set(key(r.sku), (byGtin.get(key(r.sku)) ?? new Set()).add(key(r.modelo)));
    byModel.set(key(r.modelo), (byModel.get(key(r.modelo)) ?? new Set()).add(key(r.sku)));
  }
  for (const [g, models] of byGtin) {
    if (models.size > 1) {
      c.errors.push({ ref: g, message: `GTIN de cadenas asociado a varios modelos (${[...models].join(', ')}); no se adoptó` });
      continue;
    }
    const model = [...models][0]!;
    if (!knownModels.has(model) || byModel.get(model)!.size > 1) continue;
    rows.push({ sku_interno: model, gtin: g, activo: true, source: 'cadenas' });
  }
  return { rows, aliases };
}

const SAE_KEY_RE = /^[A-Za-z0-9.][A-Za-z0-9._\-/ ]*$/;
const GTIN_RE = /^[0-9]{8,14}$/;
/** SAE keys may contain spaces; WMS codes/barcodes cannot. Same normalisation everywhere. */
export const saeKeyBarcode = (k: string) => key(k).replace(/\s+/g, '_');
const stripDots = (k: string) => k.replace(/^\.+/, '').replace(/\.+$/, '');

interface ProductKey { key: string; layer: string | null; article: RawArticle; model: string }
/** caseGtins: GTINs the platform attached to CAJA keys of the product (the case-level barcode, not another product). */
interface Product { code: string; model: string; gtin: string | null; caseGtins: string[]; keys: ProductKey[]; base: RawArticle; caseQty: bigint | null }

/** Groups SAE articles into physical products. Identity: the key's own GTIN first; keys without GTIN follow their model,
 *  and a model joins the GTIN of its BASE key (or of the model name in the catalogue). Pure; anomalies go to the counters. */
export function groupProducts(articles: RawArticle[], aliases: Alias[], productos: Producto[], lineas: PedidoLinea[], c: Counters): Product[] {
  const aliasByKey = new Map(aliases.map((a) => [key(a.cve_art), { modelo: key(a.modelo), capa: key(a.capa).toUpperCase() }]));
  const gtinByKey = new Map<string, string>();
  // catalogue rows come ordered by trust (platform, order lines, SAE alternate keys, observations, retail chains): the first wins
  for (const p of productos) if (p.activo !== false && GTIN_RE.test(key(p.gtin)) && !gtinByKey.has(key(p.sku_interno))) gtinByKey.set(key(p.sku_interno), key(p.gtin));
  for (const l of lineas) if (GTIN_RE.test(key(l.gtin)) && key(l.sku_interno) && !gtinByKey.has(key(l.sku_interno))) gtinByKey.set(key(l.sku_interno), key(l.gtin));
  const ppcByKey = new Map<string, number>();
  for (const l of lineas) if (num(l.piezas_por_caja) > 1) ppcByKey.set(key(l.sku_interno), num(l.piezas_por_caja));

  type K = ProductKey;
  const keys: K[] = [];
  for (const a of articles) {
    const k = key(a.cve_art);
    if (!k || !SAE_KEY_RE.test(k)) {
      c.err(k || '(vacío)', 'clave SAE inválida para el WMS');
      continue;
    }
    const al = aliasByKey.get(k);
    keys.push({ key: k, layer: al?.capa ?? null, article: a, model: al?.modelo || stripDots(k) || k });
  }
  // keys the alias table does not know: "X-1" is SAE's piece variant of X when X exists as key or model
  const known = new Set(keys.flatMap((k) => [k.key, k.model]));
  for (const k of keys) {
    if (aliasByKey.has(k.key)) continue;
    const m = /^(.*)-1$/.exec(k.key)?.[1]?.trim();
    if (m && known.has(m)) {
      k.model = m;
      k.layer = 'PIEZA';
    }
  }
  // sku_alias may point a "-1" key at a model that is itself just a key of a wider model (SST248V-20-1 → SST248V-20 → SST248V)
  const modelOfKey = new Map(keys.map((k) => [k.key, k.model]));
  for (const k of keys) {
    let m = k.model;
    for (let hops = 0; hops < 5; hops++) {
      const up = modelOfKey.get(m);
      if (!up || up === m) break;
      m = up;
    }
    k.model = m;
  }
  // GTIN of a model = GTIN of its BASE key, else of the model name itself in the catalogue
  const modelGtin = new Map<string, string>();
  for (const k of keys) if (k.layer === 'BASE' && gtinByKey.has(k.key) && !modelGtin.has(k.model)) modelGtin.set(k.model, gtinByKey.get(k.key)!);
  for (const k of keys) if (!modelGtin.has(k.model) && gtinByKey.has(k.model)) modelGtin.set(k.model, gtinByKey.get(k.model)!);
  for (const k of keys) if (!modelGtin.has(k.model) && k.key === k.model && gtinByKey.has(k.key)) modelGtin.set(k.model, gtinByKey.get(k.key)!);

  const groups = new Map<string, { gtin: string | null; caseGtins: Set<string>; keys: K[] }>();
  for (const k of keys) {
    const own = gtinByKey.get(k.key);
    const mg = modelGtin.get(k.model);
    let gtin = own ?? mg ?? null;
    let caseGtin: string | undefined;
    if (own && mg && own !== mg) {
      if (k.layer === 'CAJA') {
        // the platform gave the CAJA key its own GTIN: that is the case-level barcode of the same product
        gtin = mg;
        caseGtin = own;
      } else c.errors.push({ ref: k.key, message: `GTIN ${own} distinto del GTIN ${mg} del modelo ${k.model}: se trata como producto aparte` });
    }
    const id = gtin ? `g:${gtin}` : `m:${k.model}`;
    let g = groups.get(id);
    if (!g) groups.set(id, (g = { gtin, caseGtins: new Set(), keys: [] }));
    g.keys.push(k);
    if (caseGtin) g.caseGtins.add(caseGtin);
  }
  const usedCodes = new Set<string>();
  const out: Product[] = [];
  for (const g of groups.values()) {
    const ks = g.keys;
    // representative key: BASE key named like its model, BASE, key named like its model, active, first
    const rep = ks.find((x) => x.layer === 'BASE' && x.key === x.model) ?? ks.find((x) => x.layer === 'BASE') ?? ks.find((x) => x.key === x.model) ?? ks.find((x) => key(x.article.status) === 'A') ?? ks[0]!;
    // code: the model when the model belongs to this product, else the representative key without dots
    const model = g.gtin && modelGtin.get(rep.model) !== g.gtin ? stripDots(rep.key) || rep.key : rep.model;
    let code = saeKeyBarcode(model).slice(0, 64);
    if (usedCodes.has(code)) {
      c.errors.push({ ref: rep.key, message: `código ${code} ya usado por otro producto en esta corrida; se usa ${code}~${g.gtin ?? rep.key}` });
      code = `${code}~${g.gtin ?? saeKeyBarcode(rep.key)}`.slice(0, 64);
    }
    usedCodes.add(code);
    const fromOrders = ks.map((x) => ppcByKey.get(x.key) ?? ppcByKey.get(stripDots(x.key))).find((v) => v && v > 1) ?? ppcByKey.get(model);
    const emp = (layers: (string | null)[]) => ks.filter((x) => layers.includes(x.layer)).map((x) => num(x.article.uni_emp)).find((v) => v > 1 && Number.isInteger(v));
    const v = fromOrders ?? emp(['BASE', 'PIEZA', null]) ?? emp(['CAJA']);
    out.push({ code, model, gtin: g.gtin, caseGtins: [...g.caseGtins], keys: ks, base: rep.article, caseQty: v ? BigInt(Math.round(v)) : null });
  }
  return out.sort((a, b) => a.code.localeCompare(b.code));
}

/** A per-key SKU left by the previous import (or created by hand) is folded into the product when it carries no physical trace. */
async function absorbLegacySku(tx: Tx, ctx: ActorContext, legacy: { id: string; code: string }, target: { id: string; code: string }, c: Counters): Promise<boolean> {
  const traces = await Promise.all([
    tx.inventory_balances.count({ where: { sku_id: legacy.id, qty: { gt: 0n } } }),
    tx.inventory_movements.count({ where: { sku_id: legacy.id } }),
    tx.allocations.count({ where: { sku_id: legacy.id } }),
    tx.pick_task_lines.count({ where: { sku_id: legacy.id } }),
    tx.receipt_lines.count({ where: { sku_id: legacy.id } }),
    tx.count_lines.count({ where: { sku_id: legacy.id } }),
    tx.return_lines.count({ where: { sku_id: legacy.id } }),
    tx.verification_lines.count({ where: { sku_id: legacy.id } }),
    tx.replenishment_rules.count({ where: { sku_id: legacy.id } }),
    tx.replenishment_tasks.count({ where: { sku_id: legacy.id } }),
  ]);
  if (traces.some((n) => n > 0)) {
    c.errors.push({ ref: legacy.code, message: `clave duplicada del producto ${target.code} con inventario o movimientos: no se fusionó (requiere conteo/ajuste manual)` });
    return false;
  }
  const ols = await tx.order_lines.findMany({ where: { sku_id: legacy.id }, include: { order: { select: { status: true, order_number: true } } } });
  const busy = ols.find((l) => !['IMPORTED', 'CANCELLED'].includes(l.order.status));
  if (busy) {
    c.errors.push({ ref: legacy.code, message: `clave duplicada del producto ${target.code} usada por el pedido ${busy.order.order_number} en proceso: no se fusionó` });
    return false;
  }
  const pls = await tx.purchase_order_lines.findMany({ where: { sku_id: legacy.id }, include: { po: { select: { status: true, po_number: true } } } });
  const busyPo = pls.find((l) => l.po.status !== 'OPEN' || l.received_qty > 0n);
  if (busyPo) {
    c.errors.push({ ref: legacy.code, message: `clave duplicada del producto ${target.code} usada por la OC ${busyPo.po.po_number} con recepciones: no se fusionó` });
    return false;
  }
  for (const l of ols) {
    const twin = await tx.order_lines.findFirst({ where: { order_id: l.order_id, sku_id: target.id } });
    if (twin) {
      await tx.order_lines.update({ where: { id: twin.id }, data: { required_qty: { increment: l.required_qty }, uom_qty: { increment: l.uom_qty } } });
      await tx.order_lines.delete({ where: { id: l.id } });
    } else await tx.order_lines.update({ where: { id: l.id }, data: { sku_id: target.id } });
  }
  for (const l of pls) {
    const twin = await tx.purchase_order_lines.findFirst({ where: { po_id: l.po_id, sku_id: target.id } });
    if (twin) {
      await tx.purchase_order_lines.update({ where: { id: twin.id }, data: { ordered_qty: { increment: l.ordered_qty }, uom_qty: { increment: l.uom_qty } } });
      await tx.purchase_order_lines.delete({ where: { id: l.id } });
    } else await tx.purchase_order_lines.update({ where: { id: l.id }, data: { sku_id: target.id } });
  }
  await tx.incidents.updateMany({ where: { sku_id: legacy.id }, data: { sku_id: target.id } });
  await tx.sku_barcodes.updateMany({ where: { sku_id: legacy.id }, data: { sku_id: target.id } }); // barcodes are globally unique: no clash possible
  await tx.sku_uoms.deleteMany({ where: { sku_id: legacy.id } });
  await tx.skus.delete({ where: { id: legacy.id } });
  await audit(tx, ctx, { action: 'sku.merge', entity_type: 'sku', entity_id: target.id, before: { merged_sku: legacy.code, merged_sku_id: legacy.id, order_lines: ols.length, po_lines: pls.length }, after: { code: target.code }, reason: 'SAE: clave duplicada del mismo producto (GTIN/modelo)' });
  return true;
}

export async function syncSkus(ctx: ActorContext, trigger: 'SCHEDULED' | 'MANUAL' = 'MANUAL'): Promise<SyncResult> {
  const cfg = saeConfig();
  return withRun('skus', trigger, ctx, async (c) => {
    const raw = requireSource(cfg.raw, 'raw');
    const erp = cfg.erp;
    const articles = await fetchAll<RawArticle>(raw, 'sae_inve01', { select: 'cve_art,descr,lin_prod,uni_med,uni_emp,fac_conv,peso,con_lote,status', order: 'cve_art' });
    c.source_rows = articles.length;
    const aliases = erp ? await fetchAll<Alias>(erp, 'sku_alias', { select: 'cve_art,modelo,capa' }) : [];
    const productos = erp ? await fetchAll<Producto>(erp, 'productos', { select: 'sku_interno,gtin,activo' }) : [];
    const lineas = erp ? await fetchAll<PedidoLinea>(erp, 'pedido_lineas', { select: 'sku_interno,gtin,piezas_por_caja' }) : [];
    // extra GTIN / alternate-key sources (tables the mirrors may not replicate yet)
    const missing: string[] = [];
    const alts = await optionalFetch<AltKey>(raw, 'sae_cves_alter01', missing);
    const obs = await optionalFetch<ObsRow>(raw, 'sae_obs_docf01', missing);
    const pars = obs.length ? await optionalFetch<ParObs>(raw, 'sae_par_factf01', missing) : [];
    const cerezo = erp ? await optionalFetch<CerezoRow>(erp, 'cerezo_sku_modelo', missing) : [];
    const knownModels = new Set([...articles.map((a) => stripDots(key(a.cve_art))), ...aliases.map((a) => key(a.modelo))]);
    const extra = extraGtinSources(alts, obs, pars, cerezo, knownModels, c);
    // order lines carry the platform GTIN too: they rank right after the catalogue, before SAE/scraper sources
    const catalogue: Producto[] = [...productos, ...lineas.filter((l) => l.gtin).map((l) => ({ sku_interno: l.sku_interno, gtin: l.gtin, activo: true })), ...extra.rows];
    const sourceOfGtin = new Map<string, string>();
    for (const r of catalogue) if (r.gtin && !sourceOfGtin.has(key(r.gtin))) sourceOfGtin.set(key(r.gtin), (r as { source?: string }).source ?? 'plataforma');
    const products = groupProducts(articles, aliases, catalogue, [], c);
    // case sizes come from order lines (groupProducts got them via catalogue only for GTIN): re-apply
    const ppc = new Map<string, number>();
    for (const l of lineas) if (num(l.piezas_por_caja) > 1) ppc.set(key(l.sku_interno), num(l.piezas_por_caja));
    for (const p of products) if (!p.caseQty) {
      const v = p.keys.map((k) => ppc.get(k.key) ?? ppc.get(stripDots(k.key))).find((x) => x && x > 1) ?? ppc.get(p.model);
      if (v) p.caseQty = BigInt(Math.round(v));
    }
    const productRefs = new Set(products.map((p) => p.model)); // external_refs that are products in this run: never treated as legacy
    const seen = new Set<string>();
    let merged = 0;
    let aliasCount = 0;
    const db = getDb();
    for (const p of products) {
      seen.add(p.model);
      try {
        await withTx(async (tx) => {
          const existing =
            (p.gtin ? await tx.skus.findUnique({ where: { gtin: p.gtin } }) : null) ??
            (await tx.skus.findFirst({ where: { external_source: 'SAE', external_ref: p.model } })) ??
            (await tx.skus.findUnique({ where: { code: p.code } }));
          const a = p.base;
          const data = {
            description: (a.descr ?? p.model).trim().slice(0, 300) || p.model,
            family: a.lin_prod ? key(a.lin_prod).slice(0, 60) : null,
            unit_weight_kg: num(a.peso) > 0 ? num(a.peso) : undefined,
            requires_lot: p.keys.some((k) => key(k.article.con_lote) === 'S'),
            external_source: 'SAE',
            external_ref: p.model.slice(0, 64),
            model_code: p.model.slice(0, 64),
            packaging_layer: null,
            gtin: p.gtin,
            is_active: p.keys.some((k) => key(k.article.status) === 'A'),
          };
          let sku: { id: string; code: string };
          if (existing) {
            if (existing.gtin && p.gtin && existing.gtin !== p.gtin) c.errors.push({ ref: p.model, message: `el WMS tiene GTIN ${existing.gtin} y SAE/plataforma ${p.gtin}; se actualizó al de la plataforma` });
            await tx.skus.update({ where: { id: existing.id }, data });
            sku = { id: existing.id, code: existing.code };
            c.updated++;
          } else {
            sku = await tx.skus.create({ data: { code: p.code, abc_class: 'C', ...data, uoms: { create: [{ uom_code: 'PIECE', base_qty: 1n }] } }, select: { id: true, code: true } });
            c.created++;
          }
          // SAE SKUs that stood for one of this product's keys or models (per-key rows of the first import, or a model
          // that the platform later tied to this GTIN) fold into the product — never another product of this run
          const refs = [...new Set(p.keys.flatMap((k) => [k.key, k.model]))].filter((r) => !productRefs.has(r) || r === p.model);
          const legacy = await tx.skus.findMany({ where: { external_source: 'SAE', external_ref: { in: refs }, id: { not: sku.id } }, select: { id: true, code: true, external_ref: true } });
          for (const l of legacy) if (!productRefs.has(l.external_ref!) || l.external_ref === p.model) if (await absorbLegacySku(tx, ctx, l, sku, c)) merged++;
          // UoM: PIECE always; CASE only when known and not already defined differently
          await tx.sku_uoms.upsert({ where: { sku_id_uom_code: { sku_id: sku.id, uom_code: 'PIECE' } }, create: { sku_id: sku.id, uom_code: 'PIECE', base_qty: 1n }, update: {} });
          let hasCase = false;
          const cur = await tx.sku_uoms.findUnique({ where: { sku_id_uom_code: { sku_id: sku.id, uom_code: 'CASE' } } });
          if (cur) {
            hasCase = true;
            if (p.caseQty && cur.base_qty !== p.caseQty) c.errors.push({ ref: p.model, message: `CASE en WMS = ${cur.base_qty} pero SAE/pedidos indican ${p.caseQty}; no se cambió (revisar)` });
          } else if (p.caseQty) {
            await tx.sku_uoms.create({ data: { sku_id: sku.id, uom_code: 'CASE', base_qty: p.caseQty } });
            hasCase = true;
          }
          // barcodes: the GTIN (piece) and every SAE key with its packaging level
          const wanted: { barcode: string; uom_code: string; ref: string }[] = [];
          if (p.gtin) wanted.push({ barcode: p.gtin, uom_code: 'PIECE', ref: p.model });
          for (const cg of p.caseGtins) {
            if (!hasCase) c.errors.push({ ref: cg, message: `GTIN de caja del producto ${sku.code} sin conversión de caja conocida: se registra como pieza` });
            wanted.push({ barcode: cg, uom_code: hasCase ? 'CASE' : 'PIECE', ref: p.model });
          }
          for (const k of p.keys) for (const alt of extra.aliases.get(k.key) ?? []) {
            const bc = saeKeyBarcode(alt).slice(0, 64);
            if (bc.length >= 3 && /^[\x21-\x7E]+$/.test(bc) && !wanted.some((w) => w.barcode === bc)) wanted.push({ barcode: bc, uom_code: 'PIECE', ref: k.key });
          }
          for (const k of p.keys) {
            const bc = saeKeyBarcode(k.key).slice(0, 64);
            if (bc.length < 3 || bc === p.gtin) continue;
            if (k.layer === 'CAJA' && !hasCase) c.errors.push({ ref: k.key, message: `clave de caja del producto ${sku.code} sin conversión de caja conocida: se registra como pieza` });
            wanted.push({ barcode: bc, uom_code: k.layer === 'CAJA' && hasCase ? 'CASE' : 'PIECE', ref: k.key });
          }
          for (const w of wanted) {
            const clash = await tx.sku_barcodes.findUnique({ where: { barcode: w.barcode }, include: { sku: { select: { code: true, external_source: true } } } });
            if (!clash) await tx.sku_barcodes.create({ data: { sku_id: sku.id, barcode: w.barcode, uom_code: w.uom_code } });
            else if (clash.sku_id !== sku.id) {
              // SAE aliases follow SAE: a key that now belongs to another product moves with it. Hand-made SKUs are never touched.
              if (clash.sku.external_source === 'SAE') await tx.sku_barcodes.update({ where: { id: clash.id }, data: { sku_id: sku.id, uom_code: w.uom_code } });
              else c.errors.push({ ref: w.ref, message: `código ${w.barcode} ya pertenece al SKU ${clash.sku.code} (no SAE); no se asignó a ${sku.code}` });
            } else if (clash.uom_code !== w.uom_code) await tx.sku_barcodes.update({ where: { id: clash.id }, data: { uom_code: w.uom_code } });
            else aliasCount++;
          }
        });
      } catch (e) {
        c.err(p.model, (e as Error).message.slice(0, 200));
      }
    }
    // SAE products that disappeared from the feed: deactivate only when they hold no inventory
    const stale = await db.skus.findMany({ where: { external_source: 'SAE', is_active: true, external_ref: { notIn: [...seen] } }, select: { id: true, code: true } });
    let deactivated = 0;
    for (const s of stale) {
      const inv = await db.inventory_balances.count({ where: { sku_id: s.id, qty: { gt: 0n } } });
      if (inv === 0) {
        await db.skus.update({ where: { id: s.id }, data: { is_active: false } });
        deactivated++;
      } else c.errors.push({ ref: s.code, message: 'ya no existe en SAE pero tiene inventario en el WMS; sigue activo' });
    }
    const bySource: Record<string, number> = {};
    for (const p of products) if (p.gtin) bySource[sourceOfGtin.get(p.gtin) ?? '?'] = (bySource[sourceOfGtin.get(p.gtin) ?? '?'] ?? 0) + 1;
    const gtinNote = Object.entries(bySource).map(([k, v]) => `${k}=${v}`).join(',');
    return `productos=${products.length} claves=${articles.length} con_gtin=${products.filter((p) => p.gtin).length} (${gtinNote}) fusionados=${merged} alias_ok=${aliasCount} desactivados=${deactivated}${missing.length ? ` · tablas no espejeadas: ${missing.map((m) => m.split(' ')[0]).join(', ')}` : ''}`;
  });
}

/** Any SAE key / GTIN / model → the WMS product it belongs to (with the packaging level the key represents). */
export async function resolveSaeKey(tx: Tx, saeKey: string, gtin?: string | null): Promise<{ id: string; code: string; is_active: boolean; uom_code: string } | null> {
  const k = key(saeKey);
  const bc = saeKeyBarcode(k);
  if (bc) {
    const b = await tx.sku_barcodes.findUnique({ where: { barcode: bc }, include: { sku: { select: { id: true, code: true, is_active: true } } } });
    if (b) return { ...b.sku, uom_code: b.uom_code };
  }
  if (gtin && GTIN_RE.test(key(gtin))) {
    const s = await tx.skus.findUnique({ where: { gtin: key(gtin) }, select: { id: true, code: true, is_active: true } });
    if (s) return { ...s, uom_code: 'PIECE' };
    const b = await tx.sku_barcodes.findUnique({ where: { barcode: key(gtin) }, include: { sku: { select: { id: true, code: true, is_active: true } } } });
    if (b) return { ...b.sku, uom_code: 'PIECE' };
  }
  for (const cnd of [...new Set([k, stripDots(k)])].filter(Boolean)) {
    const s = (await tx.skus.findFirst({ where: { external_source: 'SAE', external_ref: cnd }, select: { id: true, code: true, is_active: true } })) ?? (await tx.skus.findUnique({ where: { code: saeKeyBarcode(cnd) }, select: { id: true, code: true, is_active: true } }));
    if (s) return { ...s, uom_code: 'PIECE' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Customers & suppliers
// ---------------------------------------------------------------------------
interface RawParty { clave: string; nombre: string | null; rfc: string | null; status: string; calle?: string | null; numext?: string | null; colonia?: string | null; municipio?: string | null; estado?: string | null; codigo?: string | null; mail?: string | null; telefono?: string | null }
interface PedidosCliente { id: string; nombre: string; codigo_interno: string | null; cliente_sae_id: string | null; rfc: string | null; razon_social: string | null; activo: boolean }

const addr = (p: RawParty) => [p.calle, p.numext, p.colonia, p.municipio, p.estado, p.codigo].map((x) => key(x)).filter(Boolean).join(', ').slice(0, 500) || null;

export async function syncCustomers(ctx: ActorContext, trigger: 'SCHEDULED' | 'MANUAL' = 'MANUAL'): Promise<SyncResult> {
  const cfg = saeConfig();
  return withRun('customers', trigger, ctx, async (c) => {
    const raw = requireSource(cfg.raw, 'raw');
    const rows = await fetchAll<RawParty>(raw, 'sae_clie01', { select: 'clave,nombre,rfc,status,calle,numext,colonia,municipio,estado,codigo', order: 'clave' });
    const retail = cfg.erp ? await fetchAll<PedidosCliente>(cfg.erp, 'clientes', { select: 'id,nombre,codigo_interno,cliente_sae_id,rfc,razon_social,activo' }) : [];
    c.source_rows = rows.length + retail.length;
    const db = getDb();
    for (const r of rows) {
      const code = key(r.clave);
      if (!code) continue;
      const data = { name: key(r.nombre).slice(0, 200) || code, tax_id: key(r.rfc).slice(0, 40) || null, address: addr(r), external_source: 'SAE', external_ref: code, is_active: key(r.status) === 'A' };
      const existing = (await db.customers.findFirst({ where: { external_source: 'SAE', external_ref: code } })) ?? (await db.customers.findUnique({ where: { code } }));
      if (existing) {
        await db.customers.update({ where: { id: existing.id }, data });
        c.updated++;
      } else {
        await db.customers.create({ data: { code, ...data } });
        c.created++;
      }
    }
    // retail accounts of the orders platform (WALMART, HEB, ...): separate identity unless linked to a SAE client
    for (const r of retail) {
      const code = key(r.codigo_interno) || key(r.nombre).toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 40);
      if (!code) continue;
      const linked = r.cliente_sae_id ? await db.customers.findFirst({ where: { external_source: 'SAE', external_ref: key(r.cliente_sae_id) } }) : null;
      const existing = linked ?? (await db.customers.findFirst({ where: { external_source: 'PEDIDOS', external_ref: r.id } })) ?? (await db.customers.findUnique({ where: { code } }));
      const data = { name: key(r.razon_social) || key(r.nombre) || code, tax_id: key(r.rfc) || undefined, is_active: r.activo !== false };
      if (existing) {
        await db.customers.update({ where: { id: existing.id }, data: { ...data, ...(linked ? {} : { external_source: 'PEDIDOS', external_ref: r.id }) } });
        c.updated++;
      } else {
        await db.customers.create({ data: { code, ...data, external_source: 'PEDIDOS', external_ref: r.id } });
        c.created++;
      }
    }
  });
}

export async function syncSuppliers(ctx: ActorContext, trigger: 'SCHEDULED' | 'MANUAL' = 'MANUAL'): Promise<SyncResult> {
  const cfg = saeConfig();
  return withRun('suppliers', trigger, ctx, async (c) => {
    const raw = requireSource(cfg.raw, 'raw');
    const rows = await fetchAll<RawParty>(raw, 'sae_prov01', { select: 'clave,nombre,rfc,status,mail,telefono', order: 'clave' });
    c.source_rows = rows.length;
    const db = getDb();
    for (const r of rows) {
      const code = key(r.clave);
      if (!code) continue;
      const data = { name: key(r.nombre).slice(0, 200) || code, tax_id: key(r.rfc).slice(0, 40) || null, contact: [key(r.mail), key(r.telefono)].filter(Boolean).join(' · ').slice(0, 500) || null, external_source: 'SAE', external_ref: code, is_active: key(r.status) === 'A' };
      const existing = (await db.suppliers.findFirst({ where: { external_source: 'SAE', external_ref: code } })) ?? (await db.suppliers.findUnique({ where: { code } }));
      if (existing) {
        await db.suppliers.update({ where: { id: existing.id }, data });
        c.updated++;
      } else {
        await db.suppliers.create({ data: { code, ...data } });
        c.created++;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Purchase orders (SAE compras) → expected receipts
// ---------------------------------------------------------------------------
interface Compra { cve_doc: string; tipo: string | null; cve_prov: string | null; fecha: string | null; fecha_rec: string | null; estado: string | null; su_refer: string | null }
interface CompraLinea { cve_doc: string; cve_art: string; cantidad: number | null; costo: number | null }

export async function syncPurchaseOrders(ctx: ActorContext, trigger: 'SCHEDULED' | 'MANUAL' = 'MANUAL'): Promise<SyncResult> {
  const cfg = saeConfig();
  return withRun('purchase_orders', trigger, ctx, async (c) => {
    const erp = requireSource(cfg.erp, 'erp');
    const since = new Date(Date.now() - cfg.poSinceDays * 86400_000).toISOString().slice(0, 10);
    const compras = await fetchAll<Compra>(erp, 'sae_compras', { select: 'cve_doc,tipo,cve_prov,fecha,fecha_rec,estado,su_refer', estado: 'eq.E', fecha: `gte.${since}`, order: 'fecha.desc' });
    c.source_rows = compras.length;
    if (!compras.length) return `sin órdenes de compra emitidas desde ${since}`;
    const docs = compras.map((x) => key(x.cve_doc));
    const lines = await fetchAll<CompraLinea>(erp, 'sae_compras_lineas', { select: 'cve_doc,cve_art,cantidad,costo', cve_doc: `in.(${compras.map((x) => `"${String(x.cve_doc).replace(/"/g, '')}"`).join(',')})` });
    const byDoc = new Map<string, CompraLinea[]>();
    for (const l of lines) byDoc.set(key(l.cve_doc), [...(byDoc.get(key(l.cve_doc)) ?? []), l]);
    for (const po of compras) {
      const number = key(po.cve_doc);
      if (!docs.includes(number)) continue;
      try {
        await withTx(async (tx) => {
          const supplierCode = key(po.cve_prov);
          const supplier = (await tx.suppliers.findFirst({ where: { external_source: 'SAE', external_ref: supplierCode } })) ?? (await tx.suppliers.findUnique({ where: { code: supplierCode } }));
          if (!supplier) throw new Error(`proveedor SAE ${supplierCode || '?'} no existe en el WMS (sincronice proveedores)`);
          // aggregate lines per SKU (SAE may repeat an article)
          const agg = new Map<string, bigint>();
          for (const l of byDoc.get(number) ?? []) {
            const q = BigInt(Math.round(num(l.cantidad)));
            if (q <= 0n) continue;
            agg.set(key(l.cve_art), (agg.get(key(l.cve_art)) ?? 0n) + q);
          }
          if (agg.size === 0) throw new Error('sin líneas con cantidad > 0');
          // several SAE keys may be the same product: aggregate again per WMS SKU (quantities are pieces)
          const perSku = new Map<string, bigint>();
          const missing: string[] = [];
          for (const [art, qty] of agg) {
            const sku = await resolveSaeKey(tx, art);
            if (!sku) missing.push(art);
            else perSku.set(sku.id, (perSku.get(sku.id) ?? 0n) + qty);
          }
          if (missing.length) throw new Error(`SKUs no encontrados: ${missing.join(', ')}`);
          const resolved = [...perSku].map(([sku_id, qty]) => ({ sku_id, qty }));
          const existing = (await tx.purchase_orders.findFirst({ where: { external_source: 'SAE', external_ref: number } })) ?? (await tx.purchase_orders.findUnique({ where: { po_number: number } }));
          const header = { supplier_id: supplier.id, expected_date: po.fecha_rec ? new Date(po.fecha_rec) : po.fecha ? new Date(po.fecha) : null, notes: key(po.su_refer) ? `Ref. proveedor: ${key(po.su_refer)}` : null, external_source: 'SAE', external_ref: number };
          if (existing) {
            const received = await tx.purchase_order_lines.aggregate({ where: { po_id: existing.id }, _sum: { received_qty: true } });
            if (existing.status !== 'OPEN' || (received._sum.received_qty ?? 0n) > 0n) {
              c.skipped++;
              return;
            }
            await tx.purchase_orders.update({ where: { id: existing.id }, data: header });
            await tx.purchase_order_lines.deleteMany({ where: { po_id: existing.id } });
            await tx.purchase_order_lines.createMany({ data: resolved.map((r, i) => ({ po_id: existing.id, line_no: i + 1, sku_id: r.sku_id, ordered_qty: r.qty, uom_code: 'PIECE', uom_qty: r.qty })) });
            c.updated++;
          } else {
            await tx.purchase_orders.create({ data: { po_number: number, ...header, created_by: null, lines: { create: resolved.map((r, i) => ({ line_no: i + 1, sku_id: r.sku_id, ordered_qty: r.qty, uom_code: 'PIECE', uom_qty: r.qty })) } } });
            c.created++;
          }
        });
      } catch (e) {
        c.err(number, (e as Error).message.slice(0, 200));
      }
    }
    return `desde ${since}`;
  });
}

// ---------------------------------------------------------------------------
// Customer orders (retail POs from the PEDIDOS platform) → WMS orders
// ---------------------------------------------------------------------------
interface Pedido { id: string; cliente_id: string; num_orden_compra: string; fecha_pedido: string | null; fecha_envio: string | null; fecha_cancelacion: string | null; cedis_codigo: string | null; estatus: string; instrucciones?: string | null }
interface PedidoLineaFull { pedido_id: string; num_linea: string; sku_cliente: string | null; sku_interno: string | null; gtin: string | null; cantidad: number | null; cantidad_surtir: number | null; uom: string | null; piezas_por_caja: number | null }
interface Cedis { codigo: string; nombre: string | null; ciudad: string | null; estado: string | null }

const CANCELLED_STATES = new Set(['cancelado', 'cancelada', 'rechazado', 'rechazada']);
const CLOSED_STATES = new Set(['surtido', 'embarcado', 'facturado', 'entregado', 'cerrado', 'completado']);

export async function syncCustomerOrders(ctx: ActorContext, trigger: 'SCHEDULED' | 'MANUAL' = 'MANUAL'): Promise<SyncResult> {
  const cfg = saeConfig();
  return withRun('customer_orders', trigger, ctx, async (c) => {
    const erp = requireSource(cfg.erp, 'erp');
    const since = new Date(Date.now() - cfg.poSinceDays * 86400_000).toISOString().slice(0, 10);
    const pedidos = await fetchAll<Pedido>(erp, 'pedidos', { select: 'id,cliente_id,num_orden_compra,fecha_pedido,fecha_envio,fecha_cancelacion,cedis_codigo,estatus,instrucciones', fecha_pedido: `gte.${since}`, order: 'fecha_pedido.desc' });
    c.source_rows = pedidos.length;
    if (!pedidos.length) return `sin pedidos desde ${since}`;
    const lines = await fetchAll<PedidoLineaFull>(erp, 'pedido_lineas', { select: 'pedido_id,num_linea,sku_cliente,sku_interno,gtin,cantidad,cantidad_surtir,uom,piezas_por_caja', pedido_id: `in.(${pedidos.map((p) => p.id).join(',')})` });
    const cedis = await fetchAll<Cedis>(erp, 'cedis', { select: 'codigo,nombre,ciudad,estado' }).catch(() => [] as Cedis[]);
    const cedisByCode = new Map(cedis.map((x) => [key(x.codigo), x]));
    const byPedido = new Map<string, PedidoLineaFull[]>();
    for (const l of lines) byPedido.set(l.pedido_id, [...(byPedido.get(l.pedido_id) ?? []), l]);
    for (const p of pedidos) {
      const ref = p.id;
      const number = key(p.num_orden_compra);
      const st = key(p.estatus).toLowerCase();
      try {
        await withTx(async (tx) => {
          const existing = await tx.orders.findFirst({ where: { source: 'SAE', external_ref: ref } });
          if (CANCELLED_STATES.has(st)) {
            if (!existing || existing.status === 'CANCELLED') {
              c.skipped++;
              return;
            }
            if (['IMPORTED', 'ACCEPTED', 'ALLOCATED', 'PARTIALLY_ALLOCATED'].includes(existing.status)) {
              await cancelOrder(tx, ctx, { order_id: existing.id, reason: `Cancelado en la plataforma de pedidos (estatus ${st})` });
              c.updated++;
            } else {
              await createIncident(tx, ctx, { incident_type: 'OTHER', severity: 'HIGH', title: `Pedido ${existing.order_number} cancelado externamente durante surtido/embarque`, description: `La plataforma de pedidos reporta estatus '${st}'. Revisar antes de embarcar.`, entity_type: 'order', entity_id: existing.id, order_id: existing.id });
              c.errors.push({ ref: number, message: 'cancelado externamente con surtido en curso: incidencia creada' });
            }
            return;
          }
          if (CLOSED_STATES.has(st)) {
            c.skipped++;
            return;
          }
          if (existing && existing.status !== 'IMPORTED') {
            c.skipped++; // already being worked in the warehouse: never rewrite
            return;
          }
          const customer = await tx.customers.findFirst({ where: { external_source: 'PEDIDOS', external_ref: p.cliente_id } });
          if (!customer) throw new Error(`cliente ${p.cliente_id} no sincronizado (ejecute clientes)`);
          const ls = byPedido.get(p.id) ?? [];
          if (!ls.length) throw new Error('pedido sin líneas');
          // lines are pieces (cantidad_surtir); several keys of the same product collapse into one WMS line
          const perSku = new Map<string, { sku_code: string; qty: bigint }>();
          const missing: string[] = [];
          for (const l of ls) {
            const qty = BigInt(Math.round(num(l.cantidad_surtir ?? l.cantidad)));
            if (qty <= 0n) continue;
            const sku = l.sku_interno || l.gtin ? await resolveSaeKey(tx, l.sku_interno ?? '', l.gtin) : null;
            if (!sku || !sku.is_active) {
              missing.push(`${l.num_linea}:${key(l.sku_interno) || key(l.sku_cliente) || key(l.gtin)}${sku ? ' (inactivo)' : ''}`);
              continue;
            }
            const cur = perSku.get(sku.id);
            if (cur) cur.qty += qty;
            else perSku.set(sku.id, { sku_code: sku.code, qty });
          }
          const resolved = [...perSku.values()];
          if (missing.length) throw new Error(`líneas sin SKU en el WMS: ${missing.join(', ')}`);
          if (!resolved.length) throw new Error('sin líneas con cantidad > 0');
          const cd = p.cedis_codigo ? cedisByCode.get(key(p.cedis_codigo)) : undefined;
          const destination = [key(p.cedis_codigo), cd ? key(cd.nombre) : '', cd ? [key(cd.ciudad), key(cd.estado)].filter(Boolean).join(', ') : ''].filter(Boolean).join(' · ').slice(0, 500) || undefined;
          const daysLeft = p.fecha_cancelacion ? Math.floor((new Date(p.fecha_cancelacion).getTime() - Date.now()) / 86400_000) : 99;
          const priority = daysLeft <= 1 ? 1 : daysLeft <= 3 ? 2 : daysLeft <= 6 ? 3 : 5;
          const notes = [`Pedido plataforma ${p.id}`, p.fecha_envio ? `Envío: ${p.fecha_envio}` : '', p.fecha_cancelacion ? `Cancela: ${p.fecha_cancelacion}` : '', key(p.instrucciones)].filter(Boolean).join(' · ').slice(0, 2000);
          if (existing) {
            await tx.order_lines.deleteMany({ where: { order_id: existing.id } });
            await tx.orders.update({ where: { id: existing.id }, data: { customer_id: customer.id, destination: destination ?? null, order_date: p.fecha_pedido ? new Date(p.fecha_pedido) : null, priority, notes, version: { increment: 1 } } });
            const skuRows = await tx.skus.findMany({ where: { code: { in: resolved.map((r) => r.sku_code) } } });
            await tx.order_lines.createMany({ data: resolved.map((r, i) => ({ order_id: existing.id, line_no: i + 1, sku_id: skuRows.find((s) => s.code === r.sku_code)!.id, required_qty: r.qty, uom_code: 'PIECE', uom_qty: r.qty })) });
            c.updated++;
          } else {
            let orderNumber = number || `PED-${p.id.slice(0, 8)}`;
            const clash = await tx.orders.findUnique({ where: { order_number: orderNumber } });
            if (clash && clash.external_ref !== ref) orderNumber = `${orderNumber}-${customer.code}`;
            await createOrder(tx, ctx, { order_number: orderNumber, customer_code: customer.code, destination, order_date: p.fecha_pedido ? new Date(p.fecha_pedido) : undefined, priority, external_ref: ref, notes, source: 'SAE', lines: resolved.map((r) => ({ sku_code: r.sku_code, qty: r.qty, uom_code: 'PIECE' })) });
            c.created++;
          }
        });
      } catch (e) {
        c.err(number || ref, (e as Error).message.slice(0, 200));
      }
    }
    return `desde ${since}`;
  });
}

// ---------------------------------------------------------------------------
// Stock comparison (never applied automatically)
// ---------------------------------------------------------------------------
interface SaeStock { cve_art: string; descripcion: string | null; existencia: number | null; actualizado_en: string | null }

const abs = (v: bigint) => (v < 0n ? -v : v);

/** SAE existencias (per key, in the key's unit) vs WMS totals per product (pieces). Never applied. */
export async function compareStock() {
  const cfg = saeConfig();
  const erp = requireSource(cfg.erp, 'erp');
  const rows = await fetchAll<SaeStock>(erp, 'sae_inventario', { select: 'cve_art,descripcion,existencia,actualizado_en', order: 'cve_art' });
  const db = getDb();
  const wms = await db.$queryRaw<{ sku_id: string; code: string; gtin: string | null; description: string; total: bigint; available: bigint }[]>`
    SELECT s.id AS sku_id, s.code, s.gtin, s.description, COALESCE(sum(b.qty), 0)::bigint AS total, COALESCE(sum(b.qty) FILTER (WHERE b.status = 'AVAILABLE'), 0)::bigint AS available
      FROM skus s LEFT JOIN inventory_balances b ON b.sku_id = s.id AND b.qty > 0
     WHERE s.external_source = 'SAE' GROUP BY s.id`;
  const aliases = await db.$queryRaw<{ barcode: string; sku_id: string; factor: bigint | null }[]>`
    SELECT b.barcode, b.sku_id, u.base_qty AS factor FROM sku_barcodes b JOIN skus s ON s.id = b.sku_id
      LEFT JOIN sku_uoms u ON u.sku_id = b.sku_id AND u.uom_code = b.uom_code WHERE s.external_source = 'SAE'`;
  const bySku = new Map(wms.map((w) => [w.sku_id, w]));
  const byAlias = new Map(aliases.map((a) => [a.barcode, a]));
  type Line = { sku: string; gtin: string | null; description: string | null; in_wms: boolean; sae_existencia: bigint; wms_total: bigint; wms_available: bigint; diff: bigint; sae_keys: { key: string; existencia: bigint; factor: bigint }[] };
  const lines = new Map<string, Line>();
  for (const r of rows) {
    const k = key(r.cve_art);
    const alias = byAlias.get(saeKeyBarcode(k));
    const w = alias ? bySku.get(alias.sku_id) : undefined;
    const factor = alias?.factor ?? 1n;
    const existencia = BigInt(Math.round(num(r.existencia)));
    const id = w ? w.sku_id : `sae:${k}`;
    let line = lines.get(id);
    if (!line) lines.set(id, (line = { sku: w?.code ?? k, gtin: w?.gtin ?? null, description: w?.description ?? r.descripcion, in_wms: !!w, sae_existencia: 0n, wms_total: w?.total ?? 0n, wms_available: w?.available ?? 0n, diff: 0n, sae_keys: [] }));
    line.sae_existencia += existencia * factor;
    line.sae_keys.push({ key: k, existencia, factor });
  }
  for (const l of lines.values()) l.diff = l.wms_total - l.sae_existencia;
  const all = [...lines.values()];
  const differing = all.filter((l) => l.diff !== 0n);
  return {
    checked_at: new Date().toISOString(),
    sae_updated_at: rows[0]?.actualizado_en ?? null,
    skus_sae: rows.length,
    products: all.length,
    skus_matching: all.length - differing.length,
    skus_differing: differing.length,
    sae_units: all.reduce((a, l) => a + l.sae_existencia, 0n),
    wms_units: all.reduce((a, l) => a + l.wms_total, 0n),
    differences: differing.sort((a, b) => (abs(b.diff) > abs(a.diff) ? 1 : abs(b.diff) < abs(a.diff) ? -1 : a.sku.localeCompare(b.sku))).slice(0, 2000),
  };
}

export async function syncAll(ctx: ActorContext, trigger: 'SCHEDULED' | 'MANUAL', entities: readonly SaeEntity[] = SAE_ENTITIES): Promise<SyncResult[]> {
  const out: SyncResult[] = [];
  // master data first so documents can resolve references
  const order: SaeEntity[] = ['suppliers', 'customers', 'skus', 'purchase_orders', 'customer_orders'];
  for (const e of order) {
    if (!entities.includes(e)) continue;
    const fn = { skus: syncSkus, customers: syncCustomers, suppliers: syncSuppliers, purchase_orders: syncPurchaseOrders, customer_orders: syncCustomerOrders }[e];
    out.push(await fn(ctx, trigger));
  }
  return out;
}

/** Scheduled entry point: one instance at a time (advisory lock), silent when not configured. */
export async function scheduledSaeSync(ctx: ActorContext): Promise<SyncResult[] | { skipped: string }> {
  const cfg = saeConfig();
  if (!cfg.erp && !cfg.raw) return { skipped: 'not configured' };
  const db = getDb();
  const lock = await db.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(hashtext('sae-sync')) AS ok`;
  if (!lock[0]?.ok) return { skipped: 'another instance is syncing' };
  try {
    return await syncAll(ctx, 'SCHEDULED');
  } finally {
    await db.$queryRaw`SELECT pg_advisory_unlock(hashtext('sae-sync'))`;
  }
}
