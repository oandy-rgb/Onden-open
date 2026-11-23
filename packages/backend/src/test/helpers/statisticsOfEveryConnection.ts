// The table counts of pg_stat_user_tables (rows read, rows changed since the last ANALYZE) as of now, every connection's included.
//
// A real Postgres keeps each backend's counts in that backend and sends them to the shared statistics at most once a second; what it holds when it goes
// idle it sends about ten seconds later; pg_stat_force_next_flush() reaches only the backend that calls it. A write made through one connection of the pool can
// therefore be counted seconds later, whatever another connection does meanwhile: counts sent after an ANALYZE are added to "changed since
// the last analysis" although the analysis saw those rows (issue #1991: a sender analyzed just after its world was made read as stale, 5 public
// runs). A connection the pool closes (its idle timeout) sends its counts as its backend exits, which can be after this returns, unless it is waited for.
//
// So, when this returns: the work a write leaves after its commit (the dispatcher's cascades) is done, every connection of the pool has sent its counts,
// and no other client session on this database is left (one that is closing sends its counts before it leaves pg_stat_activity); this backend's cached
// snapshot is dropped. A session that does not leave within LEFTOVER_WAIT_MS fails the call, naming it. PGlite has one connection and sends them at the
// end of each statement.
import { dbDriver, pool, q } from "../../db.js";
import { awaitAllDispatchers, inflightNodeIds } from "../../services/dispatcherQueue.js";

const LEFTOVER_WAIT_MS = 30_000;

export async function awaitCountsOfEveryConnection(): Promise<void> {
  while (inflightNodeIds().length > 0) await awaitAllDispatchers();
  await q(`SELECT pg_stat_force_next_flush()`); await q(`SELECT 1`);
  if (dbDriver === "postgres") {
    // q()'s connection is given back one tick after its query (helpers/distSim/realNode.ts); then every open one is idle and is held here
    await new Promise((resolve) => setImmediate(resolve));
    const clients = await Promise.all(Array.from({ length: Math.max(1, pool.totalCount) }, () => pool.connect()));
    try {
      const ours: number[] = [];
      for (const c of clients) {
        await c.query(`SELECT pg_stat_force_next_flush()`);
        ours.push(Number((await c.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid)); // the flush runs as this statement's backend goes idle
      }
      const others = () => clients[0]!.query<{ pid: number; state: string | null; query: string }>(
        `SELECT pid, state, left(query, 120) AS query FROM pg_stat_activity
          WHERE datname = current_database() AND backend_type = 'client backend' AND NOT (pid = ANY($1::int[]))`, [ours]);
      const until = Date.now() + LEFTOVER_WAIT_MS;
      for (let left = await others(); left.rows.length > 0; left = await others()) {
        if (Date.now() > until) {
          throw new Error(`sessions still on this database after ${LEFTOVER_WAIT_MS} ms; their counts may not be in yet:\n${left.rows.map((r) => `pid ${r.pid} (${r.state ?? "?"}): ${r.query}`).join("\n")}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally { for (const c of clients) c.release(); }
  }
  await q(`SELECT pg_stat_clear_snapshot()`);
}
