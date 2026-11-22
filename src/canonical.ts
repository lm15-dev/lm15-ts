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

/** O(1) pass-through for values already produced by this kind's normalizer; validates plain literals. */
export function ensureCanonical<T extends object>(kind: string, input: unknown, normalize: (v: unknown) => T): T {
  if (typeof input === "object" && input !== null && kinds.get(input) === kind) return input as T;
  return normalize(input);
}
