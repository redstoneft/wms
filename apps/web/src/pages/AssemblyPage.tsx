// /assembly — office view of assembly orders (armado): full form (several inputs, pallets with their own packing factor, scrap) and history.
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { assemblyApi, type AssemblyOrder, type AssemblyResult } from '../api/assembly';
import { inventoryApi } from '../api/inventory';
import { labelsApi } from '../api/labels';
import { masterdataApi } from '../api/masterdata';
import { useToast } from '../components/Toast';
import { Alert, Button, Card, Field, Input, PageHeader, StatusChip, Table, Textarea } from '../components/ui';
import { fmtDateTime, fmtQty } from '../lib/format';

interface InputRow {
  lpn_code: string;
  sku_code: string;
  qty: string;
  /** what the LPN holds, for the picker */
  contents?: { sku_code: string; description: string; qty: string }[];
  error?: string;
}
interface PalletRow {
  cases: string;
  pieces_per_case: string;
}

const emptyInput = (): InputRow => ({ lpn_code: '', sku_code: '', qty: '' });
const emptyPallet = (ppc = ''): PalletRow => ({ cases: '', pieces_per_case: ppc });

export default function AssemblyPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [station, setStation] = useState('');
  const [inputs, setInputs] = useState<InputRow[]>([emptyInput()]);
  const [outSku, setOutSku] = useState('');
  const [outInfo, setOutInfo] = useState<{ code: string; description: string; requires_lot: boolean; requires_expiry: boolean } | null>(null);
  const [outErr, setOutErr] = useState('');
  const [lot, setLot] = useState('');
  const [expiry, setExpiry] = useState('');
  const [pallets, setPallets] = useState<PalletRow[]>([emptyPallet()]);
  const [scrapQty, setScrapQty] = useState('');
  const [scrapReason, setScrapReason] = useState('');
  const [notes, setNotes] = useState('');
  const [result, setResult] = useState<AssemblyResult | null>(null);
  const history = useQuery({ queryKey: ['assembly'], queryFn: () => assemblyApi.list({ limit: 50 }) });

  const consumed = useMemo(() => inputs.reduce((a, i) => a + (Number(i.qty) || 0), 0), [inputs]);
  const produced = useMemo(() => pallets.reduce((a, p) => a + (Number(p.cases) || 0) * (Number(p.pieces_per_case) || 0), 0), [pallets]);
  const scrap = Number(scrapQty) || 0;
  const singleComponent = new Set(inputs.map((i) => i.sku_code).filter(Boolean)).size <= 1;
  const balanced = !singleComponent || consumed === produced + scrap;

  const loadLpn = async (idx: number) => {
    const code = inputs[idx]!.lpn_code.trim().toUpperCase();
    if (!code) return;
    try {
      const d = await inventoryApi.lpn(code);
      const bySku = new Map<string, { sku_code: string; description: string; qty: bigint }>();
      for (const b of d.balances) {
        if ((b.status !== 'AVAILABLE' && b.status !== 'BLOCKED') || BigInt(b.qty) <= 0n) continue; // blocked = bodies waiting for assembly
        const cur = bySku.get(b.sku.code) ?? { sku_code: b.sku.code, description: b.sku.description, qty: 0n };
        cur.qty += BigInt(b.qty);
        bySku.set(b.sku.code, cur);
      }
      const contents = [...bySku.values()].map((c) => ({ ...c, qty: c.qty.toString() }));
      setInputs((rows) => rows.map((r, i) => (i === idx ? { ...r, lpn_code: code, contents, sku_code: contents.length === 1 ? contents[0]!.sku_code : r.sku_code, qty: contents.length === 1 && !r.qty ? contents[0]!.qty : r.qty, error: contents.length ? undefined : 'El LPN no tiene inventario disponible ni bloqueado' } : r)));
    } catch (e) {
      setInputs((rows) => rows.map((r, i) => (i === idx ? { ...r, contents: undefined, error: e instanceof Error ? e.message : 'LPN no encontrado' } : r)));
    }
  };
  const loadOut = async () => {
    const code = outSku.trim();
    if (!code) return;
    try {
      const r = await masterdataApi.skuByBarcode(code);
      setOutInfo({ code: r.sku.code, description: r.sku.description, requires_lot: r.sku.requires_lot, requires_expiry: r.sku.requires_expiry });
      setOutErr('');
      const caseUom = r.uoms.find((u) => u.uom_code === 'CASE');
      if (caseUom) setPallets((ps) => ps.map((p) => (p.pieces_per_case ? p : { ...p, pieces_per_case: String(caseUom.base_qty) })));
    } catch (e) {
      setOutInfo(null);
      setOutErr(e instanceof Error ? e.message : 'Producto no encontrado');
    }
  };

  const run = useMutation({
    mutationFn: () =>
      assemblyApi.complete(
        {
          station_barcode: station.trim(),
          inputs: inputs.filter((i) => i.lpn_code && i.sku_code && i.qty).map((i) => ({ lpn_code: i.lpn_code.trim().toUpperCase(), sku_code: i.sku_code.trim(), qty: Number(i.qty) })),
          output: {
            sku_code: outInfo?.code ?? outSku.trim(),
            lot: lot.trim() || undefined,
            expiry_date: expiry || undefined,
            pallets: pallets.filter((p) => p.cases && p.pieces_per_case).map((p) => ({ cases: Number(p.cases), pieces_per_case: Number(p.pieces_per_case) })),
          },
          scrap: scrap > 0 ? { qty: scrap, reason: scrapReason.trim() } : undefined,
          notes: notes.trim() || undefined,
        },
        api.newKey(),
      ),
    onSuccess: (r) => {
      setResult(r.data);
      toast.success(`Armado ${r.data.code} registrado`, `${r.data.produced.length} tarima(s) nueva(s)`);
      void qc.invalidateQueries({ queryKey: ['assembly'] });
      setInputs([emptyInput()]);
      setPallets([emptyPallet()]);
      setScrapQty('');
      setScrapReason('');
      setNotes('');
    },
    onError: (e) => toast.error('No se pudo registrar el armado', e),
  });
  const print = useMutation({
    mutationFn: (lpn: string) => labelsApi.print({ label_type: 'LPN', entity_id: lpn }),
    onSuccess: (_r, lpn) => toast.success(`Etiqueta ${lpn} enviada a la impresora`),
    onError: (e) => toast.error('No se pudo imprimir', e),
  });

  const canSubmit = station.trim() && inputs.some((i) => i.lpn_code && i.sku_code && Number(i.qty) > 0) && (outInfo || outSku.trim()) && pallets.some((p) => Number(p.cases) > 0 && Number(p.pieces_per_case) > 0) && balanced && (scrap === 0 || scrapReason.trim().length >= 3);

  return (
    <div>
      <PageHeader title="Armado" subtitle="Convierte insumos (cuerpos de sartén en master de 24) en producto terminado (sartenes armados en cajas de 12). Si el cuerpo y el sartén usan el mismo código, es un reempaque: la existencia no cambia, solo el empaque y el número de tarimas. Las tarimas de entrada se consumen y nacen tarimas nuevas con su etiqueta LPN y tarea de acomodo." />
      <div className="grid gap-4 xl:grid-cols-5">
        <Card title="1 · Estación y entradas" className="xl:col-span-3">
          <div className="grid gap-3">
            <Field label="Estación de armado (ubicación)" required hint="Escanea la etiqueta del área de armado (zona ARM) o de staging. No puede ser una posición de rack.">
              <Input value={station} onChange={(e) => setStation(e.target.value.toUpperCase())} placeholder="LOC-HID-ARM-01" data-testid="asm-station" />
            </Field>
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Insumos consumidos</div>
            {inputs.map((row, idx) => (
              <div key={idx} className="rounded-lg border border-slate-200 p-3">
                <div className="grid gap-2 sm:grid-cols-[1fr_1fr_120px_auto]">
                  <Field label="LPN de entrada" required>
                    <Input value={row.lpn_code} onChange={(e) => setInputs((rs) => rs.map((r, i) => (i === idx ? { ...r, lpn_code: e.target.value.toUpperCase() } : r)))} onBlur={() => void loadLpn(idx)} onKeyDown={(e) => e.key === 'Enter' && void loadLpn(idx)} placeholder="PLT-2026-…" data-testid={`asm-in-lpn-${idx}`} />
                  </Field>
                  <Field label="Insumo (SKU / clave)" required>
                    {row.contents && row.contents.length > 1 ? (
                      <select className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" value={row.sku_code} onChange={(e) => setInputs((rs) => rs.map((r, i) => (i === idx ? { ...r, sku_code: e.target.value, qty: r.contents?.find((c) => c.sku_code === e.target.value)?.qty ?? r.qty } : r)))}>
                        <option value="">Elige…</option>
                        {row.contents.map((c) => (
                          <option key={c.sku_code} value={c.sku_code}>
                            {c.sku_code} · {c.description} ({fmtQty(c.qty)} pzas)
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Input value={row.sku_code} onChange={(e) => setInputs((rs) => rs.map((r, i) => (i === idx ? { ...r, sku_code: e.target.value } : r)))} placeholder="636570" data-testid={`asm-in-sku-${idx}`} />
                    )}
                  </Field>
                  <Field label="Piezas" required>
                    <Input type="number" min={1} value={row.qty} onChange={(e) => setInputs((rs) => rs.map((r, i) => (i === idx ? { ...r, qty: e.target.value } : r)))} data-testid={`asm-in-qty-${idx}`} />
                  </Field>
                  <div className="flex items-end">
                    <Button variant="ghost" size="sm" onClick={() => setInputs((rs) => (rs.length > 1 ? rs.filter((_, i) => i !== idx) : [emptyInput()]))} aria-label="Quitar insumo">
                      ✕
                    </Button>
                  </div>
                </div>
                {row.contents && row.contents.length === 1 && (
                  <div className="mt-1 text-xs text-slate-600">
                    Contiene <b>{fmtQty(row.contents[0]!.qty)}</b> pzas de {row.contents[0]!.sku_code} · {row.contents[0]!.description}
                  </div>
                )}
                {row.error && <div className="mt-1 text-xs text-rose-700">{row.error}</div>}
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={() => setInputs((rs) => [...rs, emptyInput()])}>
              + Otro insumo (mangos, tornillería…)
            </Button>
          </div>
        </Card>

        <Card title="2 · Producto terminado y tarimas" className="xl:col-span-2">
          <div className="grid gap-3">
            <Field label="Producto terminado (clave SAE, GTIN o código WMS)" required>
              <Input value={outSku} onChange={(e) => setOutSku(e.target.value)} onBlur={() => void loadOut()} onKeyDown={(e) => e.key === 'Enter' && void loadOut()} placeholder="SIC20G-GRIS-1" data-testid="asm-out-sku" />
            </Field>
            {outInfo && (
              <div className="text-xs text-slate-600">
                <b>{outInfo.code}</b> · {outInfo.description}
                {inputs.some((i) => i.sku_code === outInfo.code) && <span className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 font-semibold text-sky-800">mismo código: reempaque</span>}
                {outInfo.requires_lot && <span className="ml-2 text-amber-700">requiere lote</span>}
                {outInfo.requires_expiry && <span className="ml-2 text-amber-700">requiere caducidad</span>}
              </div>
            )}
            {outErr && <div className="text-xs text-rose-700">{outErr}</div>}
            {(outInfo?.requires_lot || outInfo?.requires_expiry) && (
              <div className="grid gap-2 sm:grid-cols-2">
                {outInfo.requires_lot && (
                  <Field label="Lote" required>
                    <Input value={lot} onChange={(e) => setLot(e.target.value)} />
                  </Field>
                )}
                {outInfo.requires_expiry && (
                  <Field label="Caducidad" required>
                    <Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
                  </Field>
                )}
              </div>
            )}
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tarimas producidas (una fila por tarima física)</div>
            {pallets.map((p, idx) => (
              <div key={idx} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <Field label={`Tarima ${idx + 1} · cajas`} required>
                  <Input type="number" min={1} value={p.cases} onChange={(e) => setPallets((ps) => ps.map((r, i) => (i === idx ? { ...r, cases: e.target.value } : r)))} data-testid={`asm-pal-cases-${idx}`} />
                </Field>
                <Field label="Piezas por caja" required>
                  <Input type="number" min={1} value={p.pieces_per_case} onChange={(e) => setPallets((ps) => ps.map((r, i) => (i === idx ? { ...r, pieces_per_case: e.target.value } : r)))} data-testid={`asm-pal-ppc-${idx}`} />
                </Field>
                <div className="pb-2 text-sm text-slate-600">= {fmtQty((Number(p.cases) || 0) * (Number(p.pieces_per_case) || 0))} pzas</div>
                <Button variant="ghost" size="sm" onClick={() => setPallets((ps) => (ps.length > 1 ? ps.filter((_, i) => i !== idx) : [emptyPallet()]))} aria-label="Quitar tarima">
                  ✕
                </Button>
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={() => setPallets((ps) => [...ps, emptyPallet(ps[ps.length - 1]?.pieces_per_case ?? '')])}>
              + Otra tarima
            </Button>
            <div className="grid gap-2 sm:grid-cols-[120px_1fr]">
              <Field label="Merma (pzas)">
                <Input type="number" min={0} value={scrapQty} onChange={(e) => setScrapQty(e.target.value)} data-testid="asm-scrap" />
              </Field>
              <Field label="Motivo de la merma" required={scrap > 0}>
                <Input value={scrapReason} onChange={(e) => setScrapReason(e.target.value)} placeholder="cuerpos golpeados, no se pudieron armar" disabled={scrap === 0} />
              </Field>
            </div>
            <Field label="Notas">
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            <div className={`rounded-lg p-3 text-sm ${balanced ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`} data-testid="asm-balance">
              Consumido <b>{fmtQty(consumed)}</b> pzas · Producido <b>{fmtQty(produced)}</b> pzas · Merma <b>{fmtQty(scrap)}</b>
              {!balanced && <div className="mt-1">Con un solo insumo la cuenta debe cuadrar: consumido = producido + merma. Registra la diferencia como merma con motivo.</div>}
            </div>
            <Button onClick={() => run.mutate()} disabled={!canSubmit} loading={run.isPending} data-testid="asm-submit">
              Registrar armado
            </Button>
          </div>
        </Card>
      </div>

      {result && (
        <Card title={`Armado ${result.code} registrado`} className="mt-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Consumido</div>
              <ul className="mt-1 text-sm">
                {result.consumed.map((c) => (
                  <li key={c.lpn}>
                    <span className="font-mono">{c.lpn}</span> · {c.sku} · {fmtQty(c.qty)} pzas · <StatusChip status={c.lpn_status} />
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Tarimas nuevas (imprime y pega la etiqueta; luego acomódalas)</div>
              <ul className="mt-1 grid gap-1 text-sm">
                {result.produced.map((p) => (
                  <li key={p.lpn} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono font-semibold" data-testid="asm-new-lpn">{p.lpn}</span>
                    <span>
                      {p.cases} cajas × {p.pieces_per_case} = {fmtQty(p.qty)} pzas
                    </span>
                    {p.suggested_location && <span className="text-xs text-slate-500">→ acomodo sugerido {p.suggested_location}</span>}
                    <Button size="sm" variant="secondary" onClick={() => print.mutate(p.lpn)} loading={print.isPending && print.variables === p.lpn}>
                      Imprimir etiqueta
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          {result.warnings.length > 0 && (
            <Alert tone="warn" className="mt-3">
              {result.warnings.join(' · ')}
            </Alert>
          )}
          {result.incident_id && (
            <Alert tone="info" className="mt-3">
              La merma quedó registrada como incidencia para seguimiento del supervisor.
            </Alert>
          )}
        </Card>
      )}

      <Card title="Historial de armados" className="mt-4" padded={false}>
        <Table<AssemblyOrder>
          rows={history.data}
          loading={history.isLoading}
          rowKey={(r) => r.id}
          dense
          columns={[
            { key: 'd', header: 'Fecha', render: (r) => fmtDateTime(r.created_at) },
            { key: 'c', header: 'Orden', render: (r) => <span className="font-mono">{r.code}</span> },
            { key: 'm', header: 'Tipo', render: (r) => (r.mode === 'REPACK' ? 'Reempaque' : 'Armado') },
            { key: 'i', header: 'Insumos', render: (r) => r.inputs.map((i) => `${i.lpn.code} · ${i.sku.code} · ${fmtQty(i.qty)}`).join(' | ') },
            { key: 'o', header: 'Producto', render: (r) => `${r.output_sku.code} · ${r.output_sku.description}` },
            { key: 'q', header: 'Pzas', render: (r) => fmtQty(r.output_qty), align: 'right' },
            { key: 'p', header: 'Tarimas', render: (r) => r.outputs.map((o) => `${o.lpn.code} (${o.cases}×${o.pieces_per_case})`).join(', ') },
            { key: 's', header: 'Merma', render: (r) => (r.scrap_qty !== '0' ? `${fmtQty(r.scrap_qty)} · ${r.scrap_reason ?? ''}` : '—') },
            { key: 'st', header: 'Estación', render: (r) => r.station.code },
          ]}
        />
      </Card>
    </div>
  );
}
