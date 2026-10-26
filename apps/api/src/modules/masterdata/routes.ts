import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validateUomHierarchy, zCreateParty, zCreateSku, zUpdateSku, zUuid } from '@wms/shared';
import { getDb, withTx } from '../../db.js';
import { ConflictError, NotFoundError, RuleError } from '../../errors.js';
import { audit } from '../../lib/audit.js';
import { decryptSecret, encryptSecret, generateToken, sha256 } from '../../lib/crypto.js';
import { loadConfig } from '../../config.js';
import { publicOrigin } from '../../lib/public-origin.js';

const zList = z.object({
  q: z.string().trim().max(100).optional(),
  active: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function masterDataRoutes(app: FastifyInstance) {
  const db = getDb();

  // ---------------- SKUs ----------------
  app.get('/skus', { preHandler: app.requirePermission('masterdata.read') }, async (req) => {
    const q = zList.parse(req.query);
    const where = {
      ...(q.q ? { OR: [{ code: { contains: q.q, mode: 'insensitive' as const } }, { description: { contains: q.q, mode: 'insensitive' as const } }, { gtin: q.q }, { barcodes: { some: { barcode: { contains: q.q, mode: 'insensitive' as const } } } }] } : {}),
      ...(q.active ? { is_active: q.active === 'true' } : {}),
    };
    const [items, total] = await Promise.all([
      db.skus.findMany({ where, include: { uoms: true, barcodes: true }, orderBy: { code: 'asc' }, take: q.limit, skip: q.offset }),
      db.skus.count({ where }),
    ]);
    return { items, total };
  });

  /** Resolve a scanned barcode (or SKU code) to its SKU, packaging level and UoM table — read-only, for handheld screens. */
  app.get('/skus/by-barcode/:barcode', { preHandler: app.requireAuth }, async (req) => {
    const barcode = (req.params as { barcode: string }).barcode;
    if (/^LOC-/i.test(barcode.trim())) throw new RuleError('NOT_A_PRODUCT', `ESO ES UNA UBICACIÓN (${barcode.trim()}), NO UN PRODUCTO: escanea la caja o la pieza`, { scanned: barcode.trim(), kind: 'LOCATION' });
    if (/^PLT-/i.test(barcode.trim())) throw new RuleError('NOT_A_PRODUCT', `ESO ES UNA TARIMA (${barcode.trim()}), NO UN PRODUCTO: escanea la caja o la pieza`, { scanned: barcode.trim(), kind: 'LPN' });
    const { resolveSkuBarcode, uomTableFor } = await import('../../lib/lookup.js');
    return withTx(async (tx) => {
      const r = await resolveSkuBarcode(tx, barcode);
      const uoms = await tx.sku_uoms.findMany({ where: { sku_id: r.sku.id }, orderBy: { base_qty: 'asc' } });
      await uomTableFor(tx, r.sku.id);
      return { sku: { id: r.sku.id, code: r.sku.code, description: r.sku.description, requires_lot: r.sku.requires_lot, requires_expiry: r.sku.requires_expiry, is_active: r.sku.is_active }, uom_code: r.uom_code, uoms: uoms.map((u) => ({ uom_code: u.uom_code, base_qty: u.base_qty })) };
    });
  });

  app.get('/skus/:id', { preHandler: app.requirePermission('masterdata.read') }, async (req) => {
    const id = (req.params as { id: string }).id;
    const sku = await db.skus.findFirst({ where: { OR: [{ id: z.string().uuid().safeParse(id).success ? id : undefined }, { code: id }] }, include: { uoms: true, barcodes: true } });
    if (!sku) throw new NotFoundError('SKU', id);
    const inventory = await db.$queryRaw<{ status: string; qty: bigint; lpn_count: number }[]>`
      SELECT status, qty, lpn_count FROM v_sku_inventory WHERE sku_id = ${sku.id}::uuid`;
    return { ...sku, inventory };
  });

  app.post('/skus', { preHandler: app.requirePermission('masterdata.manage') }, async (req, reply) => {
    const body = zCreateSku.parse(req.body);
    const uoms = normalizeUoms(body.uoms);
    for (const b of body.barcodes) if (!uoms.some((u) => u.uom_code === b.uom_code)) throw new RuleError('BARCODE_UOM_ORPHAN', `Barcode ${b.barcode} references UoM ${b.uom_code} which the SKU does not define`);
    const sku = await withTx(async (tx) => {
      if (await tx.skus.findUnique({ where: { code: body.code } })) throw new ConflictError('SKU_EXISTS', `SKU ${body.code} already exists`);
      for (const b of body.barcodes) {
        const clash = await tx.sku_barcodes.findUnique({ where: { barcode: b.barcode } });
        if (clash) throw new ConflictError('BARCODE_EXISTS', `Barcode ${b.barcode} is already assigned`);
      }
      const s = await tx.skus.create({
        data: {
          code: body.code,
          description: body.description,
          family: body.family ?? null,
          compatibility_group: body.compatibility_group ?? null,
          abc_class: body.abc_class,
          unit_weight_kg: body.unit_weight_kg,
          case_length_cm: body.case_length_cm ?? null,
          case_width_cm: body.case_width_cm ?? null,
          case_height_cm: body.case_height_cm ?? null,
          pallet_height_cm: body.pallet_height_cm ?? null,
          requires_lot: body.requires_lot,
          requires_expiry: body.requires_expiry,
          color: body.color ?? null,
          uoms: { create: uoms.map((u) => ({ uom_code: u.uom_code, base_qty: u.base_qty })) },
          barcodes: { create: body.barcodes.map((b) => ({ barcode: b.barcode, uom_code: b.uom_code })) },
        },
        include: { uoms: true, barcodes: true },
      });
      await audit(tx, req.actor!, { action: 'sku.create', entity_type: 'sku', entity_id: s.id, after: s });
      return s;
    });
    reply.status(201);
    return sku;
  });

  app.patch('/skus/:id', { preHandler: app.requirePermission('masterdata.manage') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const body = zUpdateSku.parse(req.body);
    return withTx(async (tx) => {
      const before = await tx.skus.findUnique({ where: { id }, include: { uoms: true, barcodes: true } });
      if (!before) throw new NotFoundError('SKU', id);
      const { uoms, barcodes, ...rest } = body;
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) data[k] = v;
      // a name typed here is a decision: from now on the SAE sync leaves it alone (unless explicitly unlocked)
      if (body.description !== undefined && body.description !== before.description && body.description_locked === undefined) data.description_locked = true;
      await tx.skus.update({ where: { id }, data });
      if (uoms) {
        const norm = normalizeUoms(uoms);
        // UoM changes must keep every barcode (existing or incoming) resolvable
        const futureBarcodes = barcodes ?? before.barcodes;
        const orphan = futureBarcodes.filter((b) => !norm.some((u) => u.uom_code === b.uom_code));
        if (orphan.length) throw new RuleError('BARCODE_UOM_ORPHAN', `Barcodes ${orphan.map((b) => b.barcode).join(', ')} reference a UoM that would no longer exist`);
        await tx.sku_uoms.deleteMany({ where: { sku_id: id } });
        await tx.sku_uoms.createMany({ data: norm.map((u) => ({ sku_id: id, uom_code: u.uom_code, base_qty: u.base_qty })) });
      }
      if (barcodes) {
        const uomSet = uoms ? normalizeUoms(uoms) : before.uoms;
        for (const b of barcodes) {
          if (!uomSet.some((u) => u.uom_code === b.uom_code)) throw new RuleError('BARCODE_UOM_ORPHAN', `Barcode ${b.barcode} references UoM ${b.uom_code} which the SKU does not define`);
          const clash = await tx.sku_barcodes.findUnique({ where: { barcode: b.barcode } });
          if (clash && clash.sku_id !== id) throw new ConflictError('BARCODE_EXISTS', `Barcode ${b.barcode} belongs to another SKU`);
        }
        await tx.sku_barcodes.deleteMany({ where: { sku_id: id } });
        await tx.sku_barcodes.createMany({ data: barcodes.map((b) => ({ sku_id: id, barcode: b.barcode, uom_code: b.uom_code })) });
      }
      const after = await tx.skus.findUnique({ where: { id }, include: { uoms: true, barcodes: true } });
      await audit(tx, req.actor!, { action: 'sku.update', entity_type: 'sku', entity_id: id, before, after });
      return after;
    });
  });

  // ---------------- parties ----------------
  for (const [path, table, label] of [
    ['customers', 'customers', 'customer'],
    ['suppliers', 'suppliers', 'supplier'],
    ['carriers', 'carriers', 'carrier'],
  ] as const) {
    app.get(`/${path}`, { preHandler: app.requirePermission('masterdata.read') }, async (req) => {
      const q = zList.parse(req.query);
      const where = q.q ? { OR: [{ code: { contains: q.q, mode: 'insensitive' as const } }, { name: { contains: q.q, mode: 'insensitive' as const } }] } : {};
      const model = (db as any)[table];
      const [items, total] = await Promise.all([model.findMany({ where, orderBy: { code: 'asc' }, take: q.limit, skip: q.offset }), model.count({ where })]);
      return { items, total };
    });
    app.post(`/${path}`, { preHandler: app.requirePermission('masterdata.manage') }, async (req, reply) => {
      const body = zCreateParty.parse(req.body);
      const row = await withTx(async (tx) => {
          const model = (tx as any)[table];
        if (await model.findUnique({ where: { code: body.code } })) throw new ConflictError('CODE_EXISTS', `${label} ${body.code} already exists`);
        const data: Record<string, unknown> = { code: body.code, name: body.name };
        if (table !== 'carriers') data.tax_id = body.tax_id ?? null;
        if (table === 'suppliers') data.contact = body.contact ?? null;
        if (table === 'customers') data.address = body.address ?? null;
        const r = await model.create({ data });
        await audit(tx, req.actor!, { action: `${label}.create`, entity_type: label, entity_id: r.id, after: r });
        return r;
      });
      reply.status(201);
      return row;
    });
    app.patch(`/${path}/:id`, { preHandler: app.requirePermission('masterdata.manage') }, async (req) => {
      const id = zUuid.parse((req.params as { id: string }).id);
      const body = zCreateParty.partial().extend({ is_active: z.boolean().optional() }).parse(req.body);
      return withTx(async (tx) => {
          const model = (tx as any)[table];
        const before = await model.findUnique({ where: { id } });
        if (!before) throw new NotFoundError(label, id);
        const data: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(body)) if (v !== undefined && k !== 'code') data[k] = v;
        const after = await model.update({ where: { id }, data });
        await audit(tx, req.actor!, { action: `${label}.update`, entity_type: label, entity_id: id, before, after });
        return after;
      });
    });
  }

  // ---------------- printers ----------------
  const zPrinter = z.object({
    code: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(120),
    // printers live on the LAN: private IPv4 or a plain hostname (no schemes/paths) — prevents using the API as a TCP relay
    host: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((h) => /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|[A-Za-z0-9][A-Za-z0-9.-]{0,253})$/.test(h) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(h.replace(/^(10|172\.(1[6-9]|2\d|3[01])|192\.168|127)\..*/, '')), 'printer host must be a private IPv4 address or a LAN hostname'),
    port: z.number().int().min(1).max(65535).default(9100),
    /** NETWORK: the API opens TCP 9100 to `host`. AGENT: a PC with the printer on USB pulls the queue (host is informative). */
    mode: z.enum(['NETWORK', 'AGENT']).default('NETWORK'),
    dpi: z.union([z.literal(203), z.literal(300)]).default(203),
    label_width_mm: z.number().int().min(20).max(300).default(100),
    label_height_mm: z.number().int().min(20).max(400).default(150),
    is_default: z.boolean().default(false),
  });
  app.get('/printers', { preHandler: app.requireAuth }, async () => db.printers.findMany({ orderBy: { code: 'asc' } }));
  app.post('/printers', { preHandler: app.requirePermission('printers.manage') }, async (req, reply) => {
    const body = zPrinter.parse(req.body);
    const p = await withTx(async (tx) => {
      if (body.is_default) await tx.printers.updateMany({ data: { is_default: false } });
      const r = await tx.printers.create({ data: body });
      await audit(tx, req.actor!, { action: 'printer.create', entity_type: 'printer', entity_id: r.id, after: r });
      return r;
    });
    reply.status(201);
    return p;
  });
  /** Generates (or rotates) the token the print agent on the PC uses. Shown once; only the hash is stored. */
  app.post('/printers/:id/agent-token', { preHandler: app.requirePermission('printers.manage') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const token = `wmsp_${generateToken(24)}`;
    return withTx(async (tx) => {
      const p = await tx.printers.findUnique({ where: { id } });
      if (!p) throw new NotFoundError('printer', id);
      await tx.printers.update({ where: { id }, data: { agent_token_hash: sha256(token), agent_token_enc: encryptSecret(token, loadConfig().APP_ENCRYPTION_KEY), mode: 'AGENT' } });
      await audit(tx, req.actor!, { action: 'printer.agent_token', entity_type: 'printer', entity_id: id, after: { code: p.code } });
      return { token, printer: p.code };
    });
  });
  /**
   * The station launcher (estacion_wms.bat) as a download: the PC with the Zebra double-clicks it and the station runs.
   * Anyone who prints may fetch it; the token is reused (a new one is made only when the printer has none yet), so a
   * second download never kills the station that is already running.
   */
  app.get('/printers/:id/station.bat', { preHandler: app.requirePermission('labels.print') }, async (req, reply) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const cfg = loadConfig();
    const { token, code } = await withTx(async (tx) => {
      const p = await tx.printers.findUnique({ where: { id } });
      if (!p) throw new NotFoundError('printer', id);
      if (p.mode !== 'AGENT') throw new RuleError('NOT_AGENT_PRINTER', 'Esta impresora es de red: no usa estación');
      let token: string | null = null;
      if (p.agent_token_enc) {
        try { token = decryptSecret(p.agent_token_enc, cfg.APP_ENCRYPTION_KEY); } catch { token = null; }
      }
      if (!token) {
        token = `wmsp_${generateToken(24)}`;
        await tx.printers.update({ where: { id }, data: { agent_token_hash: sha256(token), agent_token_enc: encryptSecret(token, cfg.APP_ENCRYPTION_KEY) } });
        await audit(tx, req.actor!, { action: 'printer.agent_token', entity_type: 'printer', entity_id: id, after: { code: p.code, via: 'station_download' } });
      }
      await audit(tx, req.actor!, { action: 'printer.station_download', entity_type: 'printer', entity_id: id, after: { code: p.code } });
      return { token, code: p.code };
    });
    const origin = publicOrigin(req);
    reply.header('Content-Type', 'application/octet-stream').header('Content-Disposition', 'attachment; filename="estacion_wms.bat"');
    return stationLauncher(origin, token, code);
  });
  app.patch('/printers/:id', { preHandler: app.requirePermission('printers.manage') }, async (req) => {
    const id = zUuid.parse((req.params as { id: string }).id);
    const body = zPrinter.partial().extend({ is_active: z.boolean().optional() }).parse(req.body);
    return withTx(async (tx) => {
      const before = await tx.printers.findUnique({ where: { id } });
      if (!before) throw new NotFoundError('printer', id);
      if (body.is_default) await tx.printers.updateMany({ data: { is_default: false } });
      const after = await tx.printers.update({ where: { id }, data: body });
      await audit(tx, req.actor!, { action: 'printer.update', entity_type: 'printer', entity_id: id, before, after });
      return after;
    });
  });

  app.get('/quarantine-reasons', { preHandler: app.requireAuth }, async () => db.quarantine_reasons.findMany({ where: { is_active: true } }));
  app.post('/quarantine-reasons', { preHandler: app.requirePermission('settings.manage') }, async (req, reply) => {
    const body = z.object({ code: z.string().trim().min(1).max(40), description: z.string().trim().min(1).max(300) }).parse(req.body);
    const r = await db.quarantine_reasons.upsert({ where: { code: body.code }, create: body, update: { description: body.description, is_active: true } });
    reply.status(201);
    return r;
  });
}

/** Ensures PIECE exists and the hierarchy is coherent. */
function normalizeUoms(uoms: { uom_code: 'PALLET' | 'CASE' | 'INNER' | 'PIECE'; base_qty: bigint }[]) {
  const list = uoms.some((u) => u.uom_code === 'PIECE') ? [...uoms] : [...uoms, { uom_code: 'PIECE' as const, base_qty: 1n }];
  const errors = validateUomHierarchy(list);
  if (errors.length) throw new RuleError('INVALID_UOM_HIERARCHY', errors.join('; '));
  return list;
}


/** estacion_wms.bat: same launcher the office generates, built server-side. Runs hidden with pythonw, self-restarts, auto-starts with Windows. */
function stationLauncher(origin: string, token: string, printerCode: string): string {
  const L = [
    '@echo off',
    `rem Estacion de impresion WMS - ${printerCode}. Doble clic una vez: queda corriendo en segundo plano (sin ventana) y arranca sola al prender la PC.`,
    'rem Con Python instalado imprime por el driver de Windows y atiende tambien a la app de etiquetas SAE (127.0.0.1:9101). Sin Python abre la estacion del navegador.',
    `title Estacion de impresion WMS - ${printerCode}`,
    `set "WMS_URL=${origin}"`,
    `set "WMS_PRINT_TOKEN=${token}"`,
    `set "URL=${origin}/print-station#token=${token}"`,
    'set "INICIO=%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\"',
    'set "DIR=%LOCALAPPDATA%\\wms-print\\"',
    'if not exist "%DIR%" mkdir "%DIR%"',
    'taskkill /f /im pythonw.exe >nul 2>nul',
    'taskkill /f /im python.exe >nul 2>nul',
    'python --version >nul 2>nul',
    'if errorlevel 1 goto navegador',
    'echo Descargando la estacion...',
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing '%WMS_URL%/print-agent/wms_print_agent.py' -OutFile '%DIR%wms_print_agent.py' } catch {}"`,
    'if not exist "%DIR%wms_print_agent.py" goto navegador',
    'python -m pip install --quiet pywin32 requests >nul 2>nul',
    'rem --- bucle que corre sin ventana (pythonw) y se reinicia solo ---',
    '> "%DIR%estacion_loop.bat" (',
    '  echo @echo off',
    '  echo set "WMS_URL=%WMS_URL%"',
    '  echo set "WMS_PRINT_TOKEN=%WMS_PRINT_TOKEN%"',
    '  echo cd /d "%DIR%"',
    '  echo :loop',
    '  echo pythonw wms_print_agent.py',
    '  echo if errorlevel 3 exit',
    '  echo timeout /t 5 ^>nul',
    '  echo goto loop',
    ')',
    '> "%DIR%estacion_oculta.vbs" echo CreateObject("WScript.Shell").Run "cmd /c """"%DIR%estacion_loop.bat""""", 0, False',
    '> "%DIR%detener_estacion.bat" (',
    '  echo @echo off',
    '  echo taskkill /f /im pythonw.exe ^>nul 2^>nul',
    '  echo echo Estacion de impresion WMS detenida. Para volver a iniciarla: doble clic en estacion_wms.bat',
    '  echo timeout /t 5',
    ')',
    '> "%INICIO%estacion_wms.bat" (',
    '  echo @echo off',
    '  echo timeout /t 20 ^>nul',
    '  echo wscript "%DIR%estacion_oculta.vbs"',
    ')',
    'wscript "%DIR%estacion_oculta.vbs"',
    'echo.',
    'echo La estacion quedo corriendo en segundo plano, sin ventana, y arrancara sola al prender la PC.',
    'echo Comprueba en el WMS: Datos maestros - Impresoras - "conectada".',
    'echo Registro: %DIR%estacion.log   Para detenerla: %DIR%detener_estacion.bat',
    'timeout /t 12',
    'exit /b 0',
    ':navegador',
    'if /i not "%~dp0"=="%INICIO%" copy /y "%~f0" "%INICIO%estacion_wms.bat" >nul 2>nul',
    'if /i "%~dp0"=="%INICIO%" timeout /t 20 >nul',
    'start "" msedge --app="%URL%" 2>nul || start "" chrome --app="%URL%" 2>nul || start "" "%URL%"',
  ];
  return L.join('\r\n') + '\r\n';
}
