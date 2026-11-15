// Which SQL statements write the core graph tables. Used by db.ts q() so a write
// to these tables outside any transaction (i.e. outside mutate() or
// withEventTransaction(), which are what open the transaction, take the event
// lock and append the domain_event) fails instead of silently committing alone.

export const CORE_WRITE_TABLES = ["content_nodes", "node_attributes", "node_tags", "node_edges", "block_nodes"] as const;
// Tables whose writes carry a stamp trigger (migration 194; 199 adds spaces, space_members, workspaces) that takes the workspace event lock. They are only WATCHED, for
// the report below: a write to them in a transaction that did not take the lock first can wait for it while holding a row that
// a mutate() (holding the lock) is waiting for. Fixtures in tests write them outside a transaction, so q() does not refuse that.
export const STAMPED_WRITE_TABLES = ["block_node_tags", "note_pointers", "node_positions", "spaces", "space_members", "workspaces"] as const;

/** Personal data and settings that are stamped (docs/architecture/proposals/causal-stamps-2026-11-12.md §4.1) and so must
 *  be written inside a transaction the one write entry stamped (spine/mutate.ts mutate / mutatePersonal): db.ts q()
 *  refuses any other write in tests. Table names only; the columns the stamp trigger watches are in the migration. */
export const STAMPED_ENTRY_TABLES = [
  "review_states", "actor_prefs", "actor_module_settings", "rss_seen", "rss_mutes", "rss_subscriptions", "external_calendars",
] as const;

// Optional schema prefix and double quotes; the (?![\w$]) tail keeps
// content_nodes_history (or any longer name) from matching.
// "DO UPDATE SET" / "FOR UPDATE OF" never name a table right after UPDATE, so
// ON CONFLICT and row locks are not matched; the INSERT already is.
const writeOf = (tables: readonly string[]) => new RegExp(
  String.raw`(?<![\w$])(?:insert\s+into|update|delete\s+from|merge\s+into|truncate(?:\s+table)?)\s+`
  + String.raw`(?:only\s+)?(?:"?[a-z_][\w$]*"?\s*\.\s*)?"?(${tables.join("|")})"?(?![\w$])`, "i");
const CORE_WRITE = writeOf([...CORE_WRITE_TABLES, ...STAMPED_WRITE_TABLES]);
const ENTRY_WRITE = writeOf(STAMPED_ENTRY_TABLES);

/** Remove comments and string literals so text inside them is not mistaken for SQL. */
function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** Whether q() refuses a write to this table outside a transaction (the stamped-only tables are watched, not refused). */
export const refusedOutsideTransaction = (table: string): boolean => (CORE_WRITE_TABLES as readonly string[]).includes(table);

/** The core (or stamped) table a statement writes (INSERT/UPDATE/DELETE/MERGE/TRUNCATE, also inside a WITH), or null. */
export function coreTableWritten(sql: string): string | null {
  const m = CORE_WRITE.exec(stripLiteralsAndComments(sql));
  return m ? m[1]!.toLowerCase() : null;
}

/** The STAMPED_ENTRY_TABLES table a statement writes, or null. */
export function stampedTableWritten(sql: string): string | null {
  const m = ENTRY_WRITE.exec(stripLiteralsAndComments(sql));
  return m ? m[1]!.toLowerCase() : null;
}
