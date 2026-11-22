// What the deferred version checks of migration 220 add to the COMMIT of one large transaction (review of PR #1938 round 1, point 4): an import
// that makes thousands of notes in one transaction runs every deferred trigger inside COMMIT, one statement under the request's
// statement_timeout. Here: 2,000 and 5,000 notes made through createNote in one event transaction; the time of the work and of the COMMIT are
// printed (a shared machine stretches them); on a server the COMMIT must stay under the 15-second statement timeout.
// The same file runs on a checkout from before 220 (no version tables), which is how the PR's before/after numbers were taken.
// realPostgresAlso: the COMMIT of a server runs the deferred triggers and the statement timeout applies to it there
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { dbDriver, q, withTransaction } from "../db.js";
import { createNote } from "../services/noteCreate.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, openNode } from "./helpers/stampedWorld.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

describe.skipIf(!isTestDb)("the COMMIT of one large transaction", () => {
  for (const notes of (process.env.COMMIT_COST_NOTES ?? "2000,5000").split(",").map(Number)) {
    it(`${notes} notes made in one transaction: work and COMMIT time printed; the COMMIT stays far under the statement timeout`, async () => {
      const node = await openNode(`commit-${notes}`); open.push(node);
      const world = await buildSourceWorld(node);
      await onNode(node, async () => {
        let workMs = 0;
        const t0 = performance.now();
        await withTransaction(() => withEventTransaction(world.ws, async () => {
          for (let i = 0; i < notes; i++) {
            await createNote({ actor: world.owner, workspaceId: world.ws, id: randomUUID(), title: `Imported ${i}`, markdown: `Imported note ${i}\n\nwith a line of text`,
              spaceId: world.spaceA, event: { uiContext: "test.import" } });
          }
          workMs = performance.now() - t0;
        }));
        const commitMs = performance.now() - t0 - workMs;
        const versions = (await q<{ t: string | null }>(`SELECT to_regclass('note_versions')::text AS t`)).rows[0]!.t
          ? Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM note_versions WHERE workspace_id = $1`, [world.ws])).rows[0]!.n) : null;
        console.log(`[version commit cost] ${dbDriver}: ${notes} notes in one transaction: work ${Math.round(workMs)} ms, COMMIT ${Math.round(commitMs)} ms; versions ${versions ?? "(no version table)"}`);
        // the request's statement_timeout (db.ts) applies to COMMIT on a server; PGlite has none
        if (dbDriver === "postgres") expect(commitMs).toBeLessThan(15_000);
        if (versions !== null) expect(versions).toBeGreaterThanOrEqual(notes);
      });
    }, 1_200_000);
  }
});
