import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { Permission } from '@wms/shared';
import { useAuth } from './auth/AuthContext';
import { AppShell } from './layout/AppShell';
import { Spinner } from './components/ui';

// office
const LoginPage = lazy(() => import('./pages/LoginPage'));
const MfaPage = lazy(() => import('./pages/MfaPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const MapPage = lazy(() => import('./map/MapPage'));
const LayoutPage = lazy(() => import('./pages/LayoutPage'));
const MasterDataPage = lazy(() => import('./pages/MasterDataPage'));
const ImportsPage = lazy(() => import('./pages/ImportsPage'));
const ContainersPage = lazy(() => import('./pages/inbound/ContainersPage'));
const ContainerDetailPage = lazy(() => import('./pages/inbound/ContainerDetailPage'));
const ReceiptsPage = lazy(() => import('./pages/inbound/ReceiptsPage'));
const ReceiptDetailPage = lazy(() => import('./pages/inbound/ReceiptDetailPage'));
const InventoryPage = lazy(() => import('./pages/inventory/InventoryPage'));
const LpnDetailPage = lazy(() => import('./pages/inventory/LpnDetailPage'));
const StoragePage = lazy(() => import('./pages/StoragePage'));
const OrdersPage = lazy(() => import('./pages/orders/OrdersPage'));
const OrderDetailPage = lazy(() => import('./pages/orders/OrderDetailPage'));
const PickingPage = lazy(() => import('./pages/orders/PickingPage'));
const ShipmentsPage = lazy(() => import('./pages/shipments/ShipmentsPage'));
const ShipmentDetailPage = lazy(() => import('./pages/shipments/ShipmentDetailPage'));
const IncidentsPage = lazy(() => import('./pages/IncidentsPage'));
const ReturnsPage = lazy(() => import('./pages/ReturnsPage'));
const LabelsPage = lazy(() => import('./pages/LabelsPage'));
const TimelinePage = lazy(() => import('./pages/TimelinePage'));
const AccountPage = lazy(() => import('./pages/AccountPage'));
const UsersPage = lazy(() => import('./pages/admin/UsersPage'));
const SettingsPage = lazy(() => import('./pages/admin/SettingsPage'));
const AuthorizationsPage = lazy(() => import('./pages/admin/AuthorizationsPage'));
const AuditPage = lazy(() => import('./pages/admin/AuditPage'));
const SlottingPage = lazy(() => import('./pages/admin/SlottingPage'));
const SaePage = lazy(() => import('./pages/admin/SaePage'));
// warehouse mode
const WmHomePage = lazy(() => import('./wm/WmHomePage'));
const WmReceivePage = lazy(() => import('./wm/WmReceivePage'));
const WmPutawayPage = lazy(() => import('./wm/WmPutawayPage'));
const WmTransferPage = lazy(() => import('./wm/WmTransferPage'));
const WmReplenishPage = lazy(() => import('./wm/WmReplenishPage'));
const WmCountPage = lazy(() => import('./wm/WmCountPage'));
const WmPickPage = lazy(() => import('./wm/WmPickPage'));
const WmStagePage = lazy(() => import('./wm/WmStagePage'));
const WmVerifyPage = lazy(() => import('./wm/WmVerifyPage'));
const WmLoadPage = lazy(() => import('./wm/WmLoadPage'));

function FullSpinner() {
  return (
    <div className="grid min-h-screen place-items-center bg-slate-100 text-slate-500">
      <Spinner size={32} />
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading, mfaPending } = useAuth();
  const loc = useLocation();
  if (loading) return <FullSpinner />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (mfaPending && loc.pathname !== '/mfa') return <Navigate to="/mfa" replace />;
  return <>{children}</>;
}

function Perm({ any, children }: { any: Permission[]; children: ReactNode }) {
  const { canAny } = useAuth();
  if (any.length && !canAny(...any)) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-amber-900">
        <h2 className="font-bold">Sin permiso</h2>
        <p className="text-sm">Tu rol no tiene acceso a esta pantalla ({any.join(' / ')}).</p>
      </div>
    );
  }
  return <>{children}</>;
}

function Office({ perms, children }: { perms: Permission[]; children: ReactNode }) {
  return (
    <RequireAuth>
      <AppShell>
        <Perm any={perms}>
          <Suspense fallback={<div className="p-6 text-slate-500">Cargando…</div>}>{children}</Suspense>
        </Perm>
      </AppShell>
    </RequireAuth>
  );
}
function Wm({ perms, children }: { perms: Permission[]; children: ReactNode }) {
  return (
    <RequireAuth>
      <Suspense fallback={<FullSpinner />}>
        <Perm any={perms}>{children}</Perm>
      </Suspense>
    </RequireAuth>
  );
}

export default function App() {
  return (
    <Suspense fallback={<FullSpinner />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/mfa"
          element={
            <RequireAuth>
              <MfaPage />
            </RequireAuth>
          }
        />
        <Route path="/" element={<Office perms={['dashboard.read']}><DashboardPage /></Office>} />
        <Route path="/map" element={<Office perms={['layout.read']}><MapPage /></Office>} />
        <Route path="/layout" element={<Office perms={['layout.read']}><LayoutPage /></Office>} />
        <Route path="/masterdata" element={<Office perms={['masterdata.read']}><MasterDataPage /></Office>} />
        <Route path="/imports" element={<Office perms={['imports.run']}><ImportsPage /></Office>} />
        <Route path="/inbound/containers" element={<Office perms={['containers.read']}><ContainersPage /></Office>} />
        <Route path="/inbound/containers/:id" element={<Office perms={['containers.read']}><ContainerDetailPage /></Office>} />
        <Route path="/inbound/receipts" element={<Office perms={['receiving.read']}><ReceiptsPage /></Office>} />
        <Route path="/inbound/receipts/:id" element={<Office perms={['receiving.read']}><ReceiptDetailPage /></Office>} />
        <Route path="/inventory" element={<Office perms={['inventory.read']}><InventoryPage /></Office>} />
        <Route path="/inventory/lpn/:code" element={<Office perms={['inventory.read', 'lpn.read']}><LpnDetailPage /></Office>} />
        <Route path="/storage" element={<Office perms={['putaway.execute', 'transfers.execute', 'replenishment.execute', 'counts.manage', 'counts.execute']}><StoragePage /></Office>} />
        <Route path="/orders" element={<Office perms={['orders.read']}><OrdersPage /></Office>} />
        <Route path="/orders/:id" element={<Office perms={['orders.read']}><OrderDetailPage /></Office>} />
        <Route path="/picking" element={<Office perms={['picking.assign', 'picking.execute']}><PickingPage /></Office>} />
        <Route path="/shipments" element={<Office perms={['shipments.read']}><ShipmentsPage /></Office>} />
        <Route path="/shipments/:id" element={<Office perms={['shipments.read']}><ShipmentDetailPage /></Office>} />
        <Route path="/incidents" element={<Office perms={['incidents.read']}><IncidentsPage /></Office>} />
        <Route path="/incidents/:id" element={<Office perms={['incidents.read']}><IncidentsPage /></Office>} />
        <Route path="/returns" element={<Office perms={['returns.manage', 'orders.read']}><ReturnsPage /></Office>} />
        <Route path="/returns/:id" element={<Office perms={['returns.manage', 'orders.read']}><ReturnsPage /></Office>} />
        <Route path="/labels" element={<Office perms={['labels.print']}><LabelsPage /></Office>} />
        <Route path="/timeline" element={<Office perms={['inventory.read', 'lpn.read']}><TimelinePage /></Office>} />
        <Route path="/timeline/:lpn" element={<Office perms={['inventory.read', 'lpn.read']}><TimelinePage /></Office>} />
        <Route path="/account" element={<Office perms={[]}><AccountPage /></Office>} />
        <Route path="/admin/users" element={<Office perms={['users.manage']}><UsersPage /></Office>} />
        <Route path="/admin/settings" element={<Office perms={['settings.manage']}><SettingsPage /></Office>} />
        <Route path="/admin/authorizations" element={<Office perms={['exceptions.authorize']}><AuthorizationsPage /></Office>} />
        <Route path="/admin/audit" element={<Office perms={['audit.read']}><AuditPage /></Office>} />
        <Route path="/admin/slotting" element={<Office perms={['layout.read']}><SlottingPage /></Office>} />
        <Route path="/admin/sae" element={<Office perms={['imports.run']}><SaePage /></Office>} />

        <Route path="/wm" element={<Wm perms={[]}><WmHomePage /></Wm>} />
        <Route path="/wm/receive" element={<Wm perms={['receiving.scan']}><WmReceivePage /></Wm>} />
        <Route path="/wm/putaway" element={<Wm perms={['putaway.execute']}><WmPutawayPage /></Wm>} />
        <Route path="/wm/transfer" element={<Wm perms={['transfers.execute']}><WmTransferPage /></Wm>} />
        <Route path="/wm/replenish" element={<Wm perms={['replenishment.execute']}><WmReplenishPage /></Wm>} />
        <Route path="/wm/count" element={<Wm perms={['counts.execute']}><WmCountPage /></Wm>} />
        <Route path="/wm/pick" element={<Wm perms={['picking.execute']}><WmPickPage /></Wm>} />
        <Route path="/wm/stage" element={<Wm perms={['picking.execute']}><WmStagePage /></Wm>} />
        <Route path="/wm/verify" element={<Wm perms={['verification.execute']}><WmVerifyPage /></Wm>} />
        <Route path="/wm/load" element={<Wm perms={['loading.execute']}><WmLoadPage /></Wm>} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
