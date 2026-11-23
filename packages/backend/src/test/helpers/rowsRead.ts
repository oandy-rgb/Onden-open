// How much a piece of work read, as the database counts it: a measure that does not depend on how busy the machine is (stampedBundleScale and
// snapshotHistoryCost compare it at two sizes).
import { q } from "../../db.js";
import { RealNode, onNode } from "./distSim/realNode.js";
import { awaitCountsOfEveryConnection } from "./statisticsOfEveryConnection.js";

/** The rows the database says it read (sequential and index fetches, every table) so far: a count of work that does not depend on how busy the machine is.
 *  Every connection's counts are in first (helpers/statisticsOfEveryConnection.ts), so the number is as of now. */
export async function rowsRead(node: RealNode): Promise<number> {
  return onNode(node, async () => {
    await awaitCountsOfEveryConnection();
    return Number((await q<{ r: string }>(`SELECT (sum(seq_tup_read) + sum(COALESCE(idx_tup_fetch, 0)))::text AS r FROM pg_stat_user_tables`)).rows[0]!.r);
  });
}
