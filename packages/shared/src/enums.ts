// Shared enumerations. These are the single source of truth for status values
// used by the API (validation + DB CHECK constraints) and the web client.

export const ROLES = [
  'ADMIN',
  'SUPERVISOR',
  'RECEIVING',
  'FORKLIFT',
  'PICKER',
  'VERIFIER',
  'LOADER',
  'INVENTORY_CONTROL',
] as const;
export type Role = (typeof ROLES)[number];

export const UOM_CODES = ['PALLET', 'CASE', 'INNER', 'PIECE'] as const;
export type UomCode = (typeof UOM_CODES)[number];

export const INVENTORY_STATUSES = [
  'AVAILABLE',
  'ALLOCATED',
  'PICKING',
  'STAGING',
  'LOADED',
  'QUARANTINE',
  'DAMAGED',
  'BLOCKED',
  'IN_TRANSFER',
] as const;
export type InventoryStatus = (typeof INVENTORY_STATUSES)[number];

/** Statuses from which inventory may be reserved, picked or loaded. */
export const RESERVABLE_STATUSES: readonly InventoryStatus[] = ['AVAILABLE'];

/** Statuses that must never be reserved, picked or loaded. */
export const LOCKED_STATUSES: readonly InventoryStatus[] = ['QUARANTINE', 'DAMAGED', 'BLOCKED'];

export const MOVEMENT_TYPES = [
  'RECEIPT',
  'PUTAWAY',
  'TRANSFER_START',
  'TRANSFER_COMPLETE',
  'TRANSFER_CANCEL',
  'REPLENISH_START',
  'REPLENISH_COMPLETE',
  'ALLOCATE',
  'DEALLOCATE',
  'PICK',
  'UNPICK',
  'STAGE',
  'LOAD',
  'UNLOAD',
  'SHIP',
  'ADJUST_IN',
  'ADJUST_OUT',
  'COUNT_ADJUST_IN',
  'COUNT_ADJUST_OUT',
  'QUARANTINE_IN',
  'QUARANTINE_OUT',
  'DAMAGE',
  'DAMAGE_RELEASE',
  'BLOCK',
  'UNBLOCK',
  'RETURN_RECEIPT',
  'SCRAP',
  'LPN_SPLIT',
  'LPN_CONSOLIDATE',
  'INITIAL_LOAD',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

/** Movements that create inventory (from = nothing). */
export const INBOUND_MOVEMENTS: readonly MovementType[] = [
  'RECEIPT',
  'ADJUST_IN',
  'COUNT_ADJUST_IN',
  'RETURN_RECEIPT',
  'INITIAL_LOAD',
];
/** Movements that remove inventory (to = nothing). */
export const OUTBOUND_MOVEMENTS: readonly MovementType[] = [
  'SHIP',
  'ADJUST_OUT',
  'COUNT_ADJUST_OUT',
  'SCRAP',
];

export const LOCATION_TYPES = [
  'RESERVE',
  'PICKING',
  'RECEIVING',
  'STAGING',
  'SHIPPING',
  'QUARANTINE',
  'RETURNS',
  'DAMAGED',
] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export const LOCATION_ADMIN_STATUSES = ['ACTIVE', 'BLOCKED', 'QUARANTINE'] as const;
export type LocationAdminStatus = (typeof LOCATION_ADMIN_STATUSES)[number];

/** Derived occupancy status shown in UI and 3D map. */
export const LOCATION_STATUSES = ['FREE', 'PARTIAL', 'OCCUPIED', 'RESERVED', 'BLOCKED', 'QUARANTINE'] as const;
export type LocationStatus = (typeof LOCATION_STATUSES)[number];

export const ZONE_TYPES = [
  'STORAGE',
  'PICKING',
  'RECEIVING',
  'STAGING',
  'SHIPPING',
  'QUARANTINE',
  'RETURNS',
  'DAMAGED',
] as const;
export type ZoneType = (typeof ZONE_TYPES)[number];

export const CONTAINER_STATUSES = [
  'SCHEDULED',
  'ARRIVED',
  'UNLOADING',
  'UNLOADED',
  'RECEIVING',
  'RECEIVED',
  'CLOSED',
  'WITH_INCIDENT',
] as const;
export type ContainerStatus = (typeof CONTAINER_STATUSES)[number];

export const CONTAINER_TRANSITIONS: Record<ContainerStatus, readonly ContainerStatus[]> = {
  SCHEDULED: ['ARRIVED', 'WITH_INCIDENT'],
  ARRIVED: ['UNLOADING', 'WITH_INCIDENT'],
  UNLOADING: ['UNLOADED', 'WITH_INCIDENT'],
  UNLOADED: ['RECEIVING', 'WITH_INCIDENT'],
  RECEIVING: ['RECEIVED', 'WITH_INCIDENT'],
  RECEIVED: ['CLOSED', 'WITH_INCIDENT'],
  CLOSED: [],
  WITH_INCIDENT: ['ARRIVED', 'UNLOADING', 'UNLOADED', 'RECEIVING', 'RECEIVED', 'CLOSED'],
};

export const RECEIPT_STATUSES = ['OPEN', 'IN_PROGRESS', 'COMPLETED', 'CLOSED', 'WITH_INCIDENT'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

export const LPN_TYPES = ['INBOUND', 'STORAGE', 'OUTBOUND', 'RETURN'] as const;
export type LpnType = (typeof LPN_TYPES)[number];

export const LPN_STATUSES = [
  'OPEN',
  'STORED',
  'IN_TRANSFER',
  'PICKING',
  'STAGED',
  'LOADED',
  'SHIPPED',
  'CONSUMED',
  'CANCELLED',
] as const;
export type LpnStatus = (typeof LPN_STATUSES)[number];

export const ORDER_STATUSES = [
  'IMPORTED',
  'ACCEPTED',
  'PARTIALLY_ALLOCATED',
  'ALLOCATED',
  'PICKING',
  'PICKED',
  'STAGED',
  'VERIFIED',
  'LOADING',
  'LOADED',
  'SHIPPED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ALLOCATION_STRATEGIES = ['FIFO', 'FEFO', 'LPN', 'LOCATION', 'FULL_PALLET', 'CASE_PIECE'] as const;
export type AllocationStrategy = (typeof ALLOCATION_STRATEGIES)[number];

export const SHIPMENT_STATUSES = [
  'OPEN',
  'LOADING',
  'LOADED',
  'RELEASED',
  'DEPARTED',
  'CANCELLED',
  'BLOCKED',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

export const INCIDENT_TYPES = [
  'SHORTAGE',
  'OVERAGE',
  'WRONG_SKU',
  'DAMAGED',
  'INVENTORY_DIFFERENCE',
  'WRONG_LOCATION',
  'LABEL_ERROR',
  'LOST_PALLET',
  'PICKING_ERROR',
  'LOADING_ERROR',
  'OTHER',
] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];

export const INCIDENT_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_STATUSES = ['OPEN', 'IN_REVIEW', 'RESOLVED', 'CLOSED', 'REJECTED'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const COUNT_TYPES = ['LOCATION', 'SKU', 'ZONE', 'ABC', 'RANDOM', 'INCIDENT', 'SCHEDULED'] as const;
export type CountType = (typeof COUNT_TYPES)[number];

export const LABEL_TYPES = ['LPN', 'LOCATION', 'CASE', 'ORDER', 'STAGING', 'SHIPMENT'] as const;
export type LabelType = (typeof LABEL_TYPES)[number];

export const IMPORT_TYPES = [
  'SKUS',
  'BARCODES',
  'CUSTOMERS',
  'SUPPLIERS',
  'LOCATIONS',
  'RACKS',
  'INITIAL_INVENTORY',
  'ORDERS',
  'PURCHASE_ORDERS',
] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];

export const RETURN_DISPOSITIONS = ['RESTOCK', 'QUARANTINE', 'DAMAGED', 'SCRAP'] as const;
export type ReturnDisposition = (typeof RETURN_DISPOSITIONS)[number];

export const EXCEPTION_TYPES = [
  'PUTAWAY_LOCATION_OVERRIDE',
  'SAME_USER_VERIFICATION',
  'NEGATIVE_INVENTORY',
  'FORCE_RELEASE_NOT_ALLOWED', // exists only so it can be rejected explicitly
  'COUNT_ADJUSTMENT',
  'REPRINT_LABEL',
  'ORDER_CANCEL_DURING_PICKING',
] as const;
export type ExceptionType = (typeof EXCEPTION_TYPES)[number];
