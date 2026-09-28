import { describe, expect, it } from 'vitest';
import { productColor, PRODUCT_DEFAULT_COLOR } from './colors.js';

describe('productColor', () => {
  it('explicit hex wins', () => expect(productColor('X', 'ROSA', '#123ABC')).toBe('#123abc'));
  it('reads the colour word in the description', () => {
    expect(productColor('CAPM75N', 'CAJA ORGANIZADORA 75L ROSA')).toBe('#ec4899');
    expect(productColor('X', 'SARTEN IMPERIAL GRIS 20CM')).toBe('#9ca3af');
    expect(productColor('X', 'Contenedor azul marino')).toBe('#2563eb');
  });
  it('falls back to the colour letter of the Red Stone code', () => {
    expect(productColor('SIC20G', 'SARTEN 20 CM')).toBe('#9ca3af');
    expect(productColor('SCMB24L-PURPLE-1', 'SARTEN CERAMICA B 24CM')).toBe('#8b5cf6');
    expect(productColor('SM20R', 'SARTEN')).toBe('#ec4899');
  });
  it('neutral when nothing says the colour', () => expect(productColor('464248', 'CONTENEDOR DE VIDRIO 1040 ML')).toBe('#bae6fd') && expect(productColor('TORNILLOS', 'TORNILLOS')).toBe(PRODUCT_DEFAULT_COLOR));
});
