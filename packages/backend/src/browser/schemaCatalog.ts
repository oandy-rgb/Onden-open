// Test tool support for makeOldCopy.ts: what a database's schema IS, read from the catalog, and how to take a database whose
// schema is ahead back to a recorded one. Nothing here names a migration: the recorded schema is whatever the kept migrations left,
// so a migration added later is stepped back (or reported as not steppable) without anyone listing it.
//
// Scope: tables, columns (type, NOT NULL, default), constraints, indexes, triggers, functions, views and sequences of schema
// `public`. Rows are not part of it. stepBackTo() ends by reading the catalog again and throws if anything still differs, so an
// object kind this file does not know about cannot be left behind silently.

export type RunSql = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

type Column = { type: string; notNull: boolean; default: string | null };
type TableShape = {
  columns: Record<string, Column>;
  constraints: Record<string, string>;
  indexes: Record<string, string>;
  triggers: Record<string, string>;
  policies: Record<string, string>;
  rowSecurity: boolean;
};
export type SchemaCatalog = {
  tables: Record<string, TableShape>;
  functions: Record<string, string>;
  views: Record<string, string>;
  sequences: string[];
  /** enum and domain types, by name and definition (a composite type of a table is the table's own). */
  types: Record<string, string>;
  /** Kinds this file reads but cannot step back (schemas, extensions, rules): they are compared, so one left behind is reported, not ignored. */
  unsteppable: Record<string, string>;
};

const text = (value: unknown): string => String(value);
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Read the catalog of schema `public` (objects that belong to an extension are not part of what a migration made). */
export async function readSchemaCatalog(run: RunSql): Promise<SchemaCatalog> {
  const catalog: SchemaCatalog = { tables: {}, functions: {}, views: {}, sequences: [], types: {}, unsteppable: {} };
  const tableOf = (name: string): TableShape => (catalog.tables[name] ??= { columns: {}, constraints: {}, indexes: {}, triggers: {}, policies: {}, rowSecurity: false });
  const notOfExtension = (alias: string, classId: string) =>
    `NOT EXISTS (SELECT 1 FROM pg_depend ext WHERE ext.classid = '${classId}'::regclass AND ext.objid = ${alias}.oid AND ext.deptype = 'e')`;

  for (const row of (await run(`SELECT c.relname, c.relrowsecurity FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND ${notOfExtension("c", "pg_class")}`)).rows) {
    tableOf(text(row.relname)).rowSecurity = row.relrowsecurity === true;
  }
  for (const row of (await run(`SELECT tablename, policyname, permissive, roles::text AS roles, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public'`)).rows) {
    tableOf(text(row.tablename)).policies[text(row.policyname)] = JSON.stringify([row.permissive, row.roles, row.cmd, row.qual, row.with_check]);
  }
  for (const row of (await run(`
    SELECT t.typname, t.typtype::text AS kind,
           CASE WHEN t.typtype = 'e' THEN (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid)
                ELSE format_type(t.typbasetype, t.typtypmod) || ' ' || coalesce(pg_get_expr(t.typdefaultbin, 0), '') END AS def
      FROM pg_type t WHERE t.typnamespace = 'public'::regnamespace AND t.typtype IN ('e', 'd') AND ${notOfExtension("t", "pg_type")}`)).rows) {
    catalog.types[text(row.typname)] = `${text(row.kind)} ${text(row.def)}`;
  }
  for (const row of (await run(`
    SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS dflt
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped`)).rows) {
    tableOf(text(row.relname)).columns[text(row.attname)] = { type: text(row.type), notNull: row.attnotnull === true, default: row.dflt === null ? null : text(row.dflt) };
  }
  for (const row of (await run(`
    SELECT c.relname, k.conname, pg_get_constraintdef(k.oid) AS def FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')`)).rows) {
    tableOf(text(row.relname)).constraints[text(row.conname)] = text(row.def);
  }
  // An index a constraint owns (primary key, unique) is part of that constraint's definition, not listed twice.
  for (const row of (await run(`
    SELECT c.relname, i.relname AS index_name, pg_get_indexdef(i.oid) AS def FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid
     WHERE c.relnamespace = 'public'::regnamespace AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.oid)`)).rows) {
    tableOf(text(row.relname)).indexes[text(row.index_name)] = text(row.def);
  }
  for (const row of (await run(`
    SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal`)).rows) {
    tableOf(text(row.relname)).triggers[text(row.tgname)] = text(row.def);
  }
  for (const row of (await run(`
    SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature, pg_get_functiondef(p.oid) AS def FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND ${notOfExtension("p", "pg_proc")}`)).rows) {
    catalog.functions[text(row.signature)] = text(row.def);
  }
  for (const row of (await run(`SELECT c.relname, pg_get_viewdef(c.oid) AS def FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm') AND ${notOfExtension("c", "pg_class")}`)).rows) {
    catalog.views[text(row.relname)] = text(row.def);
  }
  for (const row of (await run(`SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S' AND ${notOfExtension("c", "pg_class")}`)).rows) {
    catalog.sequences.push(text(row.relname));
  }
  for (const row of (await run(`SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname NOT IN ('information_schema', 'public')`)).rows) catalog.unsteppable[`schema ${text(row.nspname)}`] = "";
  for (const row of (await run(`SELECT extname FROM pg_extension`)).rows) catalog.unsteppable[`extension ${text(row.extname)}`] = "";
  for (const row of (await run(`SELECT c.relname, r.rulename, pg_get_ruledef(r.oid) AS def FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')`)).rows) {
    catalog.unsteppable[`rule ${text(row.relname)}.${text(row.rulename)}`] = text(row.def);
  }
  catalog.sequences.sort();
  return catalog;
}

/** Every way `actual` differs from `wanted`, one line each; empty when they are the same schema. */
export function schemaDifferences(wanted: SchemaCatalog, actual: SchemaCatalog): string[] {
  const out: string[] = [];
  const compareMap = (kind: string, a: Record<string, unknown>, b: Record<string, unknown>) => {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!(key in b)) out.push(`only in the wanted schema: ${kind} ${key}`);
      else if (!(key in a)) out.push(`only in the actual schema: ${kind} ${key}`);
      else if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) out.push(`different: ${kind} ${key}\n    wanted ${JSON.stringify(a[key])}\n    actual ${JSON.stringify(b[key])}`);
    }
  };
  compareMap("function", wanted.functions, actual.functions);
  compareMap("view", wanted.views, actual.views);
  compareMap("type", wanted.types, actual.types);
  compareMap("(cannot be stepped back)", wanted.unsteppable, actual.unsteppable);
  compareMap("sequence", Object.fromEntries(wanted.sequences.map((s) => [s, 1])), Object.fromEntries(actual.sequences.map((s) => [s, 1])));
  const tableNames = new Set([...Object.keys(wanted.tables), ...Object.keys(actual.tables)]);
  for (const name of tableNames) {
    const a = wanted.tables[name];
    const b = actual.tables[name];
    if (!a) { out.push(`only in the actual schema: table ${name}`); continue; }
    if (!b) { out.push(`only in the wanted schema: table ${name}`); continue; }
    compareMap(`column ${name}.`, a.columns, b.columns);
    compareMap(`constraint ${name}.`, a.constraints, b.constraints);
    compareMap(`index ${name}.`, a.indexes, b.indexes);
    compareMap(`trigger ${name}.`, a.triggers, b.triggers);
    compareMap(`policy ${name}.`, a.policies, b.policies);
    if (a.rowSecurity !== b.rowSecurity) out.push(`different: row level security of ${name}: wanted ${a.rowSecurity}, actual ${b.rowSecurity}`);
  }
  return out;
}

const columnSql = (name: string, column: Column) =>
  `${quote(name)} ${column.type}${column.default === null ? "" : ` DEFAULT ${column.default}`}${column.notNull ? " NOT NULL" : ""}`;
// A primary key or unique constraint before the foreign keys that point at it.
const constraintOrder = (definition: string) => (/^(PRIMARY KEY|UNIQUE)/.test(definition) ? 0 : /^FOREIGN KEY/.test(definition) ? 2 : 1);

/**
 * Take the schema back to `target` (what the kept migrations left): drop what a later migration added, restore what it changed or
 * took away, using the recorded definitions. Rows stay as they are; data a later migration removed or rewrote is not brought back.
 * Throws, naming the difference, when the catalog still differs afterwards.
 */
export async function stepBackTo(run: RunSql, target: SchemaCatalog): Promise<void> {
  const ddl = async (sql: string) => { await run(sql); };

  let now = await readSchemaCatalog(run);
  // What differs from the target is dropped first (and re-created from the target below), so a changed definition and a new
  // object take the same path.
  for (const [table, shape] of Object.entries(now.tables)) {
    for (const [name, def] of Object.entries(shape.triggers)) {
      if (target.tables[table]?.triggers[name] !== def) await ddl(`DROP TRIGGER IF EXISTS ${quote(name)} ON ${quote(table)}`);
    }
  }
  for (const [table, shape] of Object.entries(now.tables)) {
    for (const [name, def] of Object.entries(shape.policies)) {
      if (target.tables[table]?.policies[name] !== def) await ddl(`DROP POLICY IF EXISTS ${quote(name)} ON ${quote(table)}`);
    }
  }
  for (const [name, def] of Object.entries(now.views)) if (target.views[name] !== def) await ddl(`DROP VIEW IF EXISTS ${quote(name)} CASCADE`);
  for (const table of Object.keys(now.tables)) if (!target.tables[table]) await ddl(`DROP TABLE IF EXISTS ${quote(table)} CASCADE`);
  for (const [table, shape] of Object.entries(target.tables)) {
    if (now.tables[table]) continue;
    await ddl(`CREATE TABLE ${quote(table)} (${Object.entries(shape.columns).map(([name, column]) => columnSql(name, column)).join(", ")})`);
  }
  now = await readSchemaCatalog(run);
  for (const [table, shape] of Object.entries(now.tables)) {
    for (const [name, def] of Object.entries(shape.constraints)) {
      if (target.tables[table]?.constraints[name] !== def) await ddl(`ALTER TABLE ${quote(table)} DROP CONSTRAINT IF EXISTS ${quote(name)} CASCADE`);
    }
    for (const [name, def] of Object.entries(shape.indexes)) {
      if (target.tables[table]?.indexes[name] !== def) await ddl(`DROP INDEX IF EXISTS ${quote(name)}`);
    }
  }
  now = await readSchemaCatalog(run);
  for (const [table, shape] of Object.entries(now.tables)) {
    const wanted = target.tables[table]!.columns;
    for (const name of Object.keys(shape.columns)) if (!wanted[name]) await ddl(`ALTER TABLE ${quote(table)} DROP COLUMN ${quote(name)} CASCADE`);
    for (const [name, column] of Object.entries(wanted)) {
      const have = shape.columns[name];
      if (!have) { await ddl(`ALTER TABLE ${quote(table)} ADD COLUMN ${columnSql(name, column)}`); continue; }
      if (have.type !== column.type) {
        await ddl(`ALTER TABLE ${quote(table)} ALTER COLUMN ${quote(name)} DROP DEFAULT`);
        await ddl(`ALTER TABLE ${quote(table)} ALTER COLUMN ${quote(name)} TYPE ${column.type} USING ${quote(name)}::${column.type}`);
      }
      if (have.default !== column.default || have.type !== column.type) {
        await ddl(`ALTER TABLE ${quote(table)} ALTER COLUMN ${quote(name)} ${column.default === null ? "DROP DEFAULT" : `SET DEFAULT ${column.default}`}`);
      }
      // A column an older app always filled (NOT NULL with a default) may be empty in rows today's code wrote: those get the old default.
      if (column.notNull && !have.notNull && column.default !== null) await ddl(`UPDATE ${quote(table)} SET ${quote(name)} = ${column.default} WHERE ${quote(name)} IS NULL`);
      if (have.notNull !== column.notNull) await ddl(`ALTER TABLE ${quote(table)} ALTER COLUMN ${quote(name)} ${column.notNull ? "SET" : "DROP"} NOT NULL`);
    }
  }
  now = await readSchemaCatalog(run);
  for (const [table, shape] of Object.entries(target.tables)) {
    const missing = Object.entries(shape.constraints).filter(([name]) => !(name in now.tables[table]!.constraints));
    for (const [name, def] of missing.sort((a, b) => constraintOrder(a[1]) - constraintOrder(b[1]))) {
      await ddl(`ALTER TABLE ${quote(table)} ADD CONSTRAINT ${quote(name)} ${def}`);
    }
  }
  for (const [table, shape] of Object.entries(target.tables)) {
    for (const [name, def] of Object.entries(shape.indexes)) if (!(name in now.tables[table]!.indexes)) await ddl(def);
  }
  for (const [signature, def] of Object.entries(now.functions)) {
    if (!(signature in target.functions)) await ddl(`DROP FUNCTION IF EXISTS public.${signature} CASCADE`);
    else if (target.functions[signature] !== def) await ddl(target.functions[signature]!);
  }
  for (const [signature, def] of Object.entries(target.functions)) if (!(signature in now.functions)) await ddl(def);
  now = await readSchemaCatalog(run);
  for (const [table, shape] of Object.entries(target.tables)) {
    for (const [name, def] of Object.entries(shape.triggers)) if (!(name in now.tables[table]!.triggers)) await ddl(def);
  }
  for (const [name, def] of Object.entries(target.views)) if (!(name in now.views)) await ddl(`CREATE VIEW ${quote(name)} AS ${def}`);
  for (const [table, shape] of Object.entries(target.tables)) {
    for (const [name, def] of Object.entries(shape.policies)) {
      if (name in now.tables[table]!.policies) continue;
      const [permissive, roles, cmd, using, check] = JSON.parse(def) as [string, string, string, string | null, string | null];
      await ddl(`CREATE POLICY ${quote(name)} ON ${quote(table)} AS ${permissive} FOR ${cmd} TO ${roles.replace(/^\{|\}$/g, "")}${using ? ` USING (${using})` : ""}${check ? ` WITH CHECK (${check})` : ""}`);
    }
    await ddl(`ALTER TABLE ${quote(table)} ${shape.rowSecurity ? "ENABLE" : "DISABLE"} ROW LEVEL SECURITY`);
  }
  // A type only a later migration made goes once nothing uses it (its columns are gone above). One that was changed or taken away is not restored.
  for (const name of Object.keys((await readSchemaCatalog(run)).types)) if (!(name in target.types)) await ddl(`DROP TYPE IF EXISTS ${quote(name)} CASCADE`);
  for (const name of (await readSchemaCatalog(run)).sequences) if (!target.sequences.includes(name)) await ddl(`DROP SEQUENCE IF EXISTS ${quote(name)} CASCADE`);

  const left = schemaDifferences(target, await readSchemaCatalog(run));
  if (left.length > 0) throw new Error(`the schema could not be taken back to what the kept migrations left:\n  ${left.join("\n  ")}`);
}
