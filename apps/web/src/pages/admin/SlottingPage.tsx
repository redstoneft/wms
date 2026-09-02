import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminApi } from '../../api/admin';
import { useAuth } from '../../auth/AuthContext';
import { useToast } from '../../components/Toast';
import { Alert, Button, Card, Field, Input, PageHeader, Select, Table } from '../../components/ui';

const WEIGHTS = [
  ['same_sku', 'Misma SKU en la ubicación'],
  ['abc_proximity', 'Cercanía ABC (A cerca del picking)'],
  ['zone_match', 'Zona de reserva'],
  ['fill_rack', 'Consolidar racks parciales'],
  ['level_low_heavy', 'Pesados en niveles bajos'],
  ['family_affinity', 'Afinidad de familia'],
] as const;

export default function SlottingPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const rules = useQuery({ queryKey: ['slotting'], queryFn: adminApi.slottingRules });
  const [f, setF] = useState({ name: '', priority: '100', family: '', abc_class: '', weights: { same_sku: '30', abc_proximity: '20', zone_match: '25', fill_rack: '10', level_low_heavy: '15', family_affinity: '10' } as Record<string, string> });
  const create = useMutation({
    mutationFn: () =>
      adminApi.createSlottingRule({
        name: f.name,
        priority: Number(f.priority),
        weights: Object.fromEntries(Object.entries(f.weights).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)])),
        conditions: f.family || f.abc_class ? { family: f.family || undefined, abc_class: f.abc_class || undefined } : undefined,
      }),
    onSuccess: () => { toast.success('Regla creada'); void qc.invalidateQueries({ queryKey: ['slotting'] }); },
    onError: (e) => toast.error('No se pudo crear', e),
  });
  const del = useMutation({ mutationFn: (id: string) => adminApi.deleteSlottingRule(id), onSuccess: () => void qc.invalidateQueries({ queryKey: ['slotting'] }), onError: (e) => toast.error('Error', e) });
  return (
    <div>
      <PageHeader title="Reglas de slotting" subtitle="El motor de put-away puntúa cada ubicación candidata con estos pesos y registra la explicación en la tarea." />
      <div className="grid gap-4 lg:grid-cols-3">
        <Table
          rows={rules.data}
          loading={rules.isLoading}
          rowKey={(r) => r.id}
          columns={[
            { key: 'n', header: 'Regla', render: (r) => <b>{r.name}</b> },
            { key: 'p', header: 'Prioridad', render: (r) => r.priority, align: 'right' },
            { key: 'c', header: 'Condiciones', render: (r) => (r.conditions ? Object.entries(r.conditions).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(', ') || 'todas' : 'todas') },
            { key: 'w', header: 'Pesos', render: (r) => Object.entries(r.weights).map(([k, v]) => `${k}:${v}`).join(' ') },
            { key: 'a', header: 'Activa', render: (r) => (r.is_active ? 'Sí' : 'No') },
            { key: 'x', header: '', render: (r) => r.is_active && can('settings.manage') && <Button size="sm" variant="ghost" onClick={() => del.mutate(r.id)}>Desactivar</Button> },
          ]}
        />
        {can('settings.manage') ? (
          <Card title="Nueva regla" className="lg:col-span-1">
            <div className="grid gap-2">
              <Field label="Nombre" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
              <Field label="Prioridad (menor = primero)"><Input type="number" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} /></Field>
              <Field label="Condición: familia"><Input value={f.family} onChange={(e) => setF({ ...f, family: e.target.value })} /></Field>
              <Field label="Condición: clase ABC"><Select value={f.abc_class} onChange={(e) => setF({ ...f, abc_class: e.target.value })}><option value="">cualquiera</option><option>A</option><option>B</option><option>C</option></Select></Field>
              {WEIGHTS.map(([k, label]) => (
                <Field key={k} label={label}><Input type="number" value={f.weights[k] ?? ''} onChange={(e) => setF({ ...f, weights: { ...f.weights, [k]: e.target.value } })} /></Field>
              ))}
              <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!f.name}>Crear regla</Button>
            </div>
          </Card>
        ) : (
          <Alert tone="info">Sólo lectura (requiere settings.manage).</Alert>
        )}
      </div>
    </div>
  );
}
