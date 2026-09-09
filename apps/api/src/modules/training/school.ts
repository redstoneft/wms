// "Almacén escuela": an isolated warehouse where trainees practise every floor operation with real screens and
// real ledger movements, without touching production stock. Created idempotently on first use.
import type { Tx } from '../../db.js';
import { syncRackLocations } from '../layout/service.js';

export const SCHOOL = {
  warehouse: { code: 'ESCUELA', name: 'Almacén escuela (capacitación)' },
  dock: 'ESC-DOCK-01',
  staging: 'ESC-STG-01',
  station: 'ESC-ARM-01',
  ship: 'ESC-SHIP-01',
  customer: 'CAP-CLIENTE',
  supplier: 'CAP-PROVEEDOR',
  carrier: 'CAP-TRANSPORTE',
  skus: [
    { code: 'CAP-001', description: 'Sartén escuela 20 cm (práctica)', piece: 'CAP001', case: 'CAP001C', case_qty: 6n },
    { code: 'CAP-002', description: 'Olla escuela 4 L (práctica)', piece: 'CAP002', case: 'CAP002C', case_qty: 4n },
    { code: 'CAP-003', description: 'Cuerpo de sartén escuela (práctica)', piece: 'CAP003', case: 'CAP003C', case_qty: 12n },
  ],
} as const;

export interface School {
  warehouse_id: string;
  dock: { id: string; code: string; barcode: string };
  staging: { id: string; code: string; barcode: string };
  station: { id: string; code: string; barcode: string };
  ship: { id: string; code: string; barcode: string };
  reserve: { id: string; code: string; barcode: string }[];
  picking: { id: string; code: string; barcode: string }[];
  skus: { id: string; code: string; piece: string; case: string; case_qty: bigint }[];
  customer: { id: string; code: string };
  supplier: { id: string; code: string };
  carrier: { id: string; code: string };
}

export async function ensureSchool(tx: Tx): Promise<School> {
  let wh = await tx.warehouses.findUnique({ where: { code: SCHOOL.warehouse.code } });
  if (!wh) wh = await tx.warehouses.create({ data: { code: SCHOOL.warehouse.code, name: SCHOOL.warehouse.name, is_default: false } });
  const zone = async (code: string, name: string, zone_type: string, x: number, y: number, w: number, d: number) => {
    const found = await tx.zones.findFirst({ where: { warehouse_id: wh!.id, code } });
    return found ?? tx.zones.create({ data: { warehouse_id: wh!.id, code, name, zone_type, x_m: x, y_m: y, width_m: w, depth_m: d, color: '#6b7280' } });
  };
  const zREC = await zone('ESC-REC', 'Escuela · recibo', 'RECEIVING', 0, 0, 8, 4);
  const zSTG = await zone('ESC-STG', 'Escuela · staging', 'STAGING', 8, 0, 6, 4);
  const zSHP = await zone('ESC-SHP', 'Escuela · embarque', 'SHIPPING', 14, 0, 6, 4);
  const zALM = await zone('ESC-ALM', 'Escuela · almacén', 'STORAGE', 0, 6, 20, 8);
  const zPCK = await zone('ESC-PCK', 'Escuela · picking', 'PICKING', 0, 16, 20, 4);
  const zARM = await zone('ESC-ARM', 'Escuela · armado', 'STORAGE', 14, 6, 6, 4);
  const area = async (zoneId: string, code: string, type: string, x: number, y: number, cap: number) => {
    const found = await tx.locations.findFirst({ where: { warehouse_id: wh!.id, code } });
    const l = found ?? (await tx.locations.create({ data: { warehouse_id: wh!.id, zone_id: zoneId, code, barcode: `LOC-${code}`, location_type: type, x_m: x, y_m: y, width_m: 4, depth_m: 3, height_m: 3, pallet_capacity: cap, max_weight_kg: 50000 } }));
    return { id: l.id, code: l.code, barcode: l.barcode };
  };
  const dock = await area(zREC.id, SCHOOL.dock, 'RECEIVING', 1, 0.5, 20);
  const staging = await area(zSTG.id, SCHOOL.staging, 'STAGING', 9, 0.5, 10);
  await area(zSTG.id, 'ESC-STG-02', 'STAGING', 11, 0.5, 10);
  await area(zSTG.id, 'ESC-STG-03', 'STAGING', 13, 0.5, 10);
  const station = await area(zARM.id, SCHOOL.station, 'STAGING', 15, 6.5, 10);
  const ship = await area(zSHP.id, SCHOOL.ship, 'SHIPPING', 15, 0.5, 20);
  const rack = async (zoneId: string, aisleCode: string, type: string, bays: number, levels: number, x: number, y: number) => {
    let aisle = await tx.aisles.findFirst({ where: { zone_id: zoneId, code: aisleCode } });
    if (!aisle) aisle = await tx.aisles.create({ data: { zone_id: zoneId, code: aisleCode } });
    let r = await tx.racks.findFirst({ where: { aisle_id: aisle.id, code: 'R01' } });
    const geom = { bays, levels, positions_per_bay: 1, bay_width_m: 2.7, level_height_m: 1.8, depth_m: 1.2, x_m: x, y_m: y, rotation_deg: 0 };
    if (!r) {
      r = await tx.racks.create({ data: { aisle_id: aisle.id, code: 'R01', ...geom } });
      await syncRackLocations(tx, { ...r, ...geom }, { location_type: type, pallet_capacity: 1, max_weight_kg: 1500 });
    }
    return (await tx.locations.findMany({ where: { rack_id: r.id, is_active: true }, orderBy: { code: 'asc' } })).map((l) => ({ id: l.id, code: l.code, barcode: l.barcode }));
  };
  const reserve = await rack(zALM.id, 'A', 'RESERVE', 4, 2, 1, 7);
  const picking = await rack(zPCK.id, 'P', 'PICKING', 2, 1, 1, 17);
  const skus = [];
  for (const s of SCHOOL.skus) {
    let row = await tx.skus.findUnique({ where: { code: s.code } });
    if (!row) {
      row = await tx.skus.create({
        data: {
          code: s.code,
          description: s.description,
          family: 'CAPACITACION',
          abc_class: 'C',
          unit_weight_kg: 1,
          pallet_height_cm: 150,
          uoms: { create: [{ uom_code: 'PIECE', base_qty: 1n }, { uom_code: 'CASE', base_qty: s.case_qty }, { uom_code: 'PALLET', base_qty: s.case_qty * 20n }] },
          barcodes: { create: [{ barcode: s.piece, uom_code: 'PIECE' }, { barcode: s.case, uom_code: 'CASE' }] },
        },
      });
    }
    skus.push({ id: row.id, code: s.code, piece: s.piece, case: s.case, case_qty: s.case_qty });
  }
  const customer = (await tx.customers.findUnique({ where: { code: SCHOOL.customer } })) ?? (await tx.customers.create({ data: { code: SCHOOL.customer, name: 'Cliente de práctica (capacitación)' } }));
  const supplier = (await tx.suppliers.findUnique({ where: { code: SCHOOL.supplier } })) ?? (await tx.suppliers.create({ data: { code: SCHOOL.supplier, name: 'Proveedor de práctica (capacitación)' } }));
  const carrier = (await tx.carriers.findUnique({ where: { code: SCHOOL.carrier } })) ?? (await tx.carriers.create({ data: { code: SCHOOL.carrier, name: 'Transporte de práctica (capacitación)' } }));
  return { warehouse_id: wh.id, dock, staging, station, ship, reserve, picking, skus, customer: { id: customer.id, code: customer.code }, supplier: { id: supplier.id, code: supplier.code }, carrier: { id: carrier.id, code: carrier.code } };
}
