// A browser-app copy's own node id (sync_node: the origin of every write stamp it makes).
//
// Every copy starts from the same packaged database (prepareSnapshot.ts), and until 2026-11-15 that database carried
// the node id migrate() had made at build time: every copy of one build was the same node, so two people's copies
// made stamps with the same (origin, sequence number) for different content — the one thing a stamp must never do.
// Now the packaged database carries no node id (forgetNodeId), and a copy takes its own the first time it boots
// (ensureOwnNodeId), which also gives one to a copy that was started from an older packaged database.
// A copy that was started from an older packaged database wrote its stamps under the shared id. Nothing stamped has
// ever left a copy (no exchange exists yet), so no other node holds a reference to (shared id, sequence number): the
// one-time step also moves those stamps to the copy's own id — origin only; sequence numbers and clock readings are
// the copy's own and stay. After it every stamp on the device has an origin no other device has, or is a genesis
// stamp. structure_log is append-only and never leaves the device; its older lines keep the shared id.
// The rows the packaged database itself carries were there before any node wrote: stampPackagedRowsAsGenesis gives
// them the genesis stamp (migration 202's sync_genesis_pass, the one definition of it) instead of the build's own.
import { sql } from "kysely";
import { withTransaction } from "../db.js";
import { db } from "../dbKysely.js";
import { clearAppState, readAppState, writeAppState } from "./appState.js";

const STATE_KEY = "own-node-id";

/** Give this copy a node id of its own unless it already took one. True when one was made now (it is in no saved
 *  copy yet). Call after migrate() and before the first write of a boot. */
export async function ensureOwnNodeId(): Promise<boolean> {
  if (await readAppState<{ taken: true }>(STATE_KEY)) return false;
  await withTransaction(async () => {
    const before = (await sql<{ node_id: string }>`SELECT node_id FROM sync_node WHERE singleton FOR UPDATE`.execute(db)).rows[0]?.node_id;
    const own = (await sql<{ node_id: string }>`
      INSERT INTO sync_node (singleton, node_id) VALUES (true, gen_random_uuid()::text)
      ON CONFLICT (singleton) DO UPDATE SET node_id = EXCLUDED.node_id RETURNING node_id`.execute(db)).rows[0]!.node_id;
    if (before) await sql`UPDATE sync_stamps SET origin = ${own} WHERE origin = ${before}`.execute(db);
    await writeAppState(STATE_KEY, { taken: true });
  });
  return true;
}

/** For the packaged database only: it must not say which node it is, nor that a copy already took an id. */
export async function forgetNodeId(): Promise<void> {
  await sql`DELETE FROM sync_node`.execute(db);
  await clearAppState(STATE_KEY);
}

/** For the packaged database only, before forgetNodeId: what the build wrote (migrations, the local account, the
 *  module switches) is data that exists before any node writes, so its stamps become genesis stamps and the clock
 *  starts over: the first write of a copy is that copy's sequence number 1. The build's own structure lines go too
 *  (TRUNCATE: the table refuses DELETE; a packaged database has no history to keep) and the pass takes the baseline.
 *  Throws when anything but a genesis stamp is left, so a build that would ship one fails. */
export async function stampPackagedRowsAsGenesis(): Promise<void> {
  await withTransaction(async () => {
    await sql`TRUNCATE structure_log RESTART IDENTITY`.execute(db);
    await sql`DELETE FROM sync_stamps`.execute(db);
    await sql`UPDATE sync_clock SET next_seq = 1, hlc_wall = 0, hlc_counter = 0, writes_without_mutate = 0`.execute(db);
    await sql`SELECT * FROM sync_genesis_pass()`.execute(db);
    const left = (await sql<{ n: string }>`
      SELECT ((SELECT count(*) FROM sync_stamps WHERE origin <> 'genesis' OR seq <> 0 OR hlc_wall <> 0 OR hlc_counter <> 0)
            + (SELECT count(*) FROM structure_log WHERE origin <> 'genesis'))::text AS n`.execute(db)).rows[0]!.n;
    if (left !== "0") throw new Error(`the packaged database would carry ${left} stamp(s) or structure line(s) that are not genesis`);
    const again = (await sql<{ stamps_added: string; baseline_lines_added: string }>`SELECT stamps_added::text, baseline_lines_added::text FROM sync_genesis_pass()`.execute(db)).rows[0]!;
    if (again.stamps_added !== "0" || again.baseline_lines_added !== "0") throw new Error("the genesis pass is not complete on the packaged database");
  });
}
