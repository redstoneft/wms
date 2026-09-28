// Product colour used by the 3D map: an explicit hex on the SKU wins; otherwise it is read from the description
// (ROSA, AZUL, NEGRO…) or from the colour letter that Red Stone codes carry after the size (SIC20G → G = gris).
const WORDS: [RegExp, string][] = [
  [/\b(ROSA|PINK|FUCSIA)\b/, '#ec4899'],
  [/\b(AZUL|BLUE|MARINO|NAVY)\b/, '#2563eb'],
  [/\b(NEGRO|NEGRA|BLACK)\b/, '#1f2937'],
  [/\b(GRIS|GREY|GRAY|PLATA|SILVER)\b/, '#9ca3af'],
  [/\b(LILA|MORADO|PURPLE|VIOLETA|LAVANDA)\b/, '#8b5cf6'],
  [/\b(MENTA|VERDE|GREEN|MINT|OLIVO)\b/, '#10b981'],
  [/\b(BLANCO|BLANCA|WHITE|HUESO|CREMA|BEIGE)\b/, '#f1f5f9'],
  [/\b(ROJO|ROJA|RED|VINO|TINTO)\b/, '#dc2626'],
  [/\b(DORADO|DORADA|GOLD|ORO)\b/, '#eab308'],
  [/\b(CAFE|CAFÉ|BROWN|CHOCOLATE|MADERA)\b/, '#92400e'],
  [/\b(AMARILLO|AMARILLA|YELLOW)\b/, '#facc15'],
  [/\b(NARANJA|ORANGE|TERRACOTA)\b/, '#f97316'],
  [/\b(TURQUESA|AQUA|CIAN|CYAN|TEAL)\b/, '#06b6d4'],
  [/\b(TRANSPARENTE|CRISTAL|CLARO|CLEAR|VIDRIO)\b/, '#bae6fd'],
  [/\b(ACERO|INOX|INOXIDABLE|STEEL)\b/, '#cbd5e1'],
];
const LETTERS: Record<string, string> = { A: '#2563eb', R: '#ec4899', N: '#1f2937', G: '#9ca3af', L: '#8b5cf6', V: '#10b981', B: '#f1f5f9', M: '#10b981', P: '#ec4899', T: '#06b6d4' };
/** Neutral cardboard when nothing says otherwise. */
export const PRODUCT_DEFAULT_COLOR = '#c8a97e';

export function productColor(code: string, description: string | null | undefined, explicit?: string | null): string {
  if (explicit && /^#[0-9a-fA-F]{6}$/.test(explicit)) return explicit.toLowerCase();
  const d = (description ?? '').toUpperCase();
  for (const [re, hex] of WORDS) if (re.test(d)) return hex;
  // Red Stone code: letters + size + colour letter(s), e.g. SIC20G, SCMB24L, SM20R, PTED27A, CAPM75N
  const m = /^[A-Z]+\d{2,3}([A-Z])(?:[A-Z]?)(?:[-.]|$)/.exec(code.toUpperCase());
  if (m && LETTERS[m[1]!]) return LETTERS[m[1]!]!;
  return PRODUCT_DEFAULT_COLOR;
}
