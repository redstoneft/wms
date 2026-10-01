// Put-away plan of a batch (receipt or assembly order): every pallet with its destination, chosen here; closing puts them all away.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { putawayApi, type PutawayBatchKind } from '../api/storage';
import type { PutawayOption, ReceiptPutawayPallet } from '../api/types';
import { useToast } from './Toast';
import { Button, Card, ConfirmDialog, Input, Modal, Table } from './ui';
import { cls, fmtQty } from '../lib/format';

/** Where each pallet of a batch (receipt or assembly order) goes: the whole batch on one table; destinations chosen here, then put away by scanning in the handheld or all at once with Cerrar acomodo. */
export function PutawayPlanCard({ kind, id }: { kind: PutawayBatchKind; id: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const plan = useQuery({ queryKey: ['putaway-batch', kind, id], queryFn: () => putawayApi.batch(kind, id), refetchInterval: 20_000 });
  const [edit, setEdit] = useState<{ pallet: ReceiptPutawayPallet; list: PutawayOption[]; selected: string; filter: string } | null>(null);
  const open = useMutation({
    mutationFn: async (p: ReceiptPutawayPallet) => ({ p, r: await putawayApi.options(p.task_id!) }),
    onSuccess: ({ p, r }) => (r.options.length ? setEdit({ pallet: p, list: r.options, selected: r.current ?? r.options[0]!.code, filter: '' }) : toast.error('Sin ubicación libre', `Ninguna ubicación acepta ${p.lpn_code}`)),
    onError: (e) => toast.error('No se pudieron cargar las ubicaciones', e),
  });
  const save = useMutation({
    mutationFn: (body: { location_code?: string; other?: boolean }) => putawayApi.choose(edit!.pallet.task_id!, body),
    onSuccess: (r) => { toast.success(`${edit!.pallet.lpn_code} → ${r.target.code}`); setEdit(null); void qc.invalidateQueries({ queryKey: ['putaway-batch', kind, id] }); },
    onError: (e) => toast.error('No se pudo asignar', e),
  });
  const [confirmClose, setConfirmClose] = useState(false);
  const closePlan = useMutation({
    mutationFn: () => putawayApi.closeBatch(kind, id),
    onSuccess: (r) => {
      setConfirmClose(false);
      if (r.failed.length) toast.error(`${r.placed.length} tarima(s) ubicadas, ${r.failed.length} no`, r.failed.map((f) => `${f.lpn} → ${f.target}: ${f.error}`).join(' · '));
      else toast.success(`Acomodo cerrado: ${r.placed.length} tarima(s) ubicadas en su destino`);
      void qc.invalidateQueries({ queryKey: ['putaway-batch', kind, id] });
      void qc.invalidateQueries({ queryKey: ['receipt', id] });
      void qc.invalidateQueries({ queryKey: ['assembly'] });
    },
    onError: (e) => toast.error('No se pudo cerrar el acomodo', e),
  });
  const printLabels = useMutation({
    mutationFn: () => putawayApi.printBatchLabels(kind, id),
    onSuccess: (r) => (r.failed.length ? toast.error(`${r.printed.length} etiqueta(s) enviadas`, `Sin imprimir: ${r.failed.map((f) => `${f.lpn} (${f.error})`).join(', ')}`) : toast.success(`${r.printed.length} etiqueta(s) enviadas a imprimir`)),
    onError: (e) => toast.error('No se pudieron imprimir', e),
  });
  const pallets = plan.data?.pallets ?? [];
  const pending = pallets.filter((p) => p.pending).length;
  const noTarget = pallets.filter((p) => p.pending && !p.target).length;
  const q = edit?.filter.trim().toUpperCase() ?? '';
  const shown = edit ? (q ? edit.list.filter((o) => o.code.toUpperCase().includes(q) || o.code === edit.selected) : edit.list) : [];
  return (
    <Card title={`Acomodo: dónde va cada tarima (${pending} por ubicar de ${pallets.length})`} className="mt-4" padded={false} actions={pending > 0 ? <div className="flex gap-2"><Button variant="secondary" onClick={() => printLabels.mutate()} loading={printLabels.isPending}>Imprimir etiquetas ({pending})</Button><Button onClick={() => setConfirmClose(true)} disabled={noTarget > 0} title={noTarget > 0 ? `${noTarget} tarima(s) sin destino` : undefined}>Cerrar acomodo</Button></div> : undefined}>
      <div className="px-4 pt-3 text-xs text-slate-500">Elija aquí el destino de cada tarima. Los destinos <b>sugeridos</b> por el sistema no apartan el hueco: puede dárselo a otra tarima y la sugerida recibe otra propuesta. Un destino <b>elegido</b> sí queda apartado. Luego, o el montacarguista confirma cada tarima en el handheld (Ubicar) escaneando, o <b>Cerrar acomodo</b> las ubica todas en el sistema sin escanear.</div>
      <Table
        rows={pallets}
        rowKey={(p) => p.lpn_id}
        empty="Sin tarimas"
        columns={[
          { key: 'l', header: 'LPN', render: (p) => <span className="font-mono font-semibold">{p.lpn_code}</span> },
          { key: 'c', header: 'Contenido', render: (p) => p.contents.map((c) => `${c.sku} × ${fmtQty(c.qty)}`).join(', ') || '—' },
          { key: 'w', header: 'Está en', render: (p) => <span className="font-mono">{p.current_location ?? '—'}</span> },
          { key: 'd', header: 'Destino', render: (p) => (p.pending ? <span className={cls('font-mono font-semibold', p.planned ? 'text-emerald-700' : 'text-violet-700')}>{p.target ?? 'sin destino'}{p.planned ? ' · elegido' : ' · sugerido'}</span> : <span className="text-emerald-700">ubicada</span>) },
          { key: 'a', header: '', render: (p) => (p.pending ? <Button variant="secondary" onClick={() => open.mutate(p)} loading={open.isPending && open.variables?.lpn_id === p.lpn_id}>Elegir destino</Button> : null) },
        ]}
      />
      <ConfirmDialog open={confirmClose} onClose={() => setConfirmClose(false)} onConfirm={() => closePlan.mutate()} title="Cerrar el acomodo de esta recepción" loading={closePlan.isPending} confirmLabel="Cerrar e imprimir">
        Las {pending} tarima(s) pendientes quedan <b>ubicadas en su destino en el sistema</b>, igual que si se escaneara cada una en Ubicar. Hágalo cuando físicamente ya estén (o vayan) ahí. Las etiquetas no se imprimen solas: use <b>Imprimir etiquetas</b> antes si las necesita.
      </ConfirmDialog>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit ? `Destino de ${edit.pallet.lpn_code}` : ''} footer={<><Button variant="secondary" onClick={() => save.mutate({ other: true })} loading={save.isPending}>Otra automática</Button><Button variant="secondary" onClick={() => setEdit(null)}>Cancelar</Button><Button onClick={() => save.mutate({ location_code: edit!.selected })} loading={save.isPending}>Asignar</Button></>}>
        {edit && (
          <div className="grid gap-3">
            <div className="text-sm text-slate-600">{edit.pallet.contents.map((c) => `${c.sku} × ${fmtQty(c.qty)}`).join(' · ')} · destino actual <span className="font-mono">{edit.pallet.target ?? '—'}</span></div>
            <Input value={edit.filter} onChange={(e) => setEdit({ ...edit, filter: e.target.value })} placeholder={`Buscar entre ${edit.list.length} ubicaciones (ej. R03-N02 o PISO-B)`} className="font-mono" />
            <select value={edit.selected} onChange={(e) => setEdit({ ...edit, selected: e.target.value })} size={Math.min(12, Math.max(3, shown.length))} className="w-full rounded-md border border-slate-300 p-1 font-mono text-sm">
              {shown.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.code}{o.has_same_sku ? ' · ya tiene este producto' : ''}{o.pallet_capacity > 0 ? ` · ${o.lpn_count}/${o.pallet_capacity}` : ''}{o.is_current ? ' (actual)' : ''}
                </option>
              ))}
            </select>
            <div className="text-xs text-slate-500">{shown.length} de {edit.list.length} ubicaciones · primero las que ya tienen el producto</div>
          </div>
        )}
      </Modal>
    </Card>
  );
}
