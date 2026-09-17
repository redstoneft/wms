// /wm/new-task — the operator creates a task for themself (pick an order, count a location, put away a pallet)
// and must state the purpose ("para qué"). The purpose is stored on the task and audited.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { masterdataApi } from '../api/masterdata';
import { ordersApi } from '../api/orders';
import { wmTasksApi, type SelfTaskKind } from '../api/wmTasks';
import { ScanInput } from '../components/ScanInput';
import { BigButton, BigValue, StepBar, useWm, WmShell } from './WmShell';

const KINDS: { kind: SelfTaskKind; label: string; icon: string; ask: string; hint: string }[] = [
  { kind: 'PICK', label: 'Surtir un pedido', icon: '☑', ask: 'ESCANEA O ESCRIBE EL NÚMERO DE PEDIDO', hint: 'Se asigna inventario y la tarea queda a tu nombre' },
  { kind: 'COUNT', label: 'Contar una ubicación', icon: '#', ask: 'ESCANEA LA ETIQUETA DE LA UBICACIÓN', hint: 'Conteo a ciegas de ese hueco' },
  { kind: 'PUTAWAY', label: 'Ubicar una tarima', icon: '⇲', ask: 'ESCANEA EL LPN DE LA TARIMA', hint: 'Para una tarima que quedó sin tarea de acomodo' },
];

export default function WmNewTaskPage() {
  return (
    <WmShell title="Nueva tarea">
      <Flow />
    </WmShell>
  );
}

function Flow() {
  const wm = useWm();
  const nav = useNavigate();
  const [kind, setKind] = useState<SelfTaskKind | null>(null);
  const [reference, setReference] = useState('');
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);
  // PICK: does the order exist? if not, the operator creates it here (customer) and picks it freely
  const [orderExists, setOrderExists] = useState<boolean | null>(null);
  const [customerCode, setCustomerCode] = useState('');
  const [customerQ, setCustomerQ] = useState('');
  const [destination, setDestination] = useState('');
  const customers = useQuery({ queryKey: ['customers', 'all'], queryFn: () => masterdataApi.parties('customers', { limit: 500 }), enabled: kind === 'PICK' && orderExists === false });
  const customerRows = useMemo(() => {
    const rows = (customers.data as unknown as { items?: { code: string; name: string }[] } | { code: string; name: string }[] | undefined);
    const list = Array.isArray(rows) ? rows : rows?.items ?? [];
    const q = customerQ.trim().toLowerCase();
    return list.filter((c) => !q || c.code.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)).slice(0, 12);
  }, [customers.data, customerQ]);
  const def = KINDS.find((k) => k.kind === kind);
  const onReference = async (v: string) => {
    setReference(v);
    if (kind !== 'PICK') return;
    setBusy(true);
    try {
      const r = (await ordersApi.list({ q: v, limit: 5 })) as unknown as { items?: { order_number: string }[] } | { order_number: string }[];
      const list = Array.isArray(r) ? r : r.items ?? [];
      const found = list.some((o) => o.order_number.toUpperCase() === v.toUpperCase());
      setOrderExists(found);
      wm.ok(found ? `PEDIDO ${v} ENCONTRADO` : `PEDIDO ${v} NUEVO · elige el cliente`);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!kind) return;
    setBusy(true);
    try {
      const r = await wmTasksApi.create({ kind, reference, purpose: purpose.trim(), ...(kind === 'PICK' && orderExists === false ? { new_order: { customer_code: customerCode, destination: destination.trim() || undefined } } : {}) });
      wm.ok(kind === 'PICK' ? (r.mode === 'FREE' ? `PEDIDO ${r.order_number ?? ''} CREADO · SURTIDO LIBRE: ESCANEA TARIMAS` : `TAREA DE SURTIDO CREADA · ${r.order_number ?? ''} · CARRIL ${r.staging ?? ''}`) : kind === 'COUNT' ? 'CONTEO CREADO' : `TAREA DE ACOMODO CREADA · ${r.lpn ?? ''}`);
      nav(r.next);
    } catch (e) {
      wm.fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (!kind)
    return (
      <div className="grid gap-3">
        <StepBar text="1 · ¿QUÉ TAREA VAS A HACER?" />
        {KINDS.map((k) => (
          <BigButton key={k.kind} tone="neutral" onClick={() => setKind(k.kind)} testId={`new-task-${k.kind.toLowerCase()}`}>
            <span className="mr-2 text-2xl">{k.icon}</span>
            {k.label}
            <span className="block text-sm font-normal normal-case text-slate-300">{k.hint}</span>
          </BigButton>
        ))}
      </div>
    );
  if (!reference)
    return (
      <div>
        <StepBar text={`2 · ${def!.ask}`} />
        <BigValue label="Tarea" value={def!.label} tone="accent" />
        <div className="mt-3">
          <ScanInput label={kind === 'PICK' ? 'Número de pedido (existente o nuevo)' : kind === 'COUNT' ? 'Ubicación' : 'LPN'} autoUpper onScan={(v) => (kind === 'PICK' ? void onReference(v) : (setReference(v), wm.ok()))} disabled={busy} testId="new-task-ref" />
        </div>
        <BigButton tone="neutral" className="mt-3" onClick={() => setKind(null)}>
          Regresar
        </BigButton>
      </div>
    );
  if (kind === 'PICK' && orderExists === false && !customerCode)
    return (
      <div>
        <StepBar text="3 · PEDIDO NUEVO · ¿DE QUÉ CLIENTE ES?" />
        <BigValue label="Pedido nuevo" value={reference} tone="accent" />
        <input value={customerQ} onChange={(e) => setCustomerQ(e.target.value)} placeholder="Buscar cliente…" className="mt-3 w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-3 text-xl text-white" data-testid="new-task-customer-q" />
        <div className="mt-2 grid gap-2">
          {customerRows.map((c) => (
            <BigButton key={c.code} tone="neutral" onClick={() => { setCustomerCode(c.code); wm.ok(`CLIENTE ${c.name}`); }} testId={`new-task-customer-${c.code}`}>
              {c.name}
              <span className="block text-sm font-normal normal-case text-slate-300">{c.code}</span>
            </BigButton>
          ))}
          {customers.isLoading && <div className="text-center text-slate-300">Cargando clientes…</div>}
        </div>
        <BigButton tone="neutral" className="mt-3" onClick={() => { setReference(''); setOrderExists(null); }}>
          Regresar
        </BigButton>
      </div>
    );
  return (
    <div>
      <StepBar text={kind === 'PICK' && orderExists === false ? '4 · ¿PARA QUÉ? (OBLIGATORIO)' : '3 · ¿PARA QUÉ? (OBLIGATORIO)'} />
      <div className="grid gap-2 sm:grid-cols-2">
        <BigValue label="Tarea" value={def!.label} tone="accent" />
        <BigValue label={kind === 'PICK' ? 'Pedido' : kind === 'COUNT' ? 'Ubicación' : 'LPN'} value={reference} />
      </div>
      {kind === 'PICK' && orderExists === false && (
        <div className="mt-2 grid gap-2">
          <BigValue label="Cliente" value={customerCode} tone="ok" />
          <input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="Destino o sucursal (opcional)" className="w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-3 text-xl text-white" data-testid="new-task-destination" />
          <div className="text-xs text-slate-400">Surtido libre: después escaneas las tarimas que van al pedido, cuando quieras, y lo cierras al terminar.</div>
        </div>
      )}
      <label className="mt-3 block">
        <div className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-300">Para qué se hace esta tarea</div>
        <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={3} placeholder="Ej.: cliente pasa por el pedido hoy a las 4 · diferencia detectada al surtir · tarima quedó en andén" className="w-full rounded-lg border-2 border-slate-500 bg-slate-900 px-3 py-3 text-xl text-white" data-testid="new-task-purpose" />
        <div className="mt-1 text-xs text-slate-400">Mínimo 5 letras. Queda registrado con tu usuario en la auditoría.</div>
      </label>
      <BigButton tone="success" className="mt-3" disabled={busy || purpose.trim().length < 5} onClick={create} testId="new-task-create">
        Crear tarea y empezar
      </BigButton>
      <BigButton tone="neutral" className="mt-3" onClick={() => (kind === 'PICK' && orderExists === false ? setCustomerCode('') : (setReference(''), setOrderExists(null)))}>
        Regresar
      </BigButton>
    </div>
  );
}
