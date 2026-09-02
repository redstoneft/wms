import type { Role } from './enums.js';

// Granular permission codes. The API enforces these on every route; the UI
// only uses them to hide what the user cannot do.
export const PERMISSIONS = {
  // admin / security
  'users.manage': 'Create, edit, deactivate users and assign roles',
  'settings.manage': 'Change system settings (allocation strategy, thresholds)',
  'audit.read': 'Read the audit log',
  'layout.manage': 'Create/move/configure zones, aisles, racks and locations',
  'layout.read': 'View warehouse layout and 3D map',
  'printers.manage': 'Configure Zebra printers',
  // master data
  'masterdata.read': 'View SKUs, customers, suppliers, carriers',
  'masterdata.manage': 'Create/edit SKUs, barcodes, UoMs, customers, suppliers',
  'imports.run': 'Import data files (SKUs, orders, inventory, ...)',
  // inbound
  'containers.read': 'View containers',
  'containers.manage': 'Create containers and change their status',
  'receiving.read': 'View receipts',
  'receiving.scan': 'Receive product by scanning (creates LPNs and inventory)',
  'receiving.close': 'Close receipts',
  'lpn.read': 'View LPNs and their history',
  'labels.print': 'Print labels',
  'labels.reprint': 'Reprint labels (audited)',
  // storage
  'putaway.execute': 'Execute directed put-away',
  'putaway.override': 'Override the suggested put-away location (supervisor)',
  'transfers.execute': 'Move LPNs between locations',
  'replenishment.execute': 'Execute replenishment tasks',
  'inventory.read': 'View inventory',
  'inventory.adjust': 'Create inventory adjustments (requires reason)',
  'inventory.quarantine': 'Move inventory to/from quarantine, block/unblock, mark damaged',
  'counts.manage': 'Create cycle count tasks',
  'counts.execute': 'Perform blind counts',
  'counts.approve': 'Approve count adjustments (supervisor)',
  // outbound
  'orders.read': 'View orders',
  'orders.manage': 'Create/import/accept/cancel orders',
  'orders.allocate': 'Allocate inventory to orders',
  'picking.execute': 'Execute picking tasks',
  'picking.assign': 'Assign picking tasks',
  'verification.execute': 'Perform second-person verification',
  'verification.override_same_user': 'Authorize picker == verifier exception (supervisor)',
  'shipments.read': 'View shipments',
  'shipments.manage': 'Create shipments, add orders',
  'loading.execute': 'Load LPNs onto trucks by scanning',
  'shipments.release': 'Release a shipment (all validations must pass)',
  // returns, incidents
  'returns.manage': 'Receive and classify returns',
  'incidents.read': 'View incidents',
  'incidents.create': 'Report incidents',
  'incidents.resolve': 'Resolve/close incidents',
  // dashboards
  'dashboard.read': 'View dashboard and KPIs',
  'reports.read': 'View reports and timelines',
  // exceptions
  'exceptions.authorize': 'Authorize exceptions (generic supervisor authorization)',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

const OPERATOR_COMMON: Permission[] = [
  'layout.read',
  'masterdata.read',
  'inventory.read',
  'lpn.read',
  'incidents.read',
  'incidents.create',
  'dashboard.read',
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  ADMIN: ALL_PERMISSIONS,
  SUPERVISOR: ALL_PERMISSIONS.filter((p) => p !== 'users.manage' && p !== 'settings.manage'),
  RECEIVING: [
    ...OPERATOR_COMMON,
    'containers.read',
    'containers.manage',
    'receiving.read',
    'receiving.scan',
    'receiving.close',
    'labels.print',
    'returns.manage',
  ],
  FORKLIFT: [
    ...OPERATOR_COMMON,
    'putaway.execute',
    'transfers.execute',
    'replenishment.execute',
    'receiving.read',
  ],
  PICKER: [...OPERATOR_COMMON, 'orders.read', 'picking.execute', 'labels.print'],
  VERIFIER: [...OPERATOR_COMMON, 'orders.read', 'verification.execute', 'shipments.read'],
  LOADER: [...OPERATOR_COMMON, 'orders.read', 'shipments.read', 'loading.execute'],
  INVENTORY_CONTROL: [
    ...OPERATOR_COMMON,
    'inventory.adjust',
    'inventory.quarantine',
    'counts.manage',
    'counts.execute',
    'transfers.execute',
    'orders.read',
    'receiving.read',
    'shipments.read',
    'reports.read',
    'audit.read',
    'labels.print',
    'labels.reprint',
    'imports.run',
    'masterdata.manage',
  ],
};

export function permissionsForRoles(roles: readonly Role[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const r of roles) for (const p of ROLE_PERMISSIONS[r] ?? []) out.add(p);
  return out;
}
