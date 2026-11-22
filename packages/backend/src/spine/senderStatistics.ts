// The sender's planner statistics, made current before it reads a change bundle (proposal own-node-transport-2026-11-22 §4.2 item 2; stampedMerge/README.md "成本").
//
// A bundle is read with a handful of statements per table, each looking rows up by key; the planner picks the index from the table's statistics. A server keeps
// them current with autovacuum. A desktop or browser node (PGlite) has no autovacuum and no maintenance of its own: a table that was never analyzed is planned on
// chance (stampedBundleScale.integration.test.ts: with none at all, four times the stamps read 14.4 times the rows in three runs of five).
//
// The rule is autovacuum's own (PostgreSQL's defaults, autovacuum_analyze_threshold 50 and autovacuum_analyze_scale_factor 0.1): a table the bundle reads is
// analyzed when it never was (`reltuples < 0`), or when more rows changed since its last analysis than 50 + 10 % of its rows. On a server autovacuum keeps every
// table under that line, so that rule does nothing there; a node without autovacuum gets the analysis a server would have made, at the moment it needs it, with no
// counter of its own to keep (the proposal said "every N exchanges": the change count is a better N, and the database already keeps it).
// The change count is not enough on its own: it lives in the cumulative statistics, which PostgreSQL drops after an unclean shutdown, and PGlite drops on EVERY
// reopen (measured: 5,100 changes before a clean close, 0 after; the same after a killed process). A browser tab or a desktop app is reopened all the time, so a
// table analyzed once while small would look fresh for ever. So also: the table's size on disk now against the pages its last analysis saw (`relpages`), which is
// in the catalog and survives a restart: off by more than 8 + 10 % of them is changed (review of PR #1940, round 1, point 4). That rule is not autovacuum's, so a
// server can see it too: a table whose size moved past 8 pages + 10 % without 50 + 10 % of its rows changing (rows that grew wide, a table that bloats before its
// vacuum) gets one ANALYZE more at the next bundle read, the first exchange after it and not the next (the analysis sets relpages to the size). It changes no
// result, only which plan the read takes (review of PR #1940, round 2).
//
// Inside the read snapshot (ANALYZE runs in a transaction block, read-only included: README "成本"). It writes no replicated state: statistics are this node's own,
// they are not in any bundle, snapshot or digest. A role that does not own a table gets a WARNING and no analysis (the read goes on, at the cost before this fix).
import { snapshotRows } from "./snapshotSql.js";

/** autovacuum_analyze_threshold and autovacuum_analyze_scale_factor, PostgreSQL's defaults. */
const ANALYZE_THRESHOLD = 50;
const ANALYZE_SCALE = 0.1;
/** The pages a table may grow or shrink by, past 10 % of what its last analysis saw, before it counts as changed (the change count's threshold, in pages). */
const PAGES_THRESHOLD = 8;

/** The tables of `tables` whose statistics a planner should not trust: never analyzed, or changed by more than autovacuum lets pass. */
async function staleStatistics(tables: readonly string[]): Promise<string[]> {
  const r = await snapshotRows<{ name: string }>(
    `SELECT c.relname::text AS name
       FROM pg_class c LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE c.relname = ANY($1::text[]) AND c.relkind = 'r' AND c.relnamespace = 'public'::regnamespace
        AND (c.reltuples < 0 OR COALESCE(s.n_mod_since_analyze, 0) > $2::int + $3::float8 * c.reltuples
             OR abs(pg_relation_size(c.oid) / current_setting('block_size')::bigint - c.relpages) > $4::int + $3::float8 * c.relpages)
      ORDER BY 1`, [tables, ANALYZE_THRESHOLD, ANALYZE_SCALE, PAGES_THRESHOLD]);
  return r.rows.map((x) => x.name);
}

/** Analyze those of `tables` (every table the read will read: spine/stampedBundle.ts names them) whose statistics are stale (above). Returns the tables analyzed,
 *  none when every table's statistics are current. Call inside the bundle's read snapshot. */
export async function refreshSenderStatistics(tables: readonly string[]): Promise<string[]> {
  const stale = await staleStatistics(tables);
  for (const t of stale) await snapshotRows(`ANALYZE "${t.replaceAll('"', '""')}"`);
  return stale;
}
