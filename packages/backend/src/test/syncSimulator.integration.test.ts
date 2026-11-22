// Several devices (three) edit the same workspace offline and online; nothing may be lost
// and all must end up equal to the server.
//
// LAYER. The devices speak the sync HTTP protocol exactly as the web client
// does (helpers/syncSim/client.ts lists which frontend module each rule is
// copied from) against the REAL assembled app (`app` from index.ts) on the
// test database. The real client code (syncEngine, localDbWorker) is NOT run
// here: it needs the SQLite worker, IndexedDB/OPFS, navigator.locks and the
// app store, so wiring it in-process would need seams across both files.
//
// REPLAY. Failures print the seed and the shrunk operation list in plain words:
//   SYNC_SIM_SEED=<seed> SYNC_SIM_RUNS=<n> npx vitest run src/test/syncSimulator.integration.test.ts
//   SYNC_SIM_PATH=<path printed with the failure> to jump to the shrunk case.
//   SYNC_SIM_REPLAY='[{"kind":"edit",…}]' replays an exact op list (JSON as printed).
// Defaults: seed 20261023, 80 runs (≈ 2 minutes with three devices); raise SYNC_SIM_RUNS freely.
//
// TASKS, REVIEW, SAVED VIEWS. Devices also tick checkbox lines of a body, add / tick / date tasks that belong to no note, make notes
// review cards and grade / undo / put off a card (two devices may show the same card), and create / change / delete saved views
// of a tag or a note. invariants.ts judges them on the requests the server accepted, in the order it handled them. Two review
// rules are checked on every random run and in two named cases of regressions.ts: one showing of a card counts one review
// (`strictGradeOnce`) and an undo right after another device's undo steps back nothing (`strictUndo`).
//
// SAFETY: only runs against a *_test database; skips otherwise. Each run gets a
// workspace of its own.
import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { nativeOwnerActor } from "./helpers/persistActor.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import { SimServer } from "./helpers/syncSim/server.js";
import { World, opArbitrary, runOp, type Op } from "./helpers/syncSim/ops.js";
import { plain, failureContext, resetReviewData } from "./helpers/syncSim/harness.js";
import { checkInvariants, serverNotes, type Checks } from "./helpers/syncSim/invariants.js";
import { REGRESSIONS } from "./helpers/syncSim/regressions.js";
import { ensureConfigNode } from "./helpers/siteConfigFixture.js";

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));
const { app } = await import("../app.js");

// One workspace for the whole file: index.ts caches the native-origin actor for a
// minute, so it cannot follow a workspace per run. Runs stay apart by using their
// own notes and tags and a sync cursor that starts after everything before them.
let spaceId = "";
async function workspaceOnce(): Promise<void> {
  if (WS) return;
  WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Sync simulator', $1) RETURNING id::text`, [`sim-${randomUUID()}`])).rows[0]!.id;
  await nativeOwnerActor(WS);
  await ensureConfigNode(WS); // made lazily otherwise, inside the first write
  spaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [WS])).rows[0]!.id;
}

async function freshWorld(): Promise<World> {
  await workspaceOnce();
  await resetReviewData(WS);
  const server = new SimServer(app);
  const tagIds: string[] = [];
  for (const name of ["sim-a", "sim-b"]) {
    const made = await server.call("POST", "/api/tags", { name: `${name}-${randomUUID().slice(0, 8)}`, id: randomUUID() });
    expect(made.status).toBe(201);
    tagIds.push((made.body as { id: string }).id);
  }
  const cursor = (await q<{ id: string }>(`SELECT COALESCE(MAX(id), 0)::text AS id FROM domain_events WHERE workspace_id = $1`, [WS])).rows[0]!.id;
  return new World(server, spaceId, tagIds, cursor);
}

async function play(ops: Op[], checks: Checks = {}): Promise<World> {
  const world = await freshWorld();
  // Every device starts from the same small tree (two top-level notes, one child), so the
  // generated operations have something shared to collide on.
  for (const parent of [null, null, 0] as const) await runOp(world, { kind: "create", client: 0, parent, fate: "deliver" });
  for (const other of world.clients.slice(1)) await other.comeOnline([]);
  try {
    for (const op of ops) await runOp(world, op);
    await world.settle();
    await awaitAllDispatchers();
    await checkInvariants(world, WS, checks);
    return world;
  } catch (error) {
    if (error instanceof Error) error.message += await failureContext(world, WS);
    throw error;
  }
}

describe.skipIf(!isTestDatabase())("multi-device sync simulator (DB)", () => {
  const seed = Number(process.env.SYNC_SIM_SEED ?? 20261023);
  const numRuns = Number(process.env.SYNC_SIM_RUNS ?? 80);

  it(`keeps every saved line and converges (seed ${seed}, ${numRuns} runs)`, async () => {
    if (process.env.SYNC_SIM_REPLAY) {
      const ops = JSON.parse(process.env.SYNC_SIM_REPLAY) as Op[];
      console.log(plain(ops));
      await play(ops);
      return;
    }
    try {
      await fc.assert(
        fc.asyncProperty(fc.array(opArbitrary, { minLength: 6, maxLength: 36, size: "max" }), async (ops) => { await play(ops, { strictRetry: true, strictOccurrences: true, strictGradeOnce: true, strictUndo: true }); }),
        { seed, numRuns, path: process.env.SYNC_SIM_PATH, endOnFailure: false, interruptAfterTimeLimit: 8 * 60_000 },
      );
    } catch (error) {
      const failure = error as Error & { counterexample?: [Op[]] };
      console.error(`\n[sync-sim] FAILED. Replay: SYNC_SIM_SEED=${seed} SYNC_SIM_RUNS=${numRuns} (add SYNC_SIM_PATH from the report below)`);
      const ops = failure.counterexample?.[0];
      if (ops) console.error(`[sync-sim] shrunk operations:\n${plain(ops)}\n[sync-sim] as JSON for SYNC_SIM_REPLAY:\n${JSON.stringify(ops)}`);
      throw error;
    }
  }, 20 * 60_000);

  // The server documents (decisions-core-sync.md, "同一行並行輸入 F03／F04"): two additive edits at the same point both stay,
  // ordered by their text, "與先後存檔無關" — the result does not depend on which device's save arrives first.
  it("two additive edits at the same point end the same whichever device reconnects first", async () => {
    const bodyWhen = async (first: 0 | 1): Promise<string> => {
      const world = await play([
        { kind: "offline", client: 0 }, { kind: "offline", client: 1 },
        { kind: "edit", client: 0, note: 1, how: "insert", at: 0, fate: "deliver" },
        { kind: "edit", client: 1, note: 1, how: "insert", at: 0, fate: "deliver" },
        { kind: "online", client: first, fates: [] }, { kind: "online", client: first === 0 ? 1 : 0, fates: [] },
      ]);
      const id = [...world.ordinal].find(([, n]) => n === 2)![0]; // the second note created: "visible note #1"
      return (await serverNotes(WS, [id])).get(id)!.markdown;
    };
    expect(await bodyWhen(0)).toBe(await bodyWhen(1));
  }, 60_000);

  describe("fixed regression cases (shrunk sequences from earlier failures)", () => {
    for (const [name, c] of Object.entries(REGRESSIONS)) {
      (c.knownFailure && !process.env.SYNC_SIM_REPRO ? it.fails : it)(name, async () => { await play(c.ops, { strictRetry: c.strictRetry, strictOccurrences: c.strictOccurrences, strictUndo: c.strictUndo, strictGradeOnce: c.strictGradeOnce }); }, 60_000);
    }
  });
});
