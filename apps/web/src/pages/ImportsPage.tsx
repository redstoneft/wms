// /imports — CSV/XLSX templates, validate → apply with per-row errors, history.
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IMPORT_TYPES } from '@wms/shared';
import { importsApi } from '../api/imports';
import type { ImportResult } from '../api/types';
import { useToast } from '../components/Toast';
import { Alert, Button, Card, Field, PageHeader, Select, StatusChip, Table } from '../components/ui';
import { fmtDateTime } from '../lib/format';

export default function ImportsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [type, setType] = useState<string>('SKUS');
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const templates = useQuery({ queryKey: ['import-templates'], queryFn: importsApi.templates });
  const history = useQuery({ queryKey: ['imports'], queryFn: () => importsApi.history({ limit: 50 }) });
  const run = useMutation({
    mutationFn: (mode: 'VALIDATE' | 'APPLY') => importsApi.run(type, mode, file!),
    onSuccess: (r, mode) => {
      setResult(r);
      if (mode === 'APPLY' && r.status === 'APPLIED') {
        toast.success('Importación aplicada', JSON.stringify(r.result ?? {}));
        setFile(null);
        if (fileRef.current) fileRef.current.value = '';
      } else if (r.ok) toast.success('Archivo válido', `${r.valid_rows} filas listas para aplicar`);
      else toast.warn('Archivo con errores', `${r.errors.length} error(es)`);
      void qc.invalidateQueries({ queryKey: ['imports'] });
    },
    onError: (e) => toast.error('La importación falló', e),
  });
  const download = async () => {
    try {
      const csv = await importsApi.templateCsv(type);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `template_${type.toLowerCase()}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast.error('No se pudo descargar la plantilla', e);
    }
  };
  const t = templates.data?.[type];

  return (
    <div>
      <PageHeader title="Importaciones" subtitle="Carga masiva por CSV o XLSX. Primero se valida (sin cambios); si no hay errores se aplica en una transacción." />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Archivo">
          <div className="grid gap-3">
            <Field label="Tipo de importación" required>
              <Select value={type} onChange={(e) => { setType(e.target.value); setResult(null); }}>
                {IMPORT_TYPES.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </Select>
            </Field>
            {t && (
              <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
                <div className="font-semibold">Columnas</div>
                <code className="block break-words">{t.columns.join(', ')}</code>
                {t.description && <div className="mt-1">{t.description}</div>}
              </div>
            )}
            <Button variant="secondary" onClick={download}>
              Descargar plantilla CSV
            </Button>
            <Field label="Archivo (.csv / .xlsx)" required>
              <input ref={fileRef} type="file" accept=".csv,.txt,.xlsx" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); }} className="block w-full text-sm" />
            </Field>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => run.mutate('VALIDATE')} disabled={!file} loading={run.isPending && run.variables === 'VALIDATE'}>
                Validar
              </Button>
              <Button onClick={() => run.mutate('APPLY')} disabled={!file || !result?.ok} loading={run.isPending && run.variables === 'APPLY'}>
                Aplicar
              </Button>
            </div>
          </div>
        </Card>
        <Card title="Resultado" className="lg:col-span-2">
          {!result && <p className="text-sm text-slate-500">Selecciona un archivo y valida.</p>}
          {result && (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
                <StatusChip status={result.status} />
                <span>{result.total_rows} filas</span>
                <span className="text-emerald-700">{result.valid_rows} válidas</span>
                <span className={result.errors.length ? 'text-rose-700' : ''}>{result.errors.length} errores</span>
                {Object.keys(result.summary ?? {}).length > 0 && <span className="text-xs text-slate-500">{JSON.stringify(result.summary)}</span>}
                {result.result && <span className="text-xs text-emerald-700">{JSON.stringify(result.result)}</span>}
              </div>
              {result.errors.length > 0 ? (
                <Table
                  rows={result.errors}
                  rowKey={(e) => `${e.row}-${e.column}-${e.message}`}
                  dense
                  columns={[
                    { key: 'r', header: 'Fila', render: (e) => e.row, align: 'right' },
                    { key: 'c', header: 'Columna', render: (e) => <span className="font-mono">{e.column || '—'}</span> },
                    { key: 'm', header: 'Error', render: (e) => <span className="text-rose-700">{e.message}</span> },
                  ]}
                />
              ) : (
                <Alert tone={result.status === 'APPLIED' ? 'success' : 'info'}>{result.status === 'APPLIED' ? 'Importación aplicada correctamente.' : 'Sin errores. Puedes aplicar la importación.'}</Alert>
              )}
            </>
          )}
        </Card>
      </div>
      <Card title="Historial" className="mt-4" padded={false}>
        <Table
          rows={history.data}
          loading={history.isLoading}
          rowKey={(j) => j.id}
          dense
          columns={[
            { key: 'd', header: 'Fecha', render: (j) => fmtDateTime(j.created_at) },
            { key: 't', header: 'Tipo', render: (j) => j.import_type },
            { key: 'f', header: 'Archivo', render: (j) => j.file_name },
            { key: 's', header: 'Estado', render: (j) => <StatusChip status={j.status} /> },
            { key: 'n', header: 'Filas', render: (j) => `${j.valid_rows}/${j.total_rows}`, align: 'right' },
            { key: 'e', header: 'Errores', render: (j) => j.error_rows, align: 'right' },
            { key: 'a', header: 'Aplicado', render: (j) => fmtDateTime(j.applied_at) },
            { key: 'su', header: 'Resumen', render: (j) => <span className="text-xs text-slate-500">{j.summary ? JSON.stringify(j.summary).slice(0, 80) : ''}</span> },
          ]}
        />
      </Card>
    </div>
  );
}
