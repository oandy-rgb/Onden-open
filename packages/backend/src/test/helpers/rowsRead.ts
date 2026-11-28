// The rows the database read, by table, as its statistics count them (sequential reads plus index fetches): what the cost tests measure, never time. And the
// one bound the `[[link]]` look-ups are held to (issue #2021: what a link look-up reads must not grow with the workspace), used by the tests of them
// (versionCommitCost, receivedRelinkCost, wikilinkRelinkIndex), and the forbidden look-up a negative control runs inside a measured window (readEachWhole).
import { expect } from "vitest";
import { q, withTransaction } from "../../db.js";

export type Rows = Map<string, number>;

/** Rows read so far, by table: by this database (`pg_stat_user_tables`; a server's other connections are in only once they have sent their counts:
 *  helpers/statisticsOfEveryConnection.ts) or by this transaction alone (`pg_stat_xact_user_tables`). */
export async function rowsReadByTable(view: "pg_stat_user_tables" | "pg_stat_xact_user_tables" = "pg_stat_user_tables"): Promise<Rows> {
  return new Map((await q<{ t: string; r: string }>(
    `SELECT relname AS t, (coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0))::text AS r FROM ${view}`,
  )).rows.map((r) => [r.t, Number(r.r)]));
}
export const minusRows = (a: Rows, ...b: Rows[]): Rows => new Map([...a].map(([t, n]) => [t, b.reduce((left, m) => left - (m.get(t) ?? 0), n)]));
export const sumRows = (r: Rows, only?: readonly string[]) => [...r].reduce((s, [t, n]) => (only && !only.includes(t) ? s : s + n), 0);
/** The `top` tables read most, for a message. */
export const largestRows = (r: Rows, top = 4) => [...r].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, top).map(([t, n]) => `${t} ${n}`).join(", ");

/** The tables a link look-up reads (services/wikilinkEdges.ts): the notes, their link index, the edges. node_attributes is not among them: the `aliases` look-up
 *  reads every `aliases` row of the workspace, which grows with the notes that have aliases (pinned: wikilinkRelinkIndex.integration.test.ts, FINDING), and
 *  each target's own aliases are read by its id. */
export const LINK_LOOKUP_TABLES = ["content_nodes", "note_link_index", "node_edges"] as const;
export type WholeReadTable = (typeof LINK_LOOKUP_TABLES)[number] | "node_attributes";
/** The link tables' rows of `r`, for a message. */
export const showLinkRows = (r: Rows) => LINK_LOOKUP_TABLES.map((t) => `${t} ${r.get(t) ?? 0}`).join(", ");

/** One statement that reads every row a workspace has in the table: its whole rows (`length(x::text)`), so the table itself, never an index alone. */
const WHOLE_READ: Record<WholeReadTable, string> = {
  content_nodes: `SELECT count(*) FROM content_nodes x WHERE x.workspace_id = $1 AND length(x::text) > 0`,
  note_link_index: `SELECT count(*) FROM note_link_index x WHERE x.workspace_id = $1 AND length(x::text) > 0`,
  node_edges: `SELECT count(*) FROM node_edges x WHERE x.workspace_id = $1 AND length(x::text) > 0`,
  node_attributes: `SELECT count(*) FROM node_attributes x WHERE x.workspace_id = $1 AND length(x::text) > 0`,
};

/** Each of `tables` read whole for the workspace, `times` times, in the current connection and transaction, counting nothing itself: the forbidden look-up, for
 *  a negative control to run INSIDE a measured window, so that it is counted by the same path as the work measured there. */
export async function readEachWhole(workspaceId: string, tables: readonly WholeReadTable[], times = 1): Promise<void> {
  for (let i = 0; i < times; i++) for (const t of tables) await q(WHOLE_READ[t], [workspaceId]);
}

/** The rows one read of each of `tables` whole counts, for the workspace, counted the same way as what is measured (this transaction's counts, around each
 *  statement): what the forbidden look-up (one that reads the whole workspace) costs each time it runs. */
export async function wholeReads(workspaceId: string, tables: readonly WholeReadTable[]): Promise<Rows> {
  return withTransaction(async () => {
    const out: Rows = new Map();
    for (const t of tables) {
      const from = await rowsReadByTable("pg_stat_xact_user_tables");
      await readEachWhole(workspaceId, [t]);
      out.set(t, ((await rowsReadByTable("pg_stat_xact_user_tables")).get(t) ?? 0) - (from.get(t) ?? 0));
    }
    return out;
  });
}

/** What is measured against the bound. `rows`: the rows read, by table. `whole`: one read of each table whole (wholeReads), as the workspace is at the end.
 *  `units`: how many times the forbidden look-up would run (once a step, once a file imported). `baseline`: the same work measured in a smaller workspace, when
 *  the work itself reads rows that grow with it (a bundle of notes): then what is bounded is what the larger workspace adds. */
export type LinkReads = { rows: Rows; whole: Rows; units: number; tables: readonly string[]; baseline?: { rows: Rows; whole: Rows } };
type LinkReadCheck = { table: string; read: number; bound: number; whole: number; show: string };

/** For each table: the rows read (beyond the baseline's) and the bound, half of `units` reads of the table whole (beyond the baseline workspace's). */
function linkReadChecks(label: string, m: LinkReads): LinkReadCheck[] {
  return m.tables.map((table) => {
    const read = (m.rows.get(table) ?? 0) - (m.baseline?.rows.get(table) ?? 0);
    const whole = (m.whole.get(table) ?? 0) - (m.baseline?.whole.get(table) ?? 0);
    const bound = (m.units * whole) / 2;
    return { table, read, bound, whole,
      show: `${label}: ${table} read ${read} rows${m.baseline ? " more than in the smaller workspace" : ""}; the bound is half of ${m.units} × ${whole} (one read of it whole), ${bound}` };
  });
}

/** THE bound of the link look-ups: for each table, the rows read stay under half of what one read of the table whole, once a unit, costs; a read of each table
 *  whole is counted at all (a measurement that counts nothing would pass any bound). That the bound is half a whole read is its definition, not a control:
 *  that it can be broken is shown by a negative control, the same work measured with the forbidden read run inside its window (readEachWhole,
 *  expectOverHalfAWholeRead). */
export function expectUnderHalfAWholeRead(label: string, m: LinkReads): void {
  for (const c of linkReadChecks(label, m)) {
    expect(c.whole, `${c.show}: a read of it whole is counted`).toBeGreaterThan(0);
    expect(c.read, c.show).toBeLessThan(c.bound);
  }
}

/** A negative control of expectUnderHalfAWholeRead: `m` was measured with the forbidden look-up run inside the measured window (readEachWhole), so the same
 *  bound must be broken for every table: else the measurement does not count what runs in that window, or the bound is too loose to catch the look-up. */
export function expectOverHalfAWholeRead(label: string, m: LinkReads): void {
  for (const c of linkReadChecks(label, m)) {
    expect(c.whole, `${c.show}: a read of it whole is counted`).toBeGreaterThan(0);
    expect(c.read, `${c.show}: negative control, the forbidden read was run inside the measured window, so the bound must be broken`).toBeGreaterThanOrEqual(c.bound);
  }
}

/** For an `it.fails` of the same bound: true when the measurement can tell (a read of each table whole is counted), so a measurement that counts nothing makes
 *  the `it.fails` red instead of passing it. */
export function linkReadsCanTell(label: string, m: LinkReads): boolean {
  return linkReadChecks(label, m).every((c) => c.whole > 0);
}
