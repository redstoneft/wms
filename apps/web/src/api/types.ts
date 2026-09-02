// Response shapes of the API (read from apps/api/src/modules/*). BigInt and
// Decimal columns arrive as strings; Prisma Dates as ISO strings.
import type {
  ContainerStatus,
  IncidentSeverity,
  IncidentStatus,
  IncidentType,
  InventoryStatus,
  LocationStatus,
  LocationType,
  LpnStatus,
  OrderStatus,
  Permission,
  ReleaseProblem,
  Role,
  ShipmentStatus,
  UomCode,
  ZoneType,
} from '@wms/shared';

export type Uuid = string;
export type Qty = string; // bigint as string
export type Dec = string; // decimal as string
export type Iso = string;

export interface Me {
  id: Uuid;
  username: string;
  full_name: string;
  email?: string | null;
  roles: Role[];
  permissions: Permission[];
  mfa_enabled: boolean;
  mfa_pending: boolean;
  mfa_enrollment_required: boolean;
}

export interface LoginResponse {
  user: Omit<Me, 'mfa_pending' | 'mfa_enrollment_required'>;
  mfa_required: boolean;
  mfa_enrollment_required: boolean;
}

// ---- master data ----
export interface SkuUom {
  uom_code: UomCode;
  base_qty: Qty;
}
export interface SkuBarcode {
  id?: Uuid;
  barcode: string;
  uom_code: UomCode;
}
export interface Sku {
  id: Uuid;
  code: string;
  description: string;
  family: string | null;
  compatibility_group: string | null;
  abc_class: string;
  unit_weight_kg: Dec;
  case_length_cm: Dec | null;
  case_width_cm: Dec | null;
  case_height_cm: Dec | null;
  pallet_height_cm: Dec | null;
  requires_lot: boolean;
  requires_expiry: boolean;
  allow_negative: boolean;
  is_active: boolean;
  created_at: Iso;
  uoms: SkuUom[];
  barcodes: SkuBarcode[];
  inventory?: { status: string; qty: Qty; lpn_count: number }[];
}
export interface Party {
  id: Uuid;
  code: string;
  name: string;
  tax_id?: string | null;
  contact?: string | null;
  address?: string | null;
  is_active: boolean;
}
export interface Printer {
  id: Uuid;
  code: string;
  name: string;
  host: string;
  port: number;
  dpi: number;
  label_width_mm: number;
  label_height_mm: number;
  is_active: boolean;
  is_default: boolean;
}
export interface QuarantineReason {
  code: string;
  description: string;
  is_active: boolean;
}
export interface Paged<T> {
  items: T[];
  total: number;
}

// ---- layout ----
export interface Warehouse {
  id: Uuid;
  code: string;
  name: string;
  address: string | null;
  width_m: Dec;
  depth_m: Dec;
  height_m: Dec;
  is_active: boolean;
}
export interface Rack {
  id: Uuid;
  aisle_id: Uuid;
  code: string;
  bays: number;
  levels: number;
  positions_per_bay: number;
  bay_width_m: Dec | number;
  level_height_m: Dec | number;
  depth_m: Dec | number;
  x_m: Dec | number;
  y_m: Dec | number;
  rotation_deg: number;
  is_active: boolean;
  aisle?: Aisle & { zone: Zone };
}
export interface Aisle {
  id: Uuid;
  zone_id: Uuid;
  code: string;
  name: string | null;
  racks?: Rack[];
}
export interface Zone {
  id: Uuid;
  warehouse_id: Uuid;
  code: string;
  name: string;
  zone_type: ZoneType;
  color: string | null;
  x_m: Dec;
  y_m: Dec;
  width_m: Dec;
  depth_m: Dec;
  is_active: boolean;
  aisles?: Aisle[];
}
export interface LocationRow {
  id: Uuid;
  code: string;
  barcode: string;
  location_type: LocationType;
  admin_status: 'ACTIVE' | 'BLOCKED' | 'QUARANTINE';
  zone_id: Uuid | null;
  rack_id: Uuid | null;
  warehouse_id: Uuid;
  bay: number | null;
  level: number | null;
  position: number | null;
  x_m: Dec;
  y_m: Dec;
  z_m: Dec;
  width_m: Dec;
  depth_m: Dec;
  height_m: Dec;
  pallet_capacity: number;
  max_weight_kg: Dec;
  pick_sequence: number | null;
  is_active: boolean;
  block_reason: string | null;
  restrictions: Record<string, unknown> | null;
  status: LocationStatus;
  lpn_count: number;
  total_qty: Qty;
  weight_kg: Dec;
  reserved_count: number;
}
export interface LpnContent {
  sku_code: string;
  description: string;
  status: InventoryStatus;
  qty: Qty;
}
export interface LocationDetail extends LocationRow {
  zone_code: string | null;
  rack_code: string | null;
  lpns: { id: Uuid; code: string; status: LpnStatus; lpn_type: string; order_id: Uuid | null; contents: LpnContent[] }[];
  last_movement: { id: string; movement_type: string; occurred_at: Iso; qty: Qty; sku_code: string; username: string | null } | null;
}

// ---- 3D map ----
export interface MapRack {
  id: Uuid;
  code: string;
  aisle_code: string;
  zone_id: Uuid;
  zone_code: string;
  bays: number;
  levels: number;
  positions_per_bay: number;
  bay_width_m: number;
  level_height_m: number;
  depth_m: number;
  x_m: number;
  y_m: number;
  rotation_deg: number;
}
export interface MapLocation {
  id: Uuid;
  code: string;
  barcode: string;
  location_type: LocationType;
  zone_id: Uuid | null;
  rack_id: Uuid | null;
  bay: number | null;
  level: number | null;
  position: number | null;
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  h: number;
  pallet_capacity: number;
  status: LocationStatus;
  lpn_count: number;
  total_qty: Qty;
  weight_kg: number;
}
export interface MapOccupancy {
  scope: 'zone' | 'rack' | 'warehouse';
  id: string;
  total: number;
  occupied: number;
  pct: number;
}
export interface MapPayload {
  warehouse: Warehouse;
  zones: Zone[];
  racks: MapRack[];
  locations: MapLocation[];
  occupancy: MapOccupancy[];
  generated_at: Iso;
}
export type MapSearchType = 'SKU' | 'LPN' | 'LOCATION' | 'ORDER';
export interface MapSearchHit {
  location_id: Uuid | null;
  code: string | null;
  lpn_code?: string | null;
  qty?: Qty;
  status?: string;
  kind?: string;
}
export interface MapSearchResult {
  type: MapSearchType;
  hits: MapSearchHit[];
}

// ---- inbound ----
export interface PurchaseOrder {
  id: Uuid;
  po_number: string;
  supplier_id: Uuid;
  status: string;
  expected_date: Iso | null;
  notes: string | null;
  supplier?: Party;
  lines?: { id: Uuid; line_no: number; sku_id: Uuid; ordered_qty: Qty; received_qty: Qty; uom_code: UomCode; uom_qty: Qty; sku?: Sku }[];
}
export interface Container {
  id: Uuid;
  container_number: string;
  supplier_id: Uuid | null;
  po_id: Uuid | null;
  carrier_id: Uuid | null;
  bl_number: string | null;
  seal_number: string | null;
  plates: string | null;
  driver_name: string | null;
  status: ContainerStatus;
  scheduled_at: Iso | null;
  arrived_at: Iso | null;
  opened_at: Iso | null;
  unload_started_at: Iso | null;
  unload_finished_at: Iso | null;
  closed_at: Iso | null;
  dock_location_id: Uuid | null;
  notes: string | null;
  created_at: Iso;
  version: number;
  supplier?: Party | null;
  carrier?: Party | null;
  po?: PurchaseOrder | null;
  receipts?: Receipt[];
  lpns?: { id: Uuid; code: string; status: LpnStatus }[];
  photos?: Attachment[];
  incidents?: Incident[];
}
export interface ReceiptLine {
  id: Uuid;
  receipt_id: Uuid;
  sku_id: Uuid;
  expected_qty: Qty;
  received_qty: Qty;
  damaged_qty: Qty;
  status: 'PENDING' | 'PARTIAL' | 'COMPLETE' | 'OVER' | 'SHORT';
  sku: Pick<Sku, 'code' | 'description'> & Partial<Sku>;
}
export interface Receipt {
  id: Uuid;
  receipt_number: string;
  container_id: Uuid | null;
  po_id: Uuid | null;
  status: 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'CLOSED' | 'WITH_INCIDENT';
  receiving_location_id: Uuid;
  started_at: Iso;
  completed_at: Iso | null;
  closed_at: Iso | null;
  received_by: Uuid | null;
  notes: string | null;
  created_at: Iso;
  container?: { container_number: string } | Container | null;
  lines?: ReceiptLine[];
  lpns?: (Lpn & { balances?: { sku_id: Uuid; status: InventoryStatus; qty: Qty; sku: { code: string } }[] })[];
}
export interface ReceiveScanResult {
  lpn: { id: Uuid; code: string; is_new: boolean };
  sku: { id: Uuid; code: string; description: string };
  qty_base: Qty;
  line: { expected_qty: Qty; received_qty: Qty; status: string };
  movement_id: string;
  unexpected_sku: boolean;
}
export interface Attachment {
  id: Uuid;
  entity_type: string;
  entity_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: Iso;
}

// ---- inventory ----
export interface Lpn {
  id: Uuid;
  code: string;
  lpn_type: string;
  status: LpnStatus;
  warehouse_id: Uuid;
  current_location_id: Uuid | null;
  receipt_id: Uuid | null;
  container_id: Uuid | null;
  supplier_id: Uuid | null;
  order_id: Uuid | null;
  shipment_id: Uuid | null;
  cases_count: number;
  weight_kg: Dec | null;
  lot: string | null;
  expiry_date: Iso | null;
  version: number;
  created_at: Iso;
}
export interface LpnDetail extends Lpn {
  balances: { id: Uuid; sku_id: Uuid; status: InventoryStatus; qty: Qty; sku: Sku }[];
  current_location: (LocationRow & { zone?: Zone | null }) | null;
  receipt: Receipt | null;
  container: Container | null;
  supplier: Party | null;
  order: (Order & { customer: Party }) | null;
  shipment: Shipment | null;
}
export interface InventorySkuRow {
  sku_id: Uuid;
  code: string;
  description: string;
  abc_class: string;
  family: string | null;
  available: Qty;
  allocated: Qty;
  outbound: Qty;
  locked: Qty;
  in_transfer: Qty;
  total: Qty;
  lpn_count: number;
}
export interface InventoryLpnRow {
  id: Uuid;
  code: string;
  status: LpnStatus;
  lpn_type: string;
  created_at: Iso;
  cases_count: number;
  weight_kg: Dec | null;
  lot: string | null;
  expiry_date: Iso | null;
  location_code: string | null;
  location_id: Uuid | null;
  zone_code: string | null;
  order_number: string | null;
  shipment_number: string | null;
  contents: LpnContent[] | null;
  total_qty: Qty;
}
export interface ZoneInventoryRow {
  zone_id: Uuid;
  zone_code: string;
  zone_type: ZoneType;
  locations: number;
  lpns: number;
  qty: Qty;
  weight_kg: Dec;
}
export interface MovementRow {
  id: string;
  movement_type: string;
  occurred_at: Iso;
  qty: Qty;
  uom_code: UomCode;
  uom_qty: Qty;
  sku_code: string;
  from_lpn: string | null;
  to_lpn: string | null;
  from_location: string | null;
  to_location: string | null;
  from_status: string | null;
  to_status: string | null;
  username: string | null;
  device_id: string | null;
  reason: string | null;
  reference_type: string | null;
  reference_id: string | null;
  order_number: string | null;
  receipt_number: string | null;
  shipment_number: string | null;
}
export interface TimelineEvent {
  at: Iso;
  kind?: 'MOVEMENT' | 'LABEL' | 'AUDIT' | 'TASK';
  event: string;
  sku?: string | null;
  qty?: Qty | null;
  from_lpn?: string | null;
  to_lpn?: string | null;
  from_location: string | null;
  to_location: string | null;
  from_status: string | null;
  to_status: string | null;
  username: string | null;
  reason: string | null;
  order_id?: string | null;
  receipt_id?: string | null;
  shipment_id?: string | null;
  order_number?: string | null;
  receipt_number?: string | null;
  shipment_number?: string | null;
  ref: string;
}
export interface LpnTimeline {
  lpn: Lpn;
  events: TimelineEvent[];
  orders: { order_number: string; status: string; picker: string | null; verifier: string | null; shipment_number: string | null; vehicle: string | null; plates: string | null; released_at: Iso | null; departed_at: Iso | null }[];
}
export interface SkuTimeline {
  sku: Sku;
  events: TimelineEvent[];
}
export interface ReconcileResult {
  ok: boolean;
  checked_at: Iso;
  balance_discrepancies: unknown[];
  location_discrepancies: unknown[];
  negative_balances: number;
  stored_lpns_without_location: number;
  order_line_discrepancies: unknown[];
  totals_by_status: { status: string; qty: Qty }[];
}

// ---- put-away / transfers / replenishment ----
export interface PutawayTaskRow {
  id: Uuid;
  status: string;
  created_at: Iso;
  started_at: Iso | null;
  assigned_to: Uuid | null;
  suggested_location_id: Uuid | null;
  lpn_code: string;
  current_location_id: Uuid | null;
  current_location: string | null;
  suggested_location: string | null;
  assigned_username: string | null;
  contents: { sku: string; qty: Qty }[] | null;
}
export interface PutawayStartResult {
  task: { id: Uuid; status: string; suggested_location_id: Uuid | null; explanation?: unknown };
  lpn: { id: Uuid; code: string; current_location_id: Uuid | null };
  target: { id: Uuid; code: string; barcode: string } | null;
  contents: { sku_code: string; description: string; qty: Qty }[];
}
export interface PutawayConfirmResult {
  lpn_code: string;
  location: string;
  movements: string[];
  overridden: boolean;
}
export interface TransferRow {
  id: Uuid;
  transfer_type: string;
  lpn_id: Uuid;
  from_location_id: Uuid;
  to_location_id: Uuid;
  status: string;
  started_by: Uuid;
  started_at: Iso;
  completed_at: Iso | null;
  reason: string | null;
  lpn_code: string;
  from_code: string;
  to_code: string;
  to_barcode: string;
  started_by_username: string | null;
}
export interface TransferStartResult {
  transfer: { id: Uuid; status: string };
  lpn_code: string;
  to_location: { id: Uuid; code: string; barcode: string };
}
export interface ReplenTaskRow {
  id: Uuid;
  rule_id: Uuid;
  sku_id: Uuid;
  source_lpn_id: Uuid | null;
  from_location_id: Uuid | null;
  to_location_id: Uuid;
  qty: Qty;
  status: string;
  transfer_id: Uuid | null;
  created_at: Iso;
  sku_code: string;
  description: string;
  source_lpn_code: string | null;
  from_code: string | null;
  to_code: string;
  to_barcode: string;
}
export interface ReplenRule {
  id: Uuid;
  sku_id: Uuid;
  pick_location_id: Uuid;
  min_qty: Qty;
  max_qty: Qty;
  is_active: boolean;
  sku_code: string;
  location_code: string;
  current_qty: Qty;
}

// ---- counts ----
export interface CountTask {
  id: Uuid;
  count_type: string;
  scope: { location_ids: Uuid[]; sku_ids?: Uuid[] };
  status: string;
  is_blind: boolean;
  scheduled_for: Iso | null;
  assigned_to: Uuid | null;
  incident_id: Uuid | null;
  created_by: Uuid;
  created_at: Iso;
  completed_at: Iso | null;
  notes: string | null;
  lines?: number;
}
export interface CountTaskView {
  task: CountTask;
  locations: { id: Uuid; code: string; barcode: string }[];
  lines: { id: Uuid; status: string; location_code: string; lpn_code: string | null; sku_code: string; description: string; counted_qty: Qty | null; recount_qty: Qty | null; system_qty: Qty | null; variance: Qty | null }[];
}

// ---- orders ----
export interface OrderLine {
  id: Uuid;
  line_no: number;
  sku_id: Uuid;
  required_qty: Qty;
  uom_code: UomCode;
  uom_qty: Qty;
  allocated_qty: Qty;
  picked_qty: Qty;
  verified_qty: Qty;
  loaded_qty: Qty;
  sku: Sku;
  allocations?: { id: Uuid; qty: Qty; picked_qty: Qty; status: string; strategy: string; lpn: { code: string; current_location: { code: string } | null } }[];
}
export interface Order {
  id: Uuid;
  order_number: string;
  customer_id: Uuid;
  destination: string | null;
  order_date: Iso | null;
  priority: number;
  status: OrderStatus;
  source: string;
  external_ref: string | null;
  shipment_id: Uuid | null;
  picker_id: Uuid | null;
  verifier_id: Uuid | null;
  verified_at: Iso | null;
  notes: string | null;
  version: number;
  created_at: Iso;
}
export interface OrderListItem extends Order {
  customer: { code: string; name: string };
  shipment: { shipment_number: string } | null;
  line_count: number;
  totals: { required: Qty; allocated: Qty; picked: Qty; verified: Qty; loaded: Qty };
}
export interface OrderDetail extends Order {
  customer: Party;
  lines: OrderLine[];
  pick_tasks: { id: Uuid; status: string; assigned_to: Uuid | null; created_at: Iso; started_at: Iso | null; completed_at: Iso | null }[];
  staging_assignments: { id: Uuid; location: { code: string; barcode: string } }[];
  verifications: { id: Uuid; status: string; verifier_id: Uuid; started_at: Iso; completed_at: Iso | null; notes: string | null }[];
  shipment: Shipment | null;
  lpns: { id: Uuid; code: string; status: LpnStatus; current_location: { code: string } | null }[];
  picker: { username: string; full_name: string } | null;
  verifier: { username: string; full_name: string } | null;
}
export interface AllocateResult {
  order_id: Uuid;
  status: string;
  strategy: string;
  lines: { sku: string; required: Qty; allocated_before: Qty; allocated_now: Qty; short: Qty; lpns: string[] }[];
}

// ---- picking ----
export interface PickTaskRow {
  id: Uuid;
  status: string;
  assigned_to: Uuid | null;
  created_at: Iso;
  started_at: Iso | null;
  order_number: string;
  priority: number;
  customer: string;
  assigned_username: string | null;
  lines: Qty;
  picked_lines: Qty;
  staging_code: string | null;
}
export interface PickLine {
  id: Uuid;
  sequence: number;
  status: 'PENDING' | 'IN_PROGRESS' | 'PICKED' | 'SHORT' | 'CANCELLED';
  scan_step: number;
  qty: Qty;
  picked_qty: Qty;
  full_pallet: boolean;
  location_code: string;
  location_barcode: string;
  lpn_code: string;
  sku_code: string;
  sku_description: string;
  uoms: SkuUom[] | null;
}
export interface PickTaskView {
  task: { id: Uuid; status: string; assigned_to: Uuid | null; started_at: Iso | null; completed_at: Iso | null; outbound_lpn: string | null };
  order: { id: Uuid; order_number: string; customer: string; destination: string | null; status: OrderStatus };
  staging: { id: Uuid; code: string; barcode: string } | null;
  lines: PickLine[];
}
export interface PickScanResult {
  ok: true;
  next: 'LPN' | 'QTY' | 'NEXT_LINE';
  line_id: Uuid;
  expected_lpn?: string;
  sku?: string;
  remaining?: Qty;
  full_pallet?: boolean;
  picked?: Qty;
  outbound_lpn?: string;
  task_completed?: boolean;
}
export interface StagingRow {
  id: Uuid;
  code: string;
  barcode: string;
  order_id: Uuid | null;
  order_number: string | null;
  order_status: string | null;
  customer: string | null;
  assigned_at: Iso | null;
  lpn_count: Qty;
}

// ---- verification ----
export interface PendingVerificationOrder {
  id: Uuid;
  order_number: string;
  priority: number;
  customer: string;
  picker_id: Uuid | null;
  picker: string | null;
  staging_code: string | null;
  staged_lpns: Qty;
}
export interface VerificationView {
  id: Uuid;
  status: string;
  order: { id: Uuid; order_number: string; customer: string };
  verifier_id: Uuid;
  started_at: Iso;
  completed_at: Iso | null;
  lpns: string[];
  lines: { id: Uuid; lpn: string | null; sku: string; description: string; scanned_qty: Qty; expected_qty: Qty | null; complete: boolean }[];
  progress: { scanned_lines: number; total_lines: number };
}
export interface VerificationRow {
  id: Uuid;
  order_id: Uuid;
  verifier_id: Uuid;
  status: string;
  started_at: Iso;
  completed_at: Iso | null;
  notes: string | null;
  order: { order_number: string };
}

// ---- shipments ----
export interface ReleaseLine {
  order_number: string;
  sku_code: string;
  required_qty: Qty;
  picked_qty: Qty;
  verified_qty: Qty;
  loaded_qty: Qty;
  ok: boolean;
  problems: ReleaseProblem[];
}
export interface ReleaseCheck {
  shipment_id: Uuid;
  can_release: boolean;
  lines: ReleaseLine[];
  blocking_reasons: string[];
  totals: { required: Qty; loaded: Qty };
}
export interface Shipment {
  id: Uuid;
  shipment_number: string;
  carrier_id: Uuid | null;
  vehicle: string | null;
  plates: string | null;
  driver_name: string | null;
  destination: string | null;
  dock_location_id: Uuid | null;
  status: ShipmentStatus;
  loading_started_at: Iso | null;
  loading_finished_at: Iso | null;
  released_at: Iso | null;
  departed_at: Iso | null;
  notes: string | null;
  version: number;
  created_at: Iso;
}
export interface ShipmentListItem extends Shipment {
  carrier: Party | null;
  orders: { id: Uuid; order_number: string; status: OrderStatus }[];
  _count: { lpns: number };
}
export interface ShipmentDetail extends Shipment {
  carrier: Party | null;
  orders: (Order & { customer: Party; lines: OrderLine[] })[];
  lpns: { id: Uuid; code: string; status: LpnStatus; order_id: Uuid | null }[];
  dock: { code: string; barcode: string } | null;
  release: ReleaseCheck;
}
export interface LoadScanResult {
  lpn_code: string;
  order_number: string;
  order_loaded: boolean;
  movements: string[];
  release: { can_release: boolean; blocking: number };
}

// ---- incidents ----
export interface Incident {
  id: Uuid;
  incident_number: string;
  incident_type: IncidentType;
  severity: IncidentSeverity;
  status: IncidentStatus;
  title: string;
  description: string | null;
  entity_type: string | null;
  entity_id: string | null;
  sku_id: Uuid | null;
  lpn_id: Uuid | null;
  location_id: Uuid | null;
  order_id: Uuid | null;
  shipment_id: Uuid | null;
  receipt_id: Uuid | null;
  qty: Qty | null;
  reported_by: Uuid;
  assigned_to: Uuid | null;
  resolution: string | null;
  resolved_by: Uuid | null;
  resolved_at: Iso | null;
  created_at: Iso;
  updated_at: Iso;
}
export interface IncidentDetail extends Incident {
  comments: { id: Uuid; user_id: Uuid; body: string; created_at: Iso }[];
  attachments: Attachment[];
  sku: { code: string; description: string } | null;
  lpn: { code: string } | null;
  location: { code: string } | null;
}

// ---- returns ----
export interface ReturnLine {
  id: Uuid;
  sku_id: Uuid;
  expected_qty: Qty;
  received_qty: Qty;
  disposition: string | null;
  disposition_qty: Qty;
  lpn_id: Uuid | null;
  notes: string | null;
  sku: Sku;
}
export interface Return {
  id: Uuid;
  return_number: string;
  customer_id: Uuid;
  original_order_id: Uuid | null;
  status: string;
  reason: string | null;
  received_at: Iso | null;
  closed_at: Iso | null;
  created_at: Iso;
  customer: Party;
  original_order: { order_number: string } | Order | null;
  lines: ReturnLine[];
  lpns?: { id: Uuid; code: string; status: LpnStatus }[];
}

// ---- labels ----
export interface LabelModel {
  label_type: string;
  title: string;
  barcode: string;
  qr?: string;
  lines: { label: string; value: string }[];
  footer?: string;
  copies?: number;
  sku_lines?: { sku: string; description: string; qty: string; cases: string }[];
}
export interface LabelPreview {
  print_id: Uuid;
  model: LabelModel;
  zpl: string;
  barcode_png: string;
  qr_png: string | null;
  is_reprint: boolean;
}
export interface LabelPrintResult {
  print_id: Uuid;
  status: string;
  model: LabelModel;
  zpl: string;
  is_reprint: boolean;
}
export interface LabelHistoryRow {
  id: Uuid;
  label_type: string;
  entity_id: string;
  is_reprint: boolean;
  reprint_reason: string | null;
  printed_by: Uuid;
  status: string;
  error: string | null;
  created_at: Iso;
  printer_id: Uuid | null;
}

// ---- imports ----
export interface ImportTemplate {
  columns: string[];
  example: string[];
  description: string;
}
export interface ImportRowError {
  row: number;
  column: string;
  message: string;
}
export interface ImportResult {
  job_id: Uuid;
  status: 'VALIDATED' | 'REJECTED' | 'APPLIED' | 'FAILED';
  ok: boolean;
  total_rows: number;
  valid_rows: number;
  errors: ImportRowError[];
  summary: Record<string, unknown>;
  result?: Record<string, unknown>;
}
export interface ImportJob {
  id: Uuid;
  import_type: string;
  file_name: string;
  status: string;
  total_rows: number;
  valid_rows: number;
  error_rows: number;
  summary: Record<string, unknown> | null;
  errors?: ImportRowError[] | null;
  created_by: Uuid;
  created_at: Iso;
  applied_at: Iso | null;
}

// ---- dashboard ----
export interface Dashboard {
  generated_at: Iso;
  containers: Record<string, number>;
  receipts: Record<string, number>;
  pallets_without_location: number;
  putaway_tasks: Record<string, number>;
  orders: Record<string, number>;
  pick_tasks: Record<string, number>;
  staging: { total: number; used: number };
  shipments: Record<string, number>;
  incidents: Record<string, number>;
  cycle_counts: Record<string, number>;
  transfers_in_transit: number;
  replenishment_tasks: number;
  occupancy: { total: number; occupied: number; partial: number; blocked: number; utilization_pct: number };
  alerts: { level: 'warn' | 'error'; text: string }[];
}
export interface Kpis {
  period: { from: Iso; to: Iso };
  inventory_accuracy_pct: number | null;
  receiving_accuracy_pct: number | null;
  picking_accuracy_pct: number | null;
  loading_accuracy_pct: number | null;
  dock_to_stock_hours: { avg: number | null; p90: number | null };
  picking_productivity_lines_per_hour: number | null;
  receiving_productivity_lines_per_hour: number | null;
  warehouse_utilization_pct: number | null;
  order_cycle_time_hours: number | null;
  orders_shipped: number;
  incidence_rate_per_1000_movements: number | null;
  errors_by_user: { username: string; errors: number }[];
  errors_by_sku: { sku: string; errors: number }[];
  errors_by_customer: { customer: string; errors: number }[];
  stock_discrepancies: { lines: number; abs_units: Qty };
}

// ---- admin ----
export interface UserRow {
  id: Uuid;
  username: string;
  full_name: string;
  email: string | null;
  is_active: boolean;
  mfa_enabled: boolean;
  locked_until: Iso | null;
  roles: Role[];
  created_at: Iso;
}
export interface DirectoryUser {
  id: Uuid;
  username: string;
  full_name: string;
  roles: Role[];
}
export interface RoleRow {
  code: Role;
  name: string;
  description: string | null;
  permissions: Permission[];
}
export interface Settings {
  allocation_strategy: string;
  count_variance_recount_threshold: number;
  session_ttl_hours: number;
  require_mfa_for_admin: boolean;
}
export interface Authorization {
  id: Uuid;
  exception_type: string;
  entity_type: string;
  entity_id: string;
  requested_by: Uuid | null;
  supervisor_id: Uuid;
  reason: string;
  status: 'APPROVED' | 'CONSUMED' | 'REVOKED';
  created_at: Iso;
  consumed_at: Iso | null;
}
export interface AuditRow {
  id: string;
  occurred_at: Iso;
  user_id: Uuid | null;
  username: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  ip: string | null;
  device_id: string | null;
  request_id: string | null;
}
export interface SlottingRule {
  id: Uuid;
  name: string;
  priority: number;
  is_active: boolean;
  weights: Record<string, number>;
  conditions: Record<string, string> | null;
  created_at: Iso;
}
