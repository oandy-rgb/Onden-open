// What the deferred version checks of migration 220 add to the COMMIT of one large transaction (review of PR #1938 round 1, point 4): an import
// that makes thousands of notes in one transaction runs every deferred trigger inside COMMIT, one statement under the request's
// statement_timeout. Here: 2,000 and 5,000 notes made through createNote in one event transaction; the time of the work and of the COMMIT are
// printed, never asserted: on a shared CI machine the same COMMIT took 16.7 s once and 15.1 s once (runs 45098217879, 45164116316) with the same work. What
// is measured is the work, counted by the database: the rows read from the COMMIT on (the deferred checks, and what the dispatcher does after it), which
// should grow linearly with the notes whatever the machine's load; today they grow quadratically (the `it.fails` below). The 15-second statement timeout
// itself is the bench's (scripts/bench/run.ts backend.commit_5000_notes), timed alone on its own job.
// The same file runs on a checkout from before 220 (no version tables), which is how the PR's before/after numbers were taken.
// realPostgresAlso: the COMMIT of a server runs the deferred triggers and the statement timeout applies to it there
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { dbDriver, q, withTransaction } from "../db.js";
import { createNote } from "../services/noteCreate.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { awaitCountsOfEveryConnection } from "./helpers/statisticsOfEveryConnection.js";
import { buildSourceWorld, openNode } from "./helpers/stampedWorld.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

/** Rows read so far (sequential and index fetches, every table) by this database, every connection's counts in; `xact`: by this transaction alone, so far. */
async function rowsRead(view: "pg_stat_user_tables" | "pg_stat_xact_user_tables"): Promise<number> {
  return Number((await q<{ r: string }>(`SELECT (coalesce(sum(seq_tup_read), 0) + coalesce(sum(idx_tup_fetch), 0))::text AS r FROM ${view}`)).rows[0]!.r);
}

type CommitCost = { notes: number; workMs: number; commitMs: number; workRows: number; commitRows: number; versions: number | null };

/** `notes` notes made through createNote in one event transaction. `commitRows`: the rows read from the COMMIT on (the deferred checks and the dispatcher's
 *  work after it), the database's count of the whole minus what the transaction itself had read before its COMMIT. */
async function commitCost(notes: number): Promise<CommitCost> {
  const node = await openNode(`commit-${notes}`); open.push(node);
  const world = await buildSourceWorld(node);
  return onNode(node, async () => {
    await awaitCountsOfEveryConnection();
    const before = await rowsRead("pg_stat_user_tables");
    let workMs = 0, workRows = 0;
    const t0 = performance.now();
    await withTransaction(() => withEventTransaction(world.ws, async () => {
      for (let i = 0; i < notes; i++) {
        await createNote({ actor: world.owner, workspaceId: world.ws, id: randomUUID(), title: `Imported ${i}`, markdown: `Imported note ${i}\n\nwith a line of text`,
          spaceId: world.spaceA, event: { uiContext: "test.import" } });
      }
      workMs = performance.now() - t0;
      workRows = await rowsRead("pg_stat_xact_user_tables");
    }));
    const commitMs = performance.now() - t0 - workMs;
    await awaitCountsOfEveryConnection();
    const commitRows = (await rowsRead("pg_stat_user_tables")) - before - workRows;
    const versions = (await q<{ t: string | null }>(`SELECT to_regclass('note_versions')::text AS t`)).rows[0]!.t
      ? Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM note_versions WHERE workspace_id = $1`, [world.ws])).rows[0]!.n) : null;
    console.log(`[version commit cost] ${dbDriver}: ${notes} notes in one transaction: work ${Math.round(workMs)} ms / ${workRows} rows read, COMMIT ${Math.round(commitMs)} ms / ${commitRows} rows read from it on; versions ${versions ?? "(no version table)"}`);
    return { notes, workMs, commitMs, workRows, commitRows, versions };
  });
}

/** 2.5 times the notes may read at most 2.5 × 1.15 times the rows from the COMMIT on (linear, with room for the fixed part; quadratic is 6.25). */
const MAX_COMMIT_ROWS_RATIO = 2.5 * 1.15;

// Both tests read the same two measurements (about two minutes on a real Postgres, four on PGlite): made once, by whichever test runs first.
let measured: Promise<[CommitCost, CommitCost]> | undefined;
const measure = () => (measured ??= (async () => [await commitCost(2000), await commitCost(5000)] as [CommitCost, CommitCost])());
const show = (c: CommitCost) => `${c.notes} notes: COMMIT ${c.commitRows} rows (${(c.commitRows / c.notes).toFixed(1)} per note), ${Math.round(c.commitMs)} ms`;

describe.skipIf(!isTestDb)("the COMMIT of one large transaction", () => {
  it("2,000 and 5,000 notes made in one transaction: every note has its version (work and COMMIT time and rows printed)", async () => {
    for (const c of await measure()) if (c.versions !== null) expect(c.versions, show(c)).toBeGreaterThanOrEqual(c.notes);
  }, 1_800_000);

  // Fails today (review of PR #1996): the rows read from the COMMIT on are about notes × (notes + 21): each note's deferred version check (migration 220)
  // reads whole tables (note_version_events, note_versions, content_nodes) that grew in the same transaction; measured 2,000 → 5,000 notes: 4,042,000 →
  // 25,105,000 rows on Postgres 16 (6.2×), the same on PGlite. Recorded in docs/agents/mistakes.md (2026-11-23); the fix is its own batch, and turns this into `it`.
  it.fails("2,000 and 5,000 notes made in one transaction: the rows read from the COMMIT on grow linearly (fails today: quadratic, each note's deferred check reads whole tables)", async () => {
    const [small, large] = await measure();
    expect(large.commitRows / small.commitRows, `${show(small)}; ${show(large)}`).toBeLessThanOrEqual(MAX_COMMIT_ROWS_RATIO);
  }, 1_800_000);
});
