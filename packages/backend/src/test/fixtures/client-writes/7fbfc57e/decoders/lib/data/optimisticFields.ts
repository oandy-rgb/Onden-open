// @ts-nocheck
// Snapshot of src/lib/data/optimisticFields.ts as released (npm run capture:client-writes); not type-checked here.
/** Pending edits retain their last accepted predecessor. If A and B both fail,
 * B restores the original value, not the rejected value from A. The journal is
 * shared across writer instances and tracks fields independently. */
type Entry = { before: unknown; value: unknown };
const resources = new Map<string, Map<PropertyKey, Entry[]>>();

export function optimisticFields<T extends object>(resource: string, before: T, changes: Partial<T>) {
  const fields = resources.get(resource) ?? new Map<PropertyKey, Entry[]>();
  resources.set(resource, fields);
  const edits = new Map<keyof T, Entry>();
  for (const key of Object.keys(changes) as (keyof T)[]) {
    const entry = { before: before[key], value: changes[key] };
    const queue = fields.get(key) ?? [];
    queue.push(entry);
    fields.set(key, queue);
    edits.set(key, entry);
  }
  let settled = false;
  return function settle(accepted: boolean, server: Partial<T> = {}) {
    const expected: Partial<T> = {};
    const replacement: Partial<T> = {};
    if (settled) return { expected, replacement };
    settled = true;
    for (const [key, entry] of edits) {
      const queue = fields.get(key)!;
      const index = queue.indexOf(entry);
      const value = accepted ? (Object.hasOwn(server, key) ? server[key] : entry.value) : entry.before;
      if (index === queue.length - 1) {
        expected[key] = entry.value as T[keyof T];
        replacement[key] = value as T[keyof T];
      } else {
        queue[index + 1]!.before = value;
      }
      queue.splice(index, 1);
      if (!queue.length) fields.delete(key);
    }
    if (!fields.size) resources.delete(resource);
    return { expected, replacement };
  };
}

/** The fields of `resource` with an edit still waiting for its answer. */
export function pendingFields(resource: string): Set<PropertyKey> {
  return new Set(resources.get(resource)?.keys() ?? []);
}
