import type { Permission } from '@wms/shared';

export interface NavItem {
  to: string;
  label: string;
  icon: string; // emoji keeps the bundle asset-free
  /** any of these permissions shows the entry; empty = always */
  perms: Permission[];
  wm?: boolean;
}
export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    label: 'General',
    items: [
      { to: '/', label: 'Tablero', icon: '▦', perms: ['dashboard.read'] },
      { to: '/map', label: 'Mapa 3D', icon: '⬢', perms: ['layout.read'] },
      { to: '/timeline', label: 'Trazabilidad', icon: '⟲', perms: ['inventory.read', 'lpn.read'] },
    ],
  },
  {
    label: 'Entradas',
    items: [
      { to: '/inbound/containers', label: 'Contenedores', icon: '▣', perms: ['containers.read'] },
      { to: '/inbound/receipts', label: 'Recepciones', icon: '⇩', perms: ['receiving.read'] },
      { to: '/returns', label: 'Devoluciones', icon: '↩', perms: ['returns.manage', 'orders.read'] },
    ],
  },
  {
    label: 'Inventario',
    items: [
      { to: '/inventory', label: 'Inventario', icon: '☰', perms: ['inventory.read'] },
      { to: '/storage', label: 'Almacenaje', icon: '⇄', perms: ['putaway.execute', 'transfers.execute', 'replenishment.execute', 'counts.manage', 'counts.execute'] },
      { to: '/incidents', label: 'Incidencias', icon: '⚠', perms: ['incidents.read'] },
    ],
  },
  {
    label: 'Salidas',
    items: [
      { to: '/orders', label: 'Pedidos', icon: '≣', perms: ['orders.read'] },
      { to: '/picking', label: 'Surtido', icon: '☑', perms: ['picking.assign', 'picking.execute'] },
      { to: '/shipments', label: 'Embarques', icon: '⇧', perms: ['shipments.read'] },
    ],
  },
  {
    label: 'Catálogos',
    items: [
      { to: '/masterdata', label: 'Datos maestros', icon: '▤', perms: ['masterdata.read'] },
      { to: '/layout', label: 'Layout', icon: '⊞', perms: ['layout.read'] },
      { to: '/labels', label: 'Etiquetas', icon: '⌸', perms: ['labels.print'] },
      { to: '/imports', label: 'Importaciones', icon: '⇪', perms: ['imports.run'] },
    ],
  },
  {
    label: 'Administración',
    items: [
      { to: '/admin/users', label: 'Usuarios', icon: '☺', perms: ['users.manage'] },
      { to: '/admin/authorizations', label: 'Autorizaciones', icon: '✔', perms: ['exceptions.authorize'] },
      { to: '/admin/audit', label: 'Auditoría', icon: '≡', perms: ['audit.read'] },
      { to: '/admin/slotting', label: 'Slotting', icon: '⊟', perms: ['layout.read'] },
      { to: '/admin/settings', label: 'Configuración', icon: '⚙', perms: ['settings.manage'] },
    ],
  },
];

/** Warehouse-mode entry points (handheld). */
export const WM_NAV: NavItem[] = [
  { to: '/wm/receive', label: 'Recibir', icon: '⇩', perms: ['receiving.scan'], wm: true },
  { to: '/wm/putaway', label: 'Ubicar', icon: '⇲', perms: ['putaway.execute'], wm: true },
  { to: '/wm/transfer', label: 'Traslados', icon: '⇄', perms: ['transfers.execute'], wm: true },
  { to: '/wm/replenish', label: 'Reabasto', icon: '⇈', perms: ['replenishment.execute'], wm: true },
  { to: '/wm/count', label: 'Conteo', icon: '#', perms: ['counts.execute'], wm: true },
  { to: '/wm/pick', label: 'Surtir', icon: '☑', perms: ['picking.execute'], wm: true },
  { to: '/wm/stage', label: 'Staging', icon: '▥', perms: ['picking.execute'], wm: true },
  { to: '/wm/verify', label: 'Verificar', icon: '✓✓', perms: ['verification.execute'], wm: true },
  { to: '/wm/load', label: 'Cargar', icon: '⇧', perms: ['loading.execute'], wm: true },
];
