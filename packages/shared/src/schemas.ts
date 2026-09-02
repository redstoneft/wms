// Zod schemas shared by API (authoritative validation) and web (form hints).
import { z } from 'zod';
import {
  ALLOCATION_STRATEGIES,
  CONTAINER_STATUSES,
  COUNT_TYPES,
  EXCEPTION_TYPES,
  INCIDENT_SEVERITIES,
  INCIDENT_TYPES,
  LABEL_TYPES,
  LOCATION_ADMIN_STATUSES,
  LOCATION_TYPES,
  RETURN_DISPOSITIONS,
  ROLES,
  UOM_CODES,
  ZONE_TYPES,
} from './enums.js';

// A positive integer quantity. Accepts number or numeric string; produces bigint.
export const zQty = z
  .union([z.number().int(), z.string().regex(/^\d+$/), z.bigint()])
  .transform((v) => (typeof v === 'bigint' ? v : BigInt(v)))
  .refine((v) => v > 0n, { message: 'quantity must be > 0' })
  .refine((v) => v <= 1_000_000_000_000n, { message: 'quantity too large' });

export const zQtyOrZero = z
  .union([z.number().int(), z.string().regex(/^\d+$/), z.bigint()])
  .transform((v) => (typeof v === 'bigint' ? v : BigInt(v)))
  .refine((v) => v >= 0n, { message: 'quantity must be >= 0' })
  .refine((v) => v <= 1_000_000_000_000n, { message: 'quantity too large' });

export const zUuid = z.string().uuid();
export const zCode = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/, 'invalid code characters');
export const zBarcode = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[\x21-\x7E]+$/, 'barcode must be printable ASCII without spaces');
export const zUom = z.enum(UOM_CODES);
export const zReason = z.string().trim().min(3).max(500);
export const zNote = z.string().trim().max(2000).optional();

// ---- auth ----
export const zLogin = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
  device_id: z.string().trim().max(128).optional(),
});
export const zMfaVerify = z.object({ code: z.string().regex(/^\d{6}$/) });
export const zChangePassword = z.object({
  current_password: z.string().min(1).max(256),
  new_password: z.string().min(12).max(256),
});

// ---- users ----
export const zCreateUser = z.object({
  username: z.string().trim().min(3).max(64).regex(/^[a-z0-9._-]+$/i),
  full_name: z.string().trim().min(1).max(200),
  email: z.string().email().max(254).optional(),
  password: z.string().min(12).max(256),
  roles: z.array(z.enum(ROLES)).min(1),
});
export const zUpdateUser = z.object({
  full_name: z.string().trim().min(1).max(200).optional(),
  email: z.string().email().max(254).nullable().optional(),
  is_active: z.boolean().optional(),
  roles: z.array(z.enum(ROLES)).min(1).optional(),
  reset_password: z.string().min(12).max(256).optional(),
});

// ---- master data ----
export const zSkuUom = z.object({ uom_code: zUom, base_qty: zQty });
export const zCreateSku = z.object({
  code: zCode,
  description: z.string().trim().min(1).max(300),
  family: z.string().trim().max(60).optional(),
  compatibility_group: z.string().trim().max(60).optional(),
  abc_class: z.enum(['A', 'B', 'C']).default('C'),
  unit_weight_kg: z.number().nonnegative().max(100000).default(0),
  case_length_cm: z.number().positive().max(10000).optional(),
  case_width_cm: z.number().positive().max(10000).optional(),
  case_height_cm: z.number().positive().max(10000).optional(),
  pallet_height_cm: z.number().positive().max(10000).optional(),
  requires_lot: z.boolean().default(false),
  requires_expiry: z.boolean().default(false),
  uoms: z.array(zSkuUom).default([]),
  barcodes: z.array(z.object({ barcode: zBarcode, uom_code: zUom.default('PIECE') })).default([]),
});
export const zUpdateSku = zCreateSku.partial().extend({ is_active: z.boolean().optional() });

export const zCreateParty = z.object({
  code: zCode,
  name: z.string().trim().min(1).max(200),
  tax_id: z.string().trim().max(40).optional(),
  contact: z.string().trim().max(500).optional(),
  address: z.string().trim().max(500).optional(),
});

// ---- layout ----
/** Building geometry captured from the topographic survey. Local frame: x along the facade (0..width_m), y into the building
 *  (0 = facade / FRONT, depth_m = BACK), z up. `estimated` marks elements inferred (not measured) so the map can say so. */
export const zWarehouseFeatures = z.object({
  source: z.string().trim().max(300).optional(),
  footprint: z.array(z.object({ x: z.number(), y: z.number() })).min(3).max(60).optional(), // floor polygon (L-shapes…); default = width × depth rectangle // e.g. "Levantamiento topográfico HIDRO, ADC, agosto 2026, esc. 1:300"
  north_deg: z.number().min(0).max(360).optional(), // compass azimuth of the +y (depth) axis
  columns: z.array(z.object({ x: z.number(), y: z.number(), size: z.number().positive().max(5).default(0.5), estimated: z.boolean().default(false) })).max(500).default([]),
  openings: z
    .array(z.object({ side: z.enum(['FRONT', 'BACK', 'LEFT', 'RIGHT']), from: z.number().min(0), width: z.number().positive(), kind: z.enum(['PORTON', 'PUERTA', 'RAMPA', 'ANDEN']), label: z.string().trim().max(60).optional(), estimated: z.boolean().default(false) }))
    .max(100)
    .default([]),
  context: z.array(z.object({ x: z.number(), y: z.number(), w: z.number().positive(), d: z.number().positive(), label: z.string().trim().max(80), kind: z.enum(['PATIO', 'VECINO', 'OFICINAS', 'EXTERIOR', 'OTRO']).default('OTRO'), h: z.number().positive().max(60).optional() })).max(50).default([]),
  exclusions: z.array(z.object({ x: z.number(), y: z.number(), w: z.number().positive(), d: z.number().positive(), label: z.string().trim().max(80), h: z.number().positive().max(60).optional() })).max(50).default([]), // built volumes inside the hall (offices, cubicles): not storage
  roof: z.object({ spans_x: z.array(z.number()).max(20), ridge_height_m: z.number().positive().max(60) }).optional(), // ridge lines (x) of the gable spans
});
export type WarehouseFeatures = z.infer<typeof zWarehouseFeatures>;

export const zCreateZone = z.object({
  warehouse_id: zUuid,
  code: zCode.max(20),
  name: z.string().trim().min(1).max(120),
  zone_type: z.enum(ZONE_TYPES),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  x_m: z.number().min(0).max(10000).default(0),
  y_m: z.number().min(0).max(10000).default(0),
  width_m: z.number().positive().max(10000).default(10),
  depth_m: z.number().positive().max(10000).default(10),
});
// NOTE: update schemas are written without defaults on purpose — `.partial()` over a schema with `.default()` would
// silently reset the omitted fields (a PATCH moving a rack must never change its bays or positions).
export const zUpdateZone = z.object({
  code: zCode.max(20).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  zone_type: z.enum(ZONE_TYPES).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  x_m: z.number().min(0).max(10000).optional(),
  y_m: z.number().min(0).max(10000).optional(),
  width_m: z.number().positive().max(10000).optional(),
  depth_m: z.number().positive().max(10000).optional(),
  is_active: z.boolean().optional(),
});

export const zCreateAisle = z.object({ zone_id: zUuid, code: zCode.max(20), name: z.string().trim().max(120).optional() });

export const zCreateRack = z.object({
  aisle_id: zUuid,
  code: zCode.max(20),
  bays: z.number().int().min(1).max(200),
  levels: z.number().int().min(1).max(30),
  positions_per_bay: z.number().int().min(1).max(10).default(1),
  bay_width_m: z.number().positive().max(20).default(2.7),
  level_height_m: z.number().positive().max(10).default(1.8),
  depth_m: z.number().positive().max(10).default(1.2),
  x_m: z.number().min(0).max(10000).default(0),
  y_m: z.number().min(0).max(10000).default(0),
  rotation_deg: z.number().int().min(0).max(359).default(0),
  location_type: z.enum(['RESERVE', 'PICKING']).default('RESERVE'),
  pallet_capacity: z.number().int().min(1).max(10).default(1),
  max_weight_kg: z.number().positive().max(100000).default(1500),
  /** generate locations for every bay/level/position */
  generate_locations: z.boolean().default(true),
});
export const zUpdateRack = z.object({
  code: zCode.max(20).optional(),
  bays: z.number().int().min(1).max(200).optional(),
  levels: z.number().int().min(1).max(30).optional(),
  positions_per_bay: z.number().int().min(1).max(10).optional(),
  bay_width_m: z.number().positive().max(20).optional(),
  level_height_m: z.number().positive().max(10).optional(),
  depth_m: z.number().positive().max(10).optional(),
  x_m: z.number().min(0).max(10000).optional(),
  y_m: z.number().min(0).max(10000).optional(),
  rotation_deg: z.number().int().min(0).max(359).optional(),
  is_active: z.boolean().optional(),
});

export const zCreateAreaLocation = z.object({
  warehouse_id: zUuid,
  zone_id: zUuid.optional(),
  code: zCode.max(40),
  location_type: z.enum(LOCATION_TYPES),
  x_m: z.number().min(0).max(10000).default(0),
  y_m: z.number().min(0).max(10000).default(0),
  width_m: z.number().positive().max(100).default(1.2),
  depth_m: z.number().positive().max(100).default(1.2),
  height_m: z.number().positive().max(30).default(1.8),
  pallet_capacity: z.number().int().min(1).max(500).default(1),
  max_weight_kg: z.number().positive().max(1000000).default(1500),
});
export const zUpdateLocation = z.object({
  admin_status: z.enum(LOCATION_ADMIN_STATUSES).optional(),
  block_reason: z.string().trim().max(300).optional(),
  pallet_capacity: z.number().int().min(1).max(500).optional(),
  max_weight_kg: z.number().positive().max(1000000).optional(),
  height_m: z.number().positive().max(30).optional(),
  restrictions: z
    .object({
      allowed_families: z.array(z.string().max(60)).optional(),
      allowed_compatibility_groups: z.array(z.string().max(60)).optional(),
      max_height_cm: z.number().positive().optional(),
    })
    .optional(),
  pick_sequence: z.number().int().min(0).optional(),
  x_m: z.number().min(0).max(10000).optional(),
  y_m: z.number().min(0).max(10000).optional(),
  z_m: z.number().min(0).max(100).optional(),
  is_active: z.boolean().optional(),
  reason: zReason.optional(),
});

// ---- inbound ----
export const zCreateContainer = z.object({
  container_number: zCode.max(40),
  supplier_id: zUuid.optional(),
  po_id: zUuid.optional(),
  carrier_id: zUuid.optional(),
  bl_number: z.string().trim().max(80).optional(),
  seal_number: z.string().trim().max(80).optional(),
  plates: z.string().trim().max(40).optional(),
  driver_name: z.string().trim().max(120).optional(),
  scheduled_at: z.coerce.date().optional(),
  dock_location_id: zUuid.optional(),
  notes: zNote,
});
export const zContainerTransition = z.object({
  status: z.enum(CONTAINER_STATUSES),
  version: z.number().int().positive(),
  notes: zNote,
  seal_number: z.string().trim().max(80).optional(),
  plates: z.string().trim().max(40).optional(),
  driver_name: z.string().trim().max(120).optional(),
});

export const zCreateReceipt = z.object({
  container_id: zUuid.optional(),
  po_id: zUuid.optional(),
  receiving_location_id: zUuid,
  notes: zNote,
  /** expected lines when no PO: [{ sku_code, qty, uom_code }] */
  expected: z.array(z.object({ sku_code: zCode, qty: zQty, uom_code: zUom.default('CASE') })).optional(),
});

// One physical pallet built during receiving: scanned barcode + counted qty.
export const zReceiveScan = z.object({
  receipt_id: zUuid,
  barcode: zBarcode, // SKU barcode (any packaging level)
  qty: zQty, // in the UoM of the barcode
  uom_code: zUom.optional(), // override the barcode's UoM
  /** add to an existing open LPN of this receipt (mixed pallet) or create a new one */
  lpn_code: z.string().trim().max(30).optional(),
  cases_count: z.number().int().min(0).max(100000).optional(),
  weight_kg: z.number().nonnegative().max(100000).optional(),
  lot: z.string().trim().max(60).optional(),
  /** ISO date YYYY-MM-DD — sent as text end to end to avoid timezone shifts */
  expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').optional(),
  damaged: z.boolean().default(false),
  note: zNote,
});

export const zCloseReceipt = z.object({
  receipt_id: zUuid,
  /** accept shortages/overages (incidents are still created) */
  accept_differences: z.boolean().default(false),
  notes: zNote,
});

// ---- put-away / transfers ----
export const zPutawayScanLpn = z.object({ lpn_code: z.string().trim().min(1).max(30) });
export const zPutawayConfirm = z.object({
  task_id: zUuid,
  lpn_code: z.string().trim().min(1).max(30),
  location_barcode: zBarcode,
  /** supervisor override: allow a different location with reason */
  override_reason: zReason.optional(),
  authorization_id: zUuid.optional(),
});
export const zTransferStart = z.object({
  lpn_code: z.string().trim().min(1).max(30),
  to_location_barcode: zBarcode,
  reason: z.string().trim().max(300).optional(),
});
export const zTransferComplete = z.object({
  transfer_id: zUuid,
  lpn_code: z.string().trim().min(1).max(30),
  location_barcode: zBarcode,
});

// ---- inventory adjustments / quarantine ----
export const zAdjustInventory = z.object({
  lpn_code: z.string().trim().min(1).max(30),
  sku_code: zCode,
  direction: z.enum(['IN', 'OUT']),
  qty: zQty,
  uom_code: zUom.default('PIECE'),
  reason: zReason,
  incident_id: zUuid.optional(),
  authorization_id: zUuid.optional(),
});
export const zStatusChange = z.object({
  lpn_code: z.string().trim().min(1).max(30),
  sku_code: zCode.optional(), // omitted => whole LPN
  action: z.enum(['QUARANTINE', 'RELEASE_QUARANTINE', 'BLOCK', 'UNBLOCK', 'DAMAGE', 'RELEASE_DAMAGE']),
  qty: zQty.optional(), // omitted => all
  reason_code: z.string().trim().max(40).optional(),
  reason: zReason,
});

// ---- replenishment ----
export const zReplenRule = z.object({
  sku_code: zCode,
  pick_location_barcode: zBarcode,
  min_qty: zQtyOrZero,
  max_qty: zQty,
});

// ---- counts ----
export const zCreateCount = z.object({
  count_type: z.enum(COUNT_TYPES),
  location_barcodes: z.array(zBarcode).max(500).optional(),
  sku_codes: z.array(zCode).max(500).optional(),
  zone_id: zUuid.optional(),
  abc_class: z.enum(['A', 'B', 'C']).optional(),
  random_sample: z.number().int().min(1).max(500).optional(),
  incident_id: zUuid.optional(),
  scheduled_for: z.coerce.date().optional(),
  assigned_to: zUuid.optional(),
  is_blind: z.boolean().default(true),
  notes: zNote,
});
export const zSubmitCount = z.object({
  count_task_id: zUuid,
  location_barcode: zBarcode,
  lpn_code: z.string().trim().max(30).optional(),
  barcode: zBarcode,
  qty: zQtyOrZero,
  uom_code: zUom.optional(),
});
export const zApproveCount = z.object({
  count_task_id: zUuid,
  decision: z.enum(['APPROVE', 'REJECT']),
  reason: zReason,
});

// ---- orders ----
export const zOrderLineInput = z.object({
  sku_code: zCode,
  qty: zQty,
  uom_code: zUom.default('PIECE'),
});
export const zCreateOrder = z.object({
  order_number: zCode.max(60),
  customer_code: zCode,
  destination: z.string().trim().max(500).optional(),
  order_date: z.coerce.date().optional(),
  priority: z.number().int().min(1).max(9).default(5),
  external_ref: z.string().trim().max(80).optional(),
  notes: zNote,
  lines: z.array(zOrderLineInput).min(1).max(1000),
});
export const zAllocateOrder = z.object({
  order_id: zUuid,
  strategy: z.enum(ALLOCATION_STRATEGIES).optional(),
  allow_partial: z.boolean().default(false),
});
export const zCancelOrder = z.object({ order_id: zUuid, reason: zReason });

// ---- picking ----
export const zPickScan = z
  .object({
    pick_task_id: zUuid,
    line_id: zUuid,
    step: z.enum(['LOCATION', 'LPN', 'QTY']),
    scanned: z.string().trim().min(1).max(64).optional(),
    qty: zQty.optional(),
    uom_code: zUom.optional(),
  })
  .refine((v) => v.step !== 'QTY' || (v.qty !== undefined && v.uom_code !== undefined), { message: 'qty and uom_code are required for the QTY step', path: ['uom_code'] })
  .refine((v) => v.step === 'QTY' || (v.scanned !== undefined && v.scanned.length > 0), { message: 'scanned is required', path: ['scanned'] });
export const zPickShort = z.object({ pick_task_id: zUuid, line_id: zUuid, reason: zReason });
export const zStageLpn = z.object({
  lpn_code: z.string().trim().min(1).max(30),
  staging_location_barcode: zBarcode,
});

// ---- verification ----
export const zStartVerification = z.object({ order_id: zUuid, authorization_id: zUuid.optional() });
export const zVerifyScan = z.object({
  verification_id: zUuid,
  lpn_code: z.string().trim().min(1).max(30),
  barcode: zBarcode,
  qty: zQty,
  uom_code: zUom.optional(),
});
export const zCompleteVerification = z.object({ verification_id: zUuid });

// ---- shipments / loading ----
export const zCreateShipment = z.object({
  carrier_id: zUuid.optional(),
  vehicle: z.string().trim().max(80).optional(),
  plates: z.string().trim().max(40).optional(),
  driver_name: z.string().trim().max(120).optional(),
  destination: z.string().trim().max(500).optional(),
  dock_location_id: zUuid.optional(),
  order_ids: z.array(zUuid).max(200).default([]),
  notes: zNote,
});
export const zLoadScan = z.object({
  shipment_id: zUuid,
  lpn_code: z.string().trim().min(1).max(30),
  dock_location_barcode: zBarcode.optional(),
});
export const zReleaseShipment = z.object({ shipment_id: zUuid, version: z.number().int().positive() });

// ---- incidents ----
export const zCreateIncident = z.object({
  incident_type: z.enum(INCIDENT_TYPES),
  severity: z.enum(INCIDENT_SEVERITIES).default('MEDIUM'),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(5000).optional(),
  entity_type: z.string().trim().max(40).optional(),
  entity_id: z.string().trim().max(64).optional(),
  sku_code: zCode.optional(),
  lpn_code: z.string().trim().max(30).optional(),
  location_barcode: zBarcode.optional(),
  order_id: zUuid.optional(),
  shipment_id: zUuid.optional(),
  receipt_id: zUuid.optional(),
  qty: zQty.optional(),
  assigned_to: zUuid.optional(),
});
export const zResolveIncident = z.object({
  status: z.enum(['IN_REVIEW', 'RESOLVED', 'CLOSED', 'REJECTED']),
  resolution: z.string().trim().max(5000).optional(),
  comment: z.string().trim().max(5000).optional(),
});

// ---- returns ----
export const zCreateReturn = z.object({
  customer_code: zCode,
  original_order_number: z.string().trim().max(60).optional(),
  reason: z.string().trim().max(500).optional(),
  lines: z.array(z.object({ sku_code: zCode, qty: zQty, uom_code: zUom.default('PIECE') })).min(1),
});
export const zReceiveReturnLine = z.object({
  return_id: zUuid,
  line_id: zUuid,
  qty: zQty,
  uom_code: zUom,
  returns_location_barcode: zBarcode,
});
export const zClassifyReturnLine = z.object({
  return_id: zUuid,
  line_id: zUuid,
  disposition: z.enum(RETURN_DISPOSITIONS),
  qty: zQty,
  reason: zReason,
});

// ---- labels ----
export const zPrintLabel = z.object({
  label_type: z.enum(LABEL_TYPES),
  entity_id: z.string().trim().min(1).max(64),
  printer_id: zUuid.optional(),
  copies: z.number().int().min(1).max(10).default(1),
  reprint_reason: zReason.optional(),
});

// ---- authorizations ----
export const zAuthorize = z.object({
  exception_type: z.enum(EXCEPTION_TYPES),
  entity_type: z.string().trim().min(1).max(60),
  entity_id: z.string().trim().min(1).max(64),
  requested_by: zUuid.optional(),
  reason: zReason,
});

// ---- settings ----
export const zSettings = z.object({
  allocation_strategy: z.enum(ALLOCATION_STRATEGIES).optional(),
  session_ttl_hours: z.number().int().min(1).max(72).optional(),
  require_mfa_for_admin: z.boolean().optional(),
  auto_print_lpn_labels: z.boolean().optional(),
});

export type LoginInput = z.infer<typeof zLogin>;
export type CreateSkuInput = z.infer<typeof zCreateSku>;
export type ReceiveScanInput = z.infer<typeof zReceiveScan>;
export type CreateOrderInput = z.infer<typeof zCreateOrder>;
