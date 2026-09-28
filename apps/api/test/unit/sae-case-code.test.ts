// DUN-14 case codes (17500462716933) identify the same product as their GTIN-13 (7500462716936): one product, case barcode kept.
import { describe, expect, it } from 'vitest';
import { gtin13FromCase, groupProducts } from '../../src/modules/sae/sync.js';

const art = (cve_art: string, descr = 'SARTEN') => ({ cve_art, descr, lin_prod: 'SART', uni_med: 'PZA', uni_emp: 12, fac_conv: 1, peso: 1, con_lote: 'N', status: 'A' });
const counters = () => ({ source_rows: 0, errors: [] as { ref: string; message: string }[], err(ref: string, message: string) { this.errors.push({ ref, message }); } });

describe('gtin13FromCase', () => {
  it('drops the indicator digit and recomputes the check digit', () => {
    expect(gtin13FromCase('17500462716933')).toBe('7500462716936');
    expect(gtin13FromCase('17500462717121')).toBe('7500462717124'); // the case code carries the 12 digits + its own check digit
    expect(gtin13FromCase('7500462716936')).toBeNull();
    expect(gtin13FromCase('07500462716936')).toBeNull(); // indicator 0 is a padded GTIN-13, not a case
  });
});

describe('groupProducts with case codes', () => {
  it('a key whose only barcode is the case code joins the product of the GTIN-13 and keeps the case barcode', () => {
    const c = counters() as never;
    const products = groupProducts(
      [art('SCMB20R'), art('SCMB20R-PINK-1')],
      [{ cve_art: 'SCMB20R', modelo: 'SCMB20R', capa: 'BASE' }, { cve_art: 'SCMB20R-PINK-1', modelo: 'SCMB20R', capa: 'PIEZA' }],
      [{ sku_interno: 'SCMB20R', gtin: '7500462716936', activo: true }, { sku_interno: 'SCMB20R-PINK-1', gtin: '17500462716933', activo: true }],
      [],
      c,
    );
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ code: 'SCMB20R', gtin: '7500462716936', caseGtins: ['17500462716933'] });
    expect(products[0]!.keys.map((k) => k.key).sort()).toEqual(['SCMB20R', 'SCMB20R-PINK-1']);
  });
  it('a product known only by its case code gets the GTIN-13 as identity', () => {
    const c = counters() as never;
    const products = groupProducts([art('PEL055R'), art('677069')], [{ cve_art: '677069', modelo: 'PEL055R', capa: 'BASE' }, { cve_art: 'PEL055R', modelo: 'PEL055R', capa: 'BASE' }], [{ sku_interno: '677069', gtin: '17500462717121', activo: true }, { sku_interno: 'PEL055R', gtin: '17500462717121', activo: true }], [], c);
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ gtin: '7500462717124', caseGtins: ['17500462717121'] });
  });
});
