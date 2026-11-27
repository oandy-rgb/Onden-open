// What a stamped snapshot carries, table by table (docs/architecture/proposals/add-device-snapshot-2026-11-15.md §3–4).
//
// WHICH tables are carried is spine/syncClasses.json (`snapshot`: rows | genesis | dependency | identity). HOW each is read and
// written is snapshotTables.json, the list next to it: one entry per carried table, in the order rows can be written (a row's
// parents first). A guard (syncClasses.integration.test.ts) keeps the two lists equal, so a table that is classified as carried has
// to say how, and the other way round. (This file does not import syncClasses.ts: that one is the classification for tests and the guard.) The export (services/stampedSnapshot.ts), the import (spine/stampedImport.ts) and the digest
// (spine/snapshotSql.ts) all read SNAPSHOT_SPECS, so a table is described once, in data: this file only turns an entry into SQL.
//
// An entry's `where` is the rows of the table that are in the snapshot; the part that depends on who reads is a placeholder the
// caller's Scope answers (services/readPolicy.ts snapshotScope for one operator; `wholeWorkspace` below for "everything"):
//   {row:a}      the content node row on alias `a` is in scope        {node:c}    the content node whose id is in `c` is
//   {space:c}    the space whose id is in `c` is readable             {person:c}  `c` (an actor id) is the operator
// `$1` is always the workspace id. `deferred` columns point back at rows that come later (workspaces.owner_actor_id,
// content_nodes.parent_id …): they are written empty, and a `refs` item sets them once every row is in, so no page has to hold a
// row's parent. `exclude` columns stay on the node (and keep their default, or `placeholders`, on the receiver); `override` gives the
// SQL of the value to carry in place of the column.

import data from "./snapshotTables.json" with { type: "json" };

export type Scope = {
  /** The content node on `alias` (a row of content_nodes) is in scope: its space is readable (a tag definition always is), live or in the trash. */
  nodeRow(alias: string): string;
  /** The content node whose id is in `col` is in scope. */
  node(col: string): string;
  /** The space whose id is in `col` is readable. */
  space(col: string): string;
  /** `col` (an actor id, uuid or text) is the operator: a person's own rows are not anyone else's to read. */
  person(col: string): string;
};

/** The whole workspace: nothing is left out. What an owner's own export equals, and what a check of a receiver can ask for. */
export const wholeWorkspace = (): Scope => ({
  nodeRow: () => "true",
  node: (col) => `${col} IN (SELECT x.id FROM content_nodes x WHERE x.workspace_id = $1)`,
  space: (col) => `${col} IN (SELECT x.id FROM spaces x WHERE x.workspace_id = $1)`,
  person: () => "true",
});

/** One kind of stamp a table's rows can carry: the `table_name` it is filed under and the row key it uses there. */
type StampDef = { label: string; rowKey: string; when?: string };

type Entry = {
  pk: string[]; order: string[]; where: string; /** Rows of the table that NEVER leave this node (see `stampMayLeaveSql`): the classification says which in syncClasses.json (`neverLeaves`), this is how to tell. */ neverLeaves?: string;
  exclude?: string[]; placeholders?: Record<string, string>;
  override?: Record<string, string>; deferred?: string[]; stamps?: StampDef[]; note?: string;
  /** Columns derived on each node and how a check of "the same" compares them: DERIVED_PER_NODE_COLUMNS below. */ derived?: Record<string, DerivedHow>;
};

export type SnapshotSpec = {
  table: string;
  /** Columns that identify a row; also the conflict target when the row is written again. Empty: the table has no primary key. */
  pk: string[];
  /** SQL expressions over `t` that order rows (text, compared bytewise). */
  order: string[];
  where(s: Scope): string;
  /** SQL over `t` for the rows that never leave this node (already left out of `where`); see `stampMayLeaveSql`. */
  neverLeaves?: string;
  exclude?: string[];
  placeholders?: Record<string, string>;
  override?(s: Scope): Record<string, string>;
  deferred?: string[];
  /** The stamps of this table's rows; none for a table with no stamp trigger yet (its stamps are "equal to genesis"). */
  stamps?: StampDef[];
};

const fill = (template: string, s: Scope) => template.replace(/\{(row|node|space|person):([^}]+)\}/g, (_m, kind: string, arg: string) =>
  kind === "row" ? s.nodeRow(arg) : kind === "node" ? s.node(arg) : kind === "space" ? s.space(arg) : s.person(arg));

/** Queries that each find a sign that someone wrote in the empty workspace a database makes for itself (any row = not empty): the
 *  tables a fresh install already holds rows in are checked for any row that is NOT one an install makes (a tag whose name is not one of the
 *  built-in ones, a space that is not the default, system, restricted or a person's own, a function reference that is not the task one, a module
 *  switch, a tag applied to anything but the Site Config note), whatever the row's stamp says — a row of an older database carries only a genesis stamp. `{systemExternalId}` and `{notTag}` are filled in by spine/stampedImport.ts. */
export const SHELL_EMPTY_CHECKS: { code: string; sql: string }[] = (data as unknown as Record<string, { code: string; sql: string }[]>)["$shellEmptyChecks"]!;

/**
 * Stamp labels that some databases still hold and that are neither made, copied nor compared any more: written before 2026-11, no trigger or genesis pass makes them
 * (migration 209), and the snapshot, the digest and the change bundle leave them out (none of them lists a label here: SNAPSHOT_SPECS refuses one, and
 * stampedBundleSources.integration.test.ts checks the bundle's labels). The stamps stay where they are: nothing deletes or rewrites them.
 *   node_attributes._canvas_sections   one stamp per section of a board's section frames (migration 199). The frames are the text of the attribute `value`,
 *                                      a unit of its own that travels; two kinds of unit over one piece of data made two nodes with the same boards differ.
 */
export const RETIRED_STAMP_LABELS: readonly string[] = ["node_attributes._canvas_sections"];

/**
 * Carried columns whose value is DERIVED on each node, not replicated (owner's decision 甲, 2026-11-24, issue #2020): a write moves them on the node that writes, as on
 * one server, and carries no stamp for them; a node that takes the write works out its own (or keeps what it had). So two nodes holding the same writes may hold
 * different values here, and that is not a difference. How a check of "two nodes hold the same" treats each one (`DerivedHow`):
 *   "left out"    not compared at all. The five `updated_at` of the tables other than notes: a write that moves it without changing any unit (a paragraph row's text
 *                 worked out again at every save, a card put down where it was, an attribute saved as it was) moves it on the writer only. An anchor's
 *                 `moved_how` / `moved_at` (migration 215: this node's own record of how its own save moved it; the receiver's expansion does not write them).
 *   "set or not"  only whether it holds a value is compared: the value is this node's clock, whether there is one is worked out from replicated state the same
 *                 way on every node. A paragraph row's `hidden_at` (services/blockNodes.ts deriveBlockRows: `now()` when the body no longer has the
 *                 paragraph, on the writer and on the receiver alike). Leaving it out whole would let "shown on one node, hidden on the other" pass.
 *   - A snapshot carries them (an exact copy: the digest a snapshot is checked by still counts them) and a change bundle carries them (the wire is unchanged). A
 *     "left out" column is taken only as the starting value of a row the receiver makes, never onto a row it holds (snapshotSql.ts overwriteCarriedColumns); a
 *     "set or not" column is written with the other display columns of the winning creation, so the two nodes agree on it even where nothing works it out again.
 *   - Every check of "two nodes hold the same" after an exchange compares them as said here (computeSnapshotDigest `derived`, through `comparedSql`); nothing a
 *     person sees reads their values (README of stampedMerge, 「衍生的欄位」). A column a unit writes, a key or a JSON column may not be here
 *     (stampedMerge/dbUnits.ts derivedColumnProblems).
 * The one list, declared per table in snapshotTables.json (`derived`, next to `exclude` and `deferred`); product and tests read it from here. A value that is
 * not one of DERIVED_HOWS is refused when stampedMerge/dbUnits.ts loads (derivedColumnProblems).
 */
export type DerivedHow = "left out" | "set or not";
export type DerivedColumns = Readonly<Record<string, Readonly<Record<string, DerivedHow>>>>;
export const DERIVED_PER_NODE_COLUMNS: DerivedColumns = Object.fromEntries(Object.entries(data as unknown as Record<string, Entry>)
  .filter(([table, e]) => !table.startsWith("$") && e.derived !== undefined).map(([table, e]) => [table, e.derived!]));
export const DERIVED_HOWS: readonly DerivedHow[] = ["left out", "set or not"];

/** The SQL a check of "two nodes hold the same" compares a column by, `expr` being its value: the value itself when the column replicates (`how` undefined),
 *  whether it is set for "set or not", nothing (null) for "left out". The one reading of DERIVED_PER_NODE_COLUMNS's `DerivedHow`. */
export function comparedSql(how: DerivedHow | undefined, expr: string): string | null {
  if (how === undefined) return expr;
  if (how === "set or not") return `(${expr} IS NOT NULL)`;
  return null;
}

export const SNAPSHOT_SPECS: SnapshotSpec[] = Object.entries(data as unknown as Record<string, Entry>).filter(([table]) => !table.startsWith("$")).map(([table, e]) => ({
  table, pk: e.pk, order: e.order, where: (s) => e.neverLeaves ? `(${fill(e.where, s)}) AND NOT (${e.neverLeaves})` : fill(e.where, s), neverLeaves: e.neverLeaves, exclude: e.exclude, placeholders: e.placeholders, deferred: e.deferred, stamps: e.stamps,
  override: e.override ? (s) => Object.fromEntries(Object.entries(e.override!).map(([c, sql]) => [c, fill(sql, s)])) : undefined,
}));
for (const spec of SNAPSHOT_SPECS) for (const d of spec.stamps ?? []) if (RETIRED_STAMP_LABELS.includes(d.label)) throw new Error(`snapshotTables.json: ${spec.table} lists the retired stamp label ${d.label}`);

export const snapshotSpec = (table: string): SnapshotSpec | undefined => SNAPSHOT_SPECS.find((s) => s.table === table);

/**
 * SQL that is true when a stamp (a row of the stamp table, on alias `s`) does NOT name a row that never leaves this node: the one rule for what stamps a snapshot, a change bundle and a digest
 * carry. The ROWS that never leave are left out by `where` (above); their STAMPS need this, because a deleted row's tombstone outlives the row and its key still names it (a temporary
 * session's membership: "<space>/<session's actor id>"). A stamp is judged by its key alone, as a row of the table with only its key columns: so `neverLeaves` of a table that has
 * stamps may use only its primary-key columns (syncClasses.guard.test.ts), and the key is "<column>/<column>…" in `pk` order (a part that holds a "/" is not a key of such a table).
 * The classification is `neverLeaves` of syncClasses.json (rows of class X never leave), checked by guards/neverLeaves.guard.test.ts and, on the wire, by sessionsStayOnTheirNode.integration.test.ts.
 */
export function stampMayLeaveSql(alias = "s"): string {
  const parts = SNAPSHOT_SPECS.flatMap((spec) => spec.neverLeaves && spec.stamps ? spec.stamps.map((def) => {
    const row = spec.pk.map((column, i) => `split_part(${alias}.row_key, '/', ${i + 1}) AS "${column}"`).join(", ");
    return `(${alias}.table_name = '${def.label.replaceAll("'", "''")}' AND EXISTS (SELECT 1 FROM (SELECT ${row}) t WHERE ${spec.neverLeaves}))`;
  }) : []);
  return parts.length === 0 ? "true" : `NOT (${parts.join(" OR ")})`;
}
