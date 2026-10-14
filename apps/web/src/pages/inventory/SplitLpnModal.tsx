// Office "Dividir tarima": part of a pallet (stored or outbound) goes onto a new pallet at the same spot, or onto another
// pallet already there. Same rule as the handheld: the new pallet is born with its label, put-away and assembly bookkeeping.
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { pickingApi } from '../../api/orders';
import { useToast } from '../../components/Toast';
import { Button, Field, Input, Modal, Select } from '../../components/ui';
import { fmtQty } from '../../lib/format';

/** Office "Unir tarimas": everything on this storage pallet goes onto another stored pallet of the same model. */
export function MergeLpnModal({ open, onClose, lpn }: { open: boolean; onClose: () => void; lpn: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [to, setTo] = useState('');
  const m = useMutation({
    mutationFn: () => pickingApi.mergePallet({ from_lpn_code: lpn, to_lpn_code: to.trim().toUpperCase() }, api.newKey()),
    onSuccess: (r) => {
      toast.success(`${r.data.from_lpn} unida a ${r.data.to_lpn}`, `${r.data.moved.map((x) => `${fmtQty(x.qty)} ${x.sku}`).join(' · ')} → ${r.data.to_location ?? ''}. Ahora ${r.data.to_lpn} tiene ${fmtQty(r.data.to_qty)} pzas; ${r.data.from_lpn} queda vacía y su posición libre.`);
      void qc.invalidateQueries({ queryKey: ['lpn', lpn] });
      void qc.invalidateQueries({ queryKey: ['lpn-timeline', lpn] });
      onClose();
    },
    onError: (e) => toast.error('No se pudo unir', e),
  });
  return (
    <Modal open={open} onClose={onClose} title={`Unir ${lpn} a otra tarima`} footer={<div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button onClick={() => m.mutate()} loading={m.isPending} disabled={!to.trim()}>Unir</Button></div>}>
      <p className="mb-3 text-sm text-slate-600">Todo lo que hay en {lpn} pasa a la tarima destino, que debe ser de almacén y tener ya el mismo modelo. Las piezas se llevan físicamente a donde está la tarima destino; {lpn} desaparece y su posición queda libre. No se permite si {lpn} tiene surtido planeado.</p>
      <Field label="Tarima destino (LPN)" required>
        <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="PLT-2026-00000123" className="font-mono" />
      </Field>
    </Modal>
  );
}

export function SplitLpnModal({ open, onClose, lpn, contents }: { open: boolean; onClose: () => void; lpn: string; contents: { sku_code: string; description: string; qty: string }[] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState({ sku_code: contents[0]?.sku_code ?? '', qty: '', to_lpn_code: '' });
  const m = useMutation({
    mutationFn: () => pickingApi.splitPallet({ from_lpn_code: lpn, sku_code: f.sku_code, qty: f.qty.trim(), uom_code: 'PIECE', to_lpn_code: f.to_lpn_code.trim() || undefined }, api.newKey()),
    onSuccess: (r) => {
      toast.success(`${fmtQty(r.data.qty)} pzas de ${r.data.sku} pasaron a ${r.data.to_lpn}${r.data.created ? ' (tarima nueva)' : ''}`, `En ${r.data.from_lpn} quedan ${fmtQty(r.data.from_left)}${r.data.putaway_task_id ? ' · la nueva tiene su tarea de acomodo' : ''}. Imprime la etiqueta de ${r.data.to_lpn}.`);
      void qc.invalidateQueries({ queryKey: ['lpn', lpn] });
      void qc.invalidateQueries({ queryKey: ['lpn-timeline', lpn] });
      onClose();
    },
    onError: (e) => toast.error('No se pudo dividir', e),
  });
  const sel = contents.find((c) => c.sku_code === f.sku_code);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Dividir tarima ${lpn}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={() => m.mutate()} loading={m.isPending} disabled={!f.sku_code || !/^\d+$/.test(f.qty.trim()) || Number(f.qty) <= 0}>
            Dividir
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Producto que pasa a la otra tarima" required>
          <Select value={f.sku_code} onChange={(e) => setF({ ...f, sku_code: e.target.value })}>
            {contents.map((c) => (
              <option key={c.sku_code} value={c.sku_code}>
                {c.sku_code} · {c.description} · {fmtQty(c.qty)} pzas
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`Piezas que pasan${sel ? ` (hay ${fmtQty(sel.qty)})` : ''}`} required>
          <Input value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} inputMode="numeric" placeholder="Ej. 288" />
        </Field>
        <Field label="Tarima destino (vacío = tarima nueva en el mismo lugar)">
          <Input value={f.to_lpn_code} onChange={(e) => setF({ ...f, to_lpn_code: e.target.value.toUpperCase() })} className="font-mono" placeholder="PLT-2026-…" />
        </Field>
        <div className="text-xs text-slate-500">La tarima nueva nace en el mismo lugar, con el mismo estado; si la original tenía acomodo pendiente la nueva recibe su propia tarea, y si venía de un armado queda registrada como una tarima más de ese armado. La existencia total no cambia.</div>
      </div>
    </Modal>
  );
}
