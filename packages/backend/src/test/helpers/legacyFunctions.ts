// The pre-166 way to compute a tag's functions, kept ONLY as the oracle for the migration's
// equivalence tests: effectiveTagModules (breadth-first over tag_schema.extends, nearest provider wins)
// restricted to the non-view functions migration 166 turned into function references.

export type LegacyTagRow = { id: string; module: unknown; extends: unknown; behaviour: unknown };

const isUuidText = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const extendsOf = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter(isUuidText))] : [];

function provided(row: LegacyTagRow): string[] {
  const own = Object.keys(obj(obj(row.behaviour).modules)).filter((m) => obj(obj(obj(row.behaviour).modules)[m]).enabled === true);
  const module = typeof row.module === "string" && row.module.length > 0 && row.module.length <= 64 ? row.module : null;
  return module && !own.includes(module) ? [module, ...own] : own;
}

/** tag id → (function id → the tag its settings come from). */
export function legacyEffective(rows: LegacyTagRow[], skip: (functionId: string) => boolean = () => false): Map<string, Map<string, string>> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const result = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const found = new Map<string, string>();
    const seen = new Set([row.id]);
    for (let level = [row.id]; level.length;) {
      const next: string[] = [];
      for (const id of level) {
        const tag = byId.get(id);
        if (!tag) continue;
        for (const m of provided(tag)) if (!found.has(m) && !skip(m)) found.set(m, id);
        for (const parent of extendsOf(tag.extends)) if (!seen.has(parent)) { seen.add(parent); next.push(parent); }
      }
      level = next;
    }
    result.set(row.id, found);
  }
  return result;
}
