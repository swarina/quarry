/**
 * Deterministic JSON serialization for content hashes and cache keys.
 *
 * Semantically equal values always produce identical output:
 * - object keys are sorted by UTF-16 code unit order (the ordering RFC 8785 uses),
 * - strings and keys are normalized to Unicode NFC, so visually identical text hashes equally,
 * - numbers use the shortest round-trip form (`JSON.stringify`, which RFC 8785 also adopts),
 * - no insignificant whitespace is emitted.
 *
 * Values that JSON cannot represent faithfully are rejected rather than silently coerced:
 * non-finite numbers, bigints, functions, symbols, `undefined` array elements (including
 * holes), non-plain objects such as `Date` or `Map`, and circular references. Object
 * properties whose value is `undefined` are omitted, as `JSON.stringify` does.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, "$", new Set());
}

export class CanonicalJsonError extends Error {
  override readonly name = "CanonicalJsonError";
  /** JSONPath-like location of the offending value, for example `$.items[2]`. */
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} at ${path}`);
    this.path = path;
  }
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value.normalize("NFC"));
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError("Non-finite number", path);
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "object":
      return value === null ? "null" : serializeObject(value, path, ancestors);
    default:
      throw new CanonicalJsonError(`Unsupported value of type ${typeof value}`, path);
  }
}

function serializeObject(value: object, path: string, ancestors: Set<object>): string {
  if (ancestors.has(value)) throw new CanonicalJsonError("Circular reference", path);
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? serializeArray(value, path, ancestors)
      : serializePlainObject(value, path, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function serializeArray(items: readonly unknown[], path: string, ancestors: Set<object>): string {
  const parts: string[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const itemPath = `${path}[${index}]`;
    const item = items[index];
    if (item === undefined) throw new CanonicalJsonError("Undefined array element", itemPath);
    parts.push(serialize(item, itemPath, ancestors));
  }
  return `[${parts.join(",")}]`;
}

function serializePlainObject(value: object, path: string, ancestors: Set<object>): string {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalJsonError("Unsupported non-plain object", path);
  }

  const members: Array<readonly [key: string, json: string]> = [];
  const keys = new Set<string>();
  for (const [rawKey, member] of Object.entries(value)) {
    if (member === undefined) continue;
    const key = rawKey.normalize("NFC");
    if (keys.has(key)) {
      throw new CanonicalJsonError(`Keys collide after NFC normalization (${key})`, path);
    }
    keys.add(key);
    members.push([key, serialize(member, `${path}.${key}`, ancestors)]);
  }

  members.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${members.map(([key, json]) => `${JSON.stringify(key)}:${json}`).join(",")}}`;
}
