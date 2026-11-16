// A restore that failed part way, then run again from the same backup in the
// same mode, ends where a restore that went through at once ends.
//
// fast-check generates a workspace (helpers/roundTripArb.ts), the test backs it
// up and restores it three ways into a target:
//   * once, with nothing failing — the oracle (in a target built the same way);
//   * with one low-level write throwing on its Nth call (a note, a link, a tag,
//     an attribute, a board, a deletion), then again, complete.
// Both targets are read back whole (snapshotWorkspace) and compared; the rerun
// may not answer 5xx, and a merge may not lose a note that was there before the
// restore, failed or not. Modes: empty, merge, workspace.
//
// The failing write is injected where backupRestore.ts calls it (vi.mock of the
// domain writers, counting only while a restore is armed), so the test does not
// depend on how the restore orders its steps.
//
// Replay with ROUNDTRIP_SEED=<seed>; ROUNDTRIP_RUNS=<n> runs more.

import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { Hono } from "hono";

import type { ActorCtx } from "../../types.js";
import type { RestoreJob } from "@onden/contract";
import { q } from "../../db.js";
import { apiOnError } from "../../httpError.js";
import backupRouter from "../../routes/backup.js";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { roundTripRuns, worldSpec, type WorldSpec } from "../helpers/roundTripArb.js";
import { buildWorld, freshWorkspace, snapshotWorkspace, type WorldSnapshot } from "../helpers/roundTripWorld.js";
import { fullBackup } from "../helpers/roundTripApi.js";
import { makeSpace } from "../helpers/spaceFixtures.js";
import { waitForJob } from "../helpers/restoreJob.js";
import { workspaceSwitch } from "../helpers/workspaceSwitch.js";
import { readApp, appDifferences } from "../helpers/roundTripRich.js";
import { registerShippedModules } from "../helpers/registerShippedModules.js";

registerShippedModules();

/** Which write throws, and when. Counting starts when `target` is set. */
const fault = vi.hoisted(() => ({ target: null as string | null, nth: 0, count: 0 }));

vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => workspaceSwitch.ws }));

/** `fn` that throws on the armed call (a plain Error: not a refusal, so it aborts the restore). */
function failing<A extends unknown[], R>(name: string, fn: (...args: A) => R): (...args: A) => R {
  return (...args) => {
    if (fault.target === name && ++fault.count === fault.nth) throw new Error(`injected failure in ${name}`);
    return fn(...args);
  };
}
vi.mock("../../services/noteCreate.js", async (o) => { const m = await o<typeof import("../../services/noteCreate.js")>(); return { ...m, createNote: failing("createNote", m.createNote) as typeof m.createNote }; });
vi.mock("../../services/edgeWrites.js", async (o) => { const m = await o<typeof import("../../services/edgeWrites.js")>(); return { ...m, createEdge: failing("createEdge", m.createEdge) }; });
vi.mock("../../services/boardWrites.js", async (o) => { const m = await o<typeof import("../../services/boardWrites.js")>(); return { ...m, applyBoardChanges: failing("applyBoardChanges", m.applyBoardChanges) }; });
vi.mock("../../services/nodeTrash.js", async (o) => { const m = await o<typeof import("../../services/nodeTrash.js")>(); return { ...m, trashNode: failing("trashNode", m.trashNode) }; });
vi.mock("../../services/tagMembershipWrites.js", async (o) => { const m = await o<typeof import("../../services/tagMembershipWrites.js")>(); return { ...m, applyTagToNode: failing("applyTagToNode", m.applyTagToNode) }; });
vi.mock("../../services/attributeWrites.js", async (o) => { const m = await o<typeof import("../../services/attributeWrites.js")>(); return { ...m, setNodeAttribute: failing("setNodeAttribute", m.setNodeAttribute) }; });
vi.mock("../../services/tagHierarchy.js", async (o) => { const m = await o<typeof import("../../services/tagHierarchy.js")>(); return { ...m, createTag: failing("createTag", m.createTag) as typeof m.createTag }; });

const enabled = isTestDatabase();
type Mode = "empty" | "merge" | "workspace";
const TARGETS = ["createNote", "createEdge", "applyBoardChanges", "trashNode", "applyTagToNode", "setNodeAttribute", "createTag"] as const;

type Place = { ws: string; actor: ActorCtx; space: string };

function app(actor: ActorCtx) {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/backup", backupRouter);
  return hono;
}

const personalSpace = async (actor: ActorCtx) =>
  (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [actor.id])).rows[0]!.id;

/** A target workspace: `empty` restores into a shared space of its own, the others into the owner's personal space. */
async function newTarget(mode: Mode, preexisting: WorldSpec | null): Promise<Place> {
  const made = await freshWorkspace(`rerun-${mode}`);
  workspaceSwitch.ws = made.ws;
  const space = mode === "empty" ? await makeSpace(made.ws, "Restore target", [{ id: made.actor.id, permission: "edit" }]) : await personalSpace(made.actor);
  if (preexisting) await buildWorld(preexisting, made);
  return { ...made, space };
}

/** Upload (or reuse the upload of a retryable job) and run the restore; the job as it ended. */
async function restoreOnce(place: Place, zip: Buffer, mode: Mode, again?: RestoreJob): Promise<{ job: RestoreJob; startStatus: number }> {
  workspaceSwitch.ws = place.ws;
  const hono = app(place.actor);
  let uploadId = again?.upload_id;
  if (!again?.retryable) {
    const up = await hono.request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
    if (up.status !== 200) throw new Error(`upload ${up.status} ${await up.text()}`);
    uploadId = ((await up.json()) as { upload_id: string }).upload_id;
  }
  const started = await hono.request(`/api/backup/restore/${uploadId}/apply`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: place.space, mode }),
  });
  if (started.status !== 202 && started.status !== 200) return { job: { status: "failed", error: await started.text() } as RestoreJob, startStatus: started.status };
  const job = await waitForJob(hono, ((await started.json()) as { job: RestoreJob }).job);
  // A failed job is read again: `retryable` is decided when it is read.
  const read = await hono.request(`/api/backup/restore/jobs/${job.id}`);
  return { job: ((await read.json()) as { job: RestoreJob }).job, startStatus: started.status };
}

const liveTitles = (s: WorldSnapshot) => s.notes.filter((n) => !n.deleted).map((n) => n.title).sort();

describe.skipIf(!enabled)("a restore that failed part way, run again", () => {
  const faultArb = fc.record({ target: fc.constantFrom(...TARGETS), nth: fc.integer({ min: 1, max: 8 }) });

  for (const mode of ["empty", "merge", "workspace"] as const) {
    it(`${mode}: ends where a restore that went through at once ends`, async () => {
      await fc.assert(fc.asyncProperty(
        worldSpec({ maxNotes: 5, trashed: true, exotic: "values", bigInk: true, canvas: true, tagFunctions: true, media: true, linksToTrashed: true, standaloneTasks: 2, rich: true }),
        worldSpec({ maxNotes: 3 }),
        faultArb,
        async (spec, other, injected) => {
          const preexisting = mode === "merge" ? other : null;
          const source = await freshWorkspace("rerun-source");
          workspaceSwitch.ws = source.ws;
          await buildWorld(spec, source);
          const zip = await fullBackup(source.ws, source.actor);

          // The oracle: the same target, restored once with nothing failing.
          const clean = await newTarget(mode, preexisting);
          const oracle = await restoreOnce(clean, zip, mode);
          expect(oracle.job.status, `oracle: ${oracle.job.error ?? ""}`).toBe("done");
          const want = await snapshotWorkspace(clean.ws);
          const wantApp = await readApp(clean.ws, clean.actor);

          const target = await newTarget(mode, preexisting);
          const before = await snapshotWorkspace(target.ws);
          fault.target = injected.target; fault.nth = injected.nth; fault.count = 0;
          let first: Awaited<ReturnType<typeof restoreOnce>>;
          try { first = await restoreOnce(target, zip, mode); } finally { fault.target = null; }
          const what = `${mode}, ${injected.target} #${injected.nth} threw (first attempt: ${first.job.status} ${first.job.error ?? ""}, ${fault.count} calls)`;

          if (first.job.status === "failed") {
            // What was there before is still there, whatever the attempt did.
            const after = await snapshotWorkspace(target.ws);
            for (const t of liveTitles(before)) expect(liveTitles(after), `${what}: a note from before the restore is gone: ${t}`).toContain(t);
          }

          const second = first.job.status === "failed" ? await restoreOnce(target, zip, mode, first.job) : first;
          expect(second.startStatus, `${what}: rerun answered`).toBeLessThan(500);
          expect(second.job.status, `${what}: rerun ${second.job.error ?? ""}`).toBe("done");
          const got = await snapshotWorkspace(target.ws);
          expect(got.notes.map((n) => [n.title, n.parent, n.deleted]), `${what}: which notes, where, trash`).toEqual(want.notes.map((n) => [n.title, n.parent, n.deleted]));
          expect(got.notes, `${what}: notes`).toEqual(want.notes);
          expect(got.tasks, `${what}: tasks`).toEqual(want.tasks);
          expect(got.tags, `${what}: tags`).toEqual(want.tags);
          expect(got.canvases, `${what}: boards`).toEqual(want.canvases);
          // What the app shows (saved views, functions, pointers, paragraph tags, graph, typed and ink attributes): a rerun
          // ends where a restore that went through at once ends, whatever that restore carries (a part the restore does
          // not carry at all, backupRoundTrip.property.test.ts, is missing on both sides).
          expect(appDifferences(wantApp, await readApp(target.ws, target.actor)), `${what}: what the app shows`).toEqual({});
        },
      ), roundTripRuns({ maxRuns: 8 }));
    }, 900_000);
  }
});
