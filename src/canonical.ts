/** Runtime identity for structurally identical canonical types (e.g. Part and Delta).
 * Kept outside the values: no extra JSON keys, symbols, or retained objects.
 */
const kinds = new WeakMap<object, string>();

export function canonicalValue<T extends object>(kind: string, value: T): T {
  kinds.set(value, kind);
  return value;
}

export function canonicalFactory<A extends unknown[], T extends object>(kind: string, factory: (...args: A) => T): (...args: A) => T {
  return (...args) => canonicalValue(kind, factory(...args));
}

export function canonicalKind(value: object): string | undefined {
  return kinds.get(value);
}
