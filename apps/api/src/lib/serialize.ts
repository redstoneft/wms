/** JSON replacer that turns bigint into string and Prisma Decimal into number-string. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object' && 'toFixed' in (value as object) && typeof (value as { toFixed: unknown }).toFixed === 'function' && !(value instanceof Date)) {
    // Prisma Decimal
    return (value as { toString(): string }).toString();
  }
  return value;
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, jsonReplacer);
}

/** Deep-converts bigint→string so a value can be stored in a JSON column. */
export function plain<T>(value: T): T {
  return JSON.parse(toJson(value)) as T;
}
