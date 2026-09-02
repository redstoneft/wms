import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { adminApi } from '../../api/admin';
import type { AuditRow } from '../../api/types';
import { Button, Input, PageHeader, Table } from '../../components/ui';
import { useDebounced } from '../../lib/hooks';
import { fmtDateTime } from '../../lib/format';

export default function AuditPage() {
  const [f, setF] = useState({ entity_type: '', entity_id: '', action: '', from: '', to: '' });
  const df = useDebounced(f, 400);
  const [pages, setPages] = useState<string[]>([]); // before_id cursor stack
  const before = pages[pages.length - 1];
  const q = useQuery({
    queryKey: ['audit', df, before],
    queryFn: () => adminApi.audit({ entity_type: df.entity_type || undefined, entity_id: df.entity_id || undefined, action: df.action || undefined, from: df.from ? new Date(df.from).toISOString() : undefined, to: df.to ? new Date(df.to).toISOString() : undefined, limit: 100, before_id: before }),
  });
  const [open, setOpen] = useState<AuditRow | null>(null);
  return (
    <div>
      <PageHeader title="Auditoría" subtitle="Bitácora inmutable (append-only) de todas las acciones." />
      <div className="mb-3 grid gap-2 sm:grid-cols-5">
        <Input placeholder="Tipo de entidad (lpn, order…)" value={f.entity_type} onChange={(e) => { setF({ ...f, entity_type: e.target.value }); setPages([]); }} />
        <Input placeholder="ID de entidad" value={f.entity_id} onChange={(e) => { setF({ ...f, entity_id: e.target.value }); setPages([]); }} className="font-mono" />
        <Input placeholder="Acción (prefijo: pick., receipt.…)" value={f.action} onChange={(e) => { setF({ ...f, action: e.target.value }); setPages([]); }} />
        <Input type="datetime-local" value={f.from} onChange={(e) => { setF({ ...f, from: e.target.value }); setPages([]); }} />
        <Input type="datetime-local" value={f.to} onChange={(e) => { setF({ ...f, to: e.target.value }); setPages([]); }} />
      </div>
      <Table
        rows={q.data?.items}
        loading={q.isLoading}
        rowKey={(r) => r.id}
        onRowClick={(r) => setOpen(open?.id === r.id ? null : r)}
        selectedKey={open?.id ?? null}
        dense
        columns={[
          { key: 'id', header: '#', render: (r) => <span className="font-mono text-xs">{r.id}</span> },
          { key: 'at', header: 'Fecha', render: (r) => fmtDateTime(r.occurred_at) },
          { key: 'u', header: 'Usuario', render: (r) => r.username ?? 'sistema' },
          { key: 'a', header: 'Acción', render: (r) => <b>{r.action}</b> },
          { key: 'e', header: 'Entidad', render: (r) => <span className="font-mono text-xs">{r.entity_type} {r.entity_id?.slice(0, 8)}</span> },
          { key: 'r', header: 'Motivo', render: (r) => r.reason ?? '' },
          { key: 'ip', header: 'IP / dispositivo', render: (r) => <span className="text-xs">{r.ip ?? ''} {r.device_id ? `· ${r.device_id.slice(0, 8)}` : ''}</span> },
        ]}
      />
      {open && (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div>
            <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Antes</div>
            <pre className="thin-scroll max-h-72 overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-100">{JSON.stringify(open.before, null, 2) ?? 'null'}</pre>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold uppercase text-slate-500">Después</div>
            <pre className="thin-scroll max-h-72 overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-100">{JSON.stringify(open.after, null, 2) ?? 'null'}</pre>
          </div>
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <Button variant="secondary" size="sm" disabled={pages.length === 0} onClick={() => setPages(pages.slice(0, -1))}>Más recientes</Button>
        <Button variant="secondary" size="sm" disabled={!q.data?.next_before_id} onClick={() => q.data?.next_before_id && setPages([...pages, q.data.next_before_id])}>Más antiguos</Button>
      </div>
    </div>
  );
}
