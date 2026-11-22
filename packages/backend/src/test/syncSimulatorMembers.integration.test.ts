// The sync simulator with several PEOPLE: device A is the workspace owner, device B an editing member and
// device C a view-only member of one shared space (the web client has no "suggestion" write: that is an
// agent's write_mode, so the member the product refuses is the view-only one). The owner can also remove a
// member or change a member's permission while that member's device is offline with queued writes.
// Same layer, replay and safety rules as syncSimulator.integration.test.ts; read its header first.
//   SYNC_SIM_MEMBERS_RUNS=<n> (default 40), SYNC_SIM_SEED, SYNC_SIM_PATH, SYNC_SIM_REPLAY as there.
// Each run gets a workspace of its own (people, space, notes), because a person's readable set would
// otherwise grow with every earlier run. Devices send who they are in `x-sim-user`, which the mocked
// session lookup turns into the person's login.
import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { persistActor } from "./helpers/persistActor.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import { SimServer } from "./helpers/syncSim/server.js";
import { World, opArbitraryMembers, runOp, type Op } from "./helpers/syncSim/ops.js";
import { checkInvariants, type Checks } from "./helpers/syncSim/invariants.js";
import { CLIENT_PROTOCOL, CLIENT_PROTOCOL_HEADER } from "@onden/markdown";
import { plain, failureContext } from "./helpers/syncSim/harness.js";
import { MEMBER_REGRESSIONS } from "./helpers/syncSim/regressions.js";
import { ensureConfigNode } from "./helpers/siteConfigFixture.js";

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: {
      getSession: vi.fn(async ({ headers }: { headers: Headers }) => {
        const login = headers.get("x-sim-user");
        return login ? { user: { id: login, email: `${login}@sim.test`, name: login } } : null;
      }),
    },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));
const { app } = await import("../app.js");

/** A workspace with an owner, an editing member and a view-only member, and a shared space they all belong to. */
async function freshWorld(): Promise<World> {
  WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Sync simulator members', $1) RETURNING id::text`, [`simm-${randomUUID()}`])).rows[0]!.id;
  await ensureConfigNode(WS);
  const people: Array<{ id: string; login: string }> = [];
  for (const [i, role] of (["admin", "editor", "viewer"] as const).entries()) {
    const login = `sim-person-${i}-${randomUUID().slice(0, 8)}`;
    const actor = await persistActor(WS, { id: "", name: login, role, type: "human" });
    await q(`UPDATE actors SET external_id = $2 WHERE id = $1`, [actor.id, login]);
    people.push({ id: actor.id, login });
  }
  await setWorkspaceOwner(WS, people[0]!.id);
  // The default space is not part of this scenario: only the shared one is.
  await q(`DELETE FROM space_members WHERE actor_id = ANY($1::uuid[]) AND space_id IN (SELECT id FROM spaces WHERE workspace_id = $2 AND is_default)`, [people.map((p) => p.id), WS]);
  const server = new SimServer(app);
  const asOwner = { "x-sim-user": people[0]!.login, [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL) };
  const made = await server.call("POST", "/api/spaces", { name: "shared" }, asOwner);
  expect(made.status).toBe(201);
  const spaceId = (made.body as { id: string }).id;
  for (const [i, permission] of [[1, "edit"], [2, "view"]] as const) {
    expect((await server.call("PUT", `/api/spaces/${spaceId}/members/${people[i]!.id}`, { permission }, asOwner)).status).toBe(200);
  }
  const tagIds: string[] = [];
  for (const name of ["sim-a", "sim-b"]) {
    const tag = await server.call("POST", "/api/tags", { name: `${name}-${randomUUID().slice(0, 8)}`, id: randomUUID() }, asOwner);
    expect(tag.status).toBe(201);
    tagIds.push((tag.body as { id: string }).id);
  }
  const world = new World(server, spaceId, tagIds, "0");
  world.people = people.map((p) => p.id);
  world.clients.forEach((c, i) => { c.headers = { "x-sim-user": people[i]!.login, [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL) }; /* the page says which protocol it speaks (clientGate.ts) */ c.membershipAware = true; });
  return world;
}

async function play(ops: Op[], checks: Checks = {}, membershipFaults = false): Promise<void> {
  const world = await freshWorld();
  world.clients.forEach((c) => { c.membershipFaults = membershipFaults; });
  try {
    // The owner starts with a small tree; the members' devices pull it.
    for (const parent of [null, null, 0] as const) await runOp(world, { kind: "create", client: 0, parent, fate: "deliver" });
    for (const other of world.clients.slice(1)) await other.comeOnline([]);
    for (const op of ops) await runOp(world, op);
    await world.settle();
    await awaitAllDispatchers();
    const members = await q<{ actor_id: string }>(`SELECT actor_id::text FROM space_members WHERE space_id = $1`, [world.spaceId]);
    world.readers = new Set(world.clients.filter((_, i) => members.rows.some((m) => m.actor_id === world.people![i])).map((c) => c.name));
    await checkInvariants(world, WS, checks);
  } catch (error) {
    if (error instanceof Error) error.message += await failureContext(world, WS);
    throw error;
  }
}

describe.skipIf(!isTestDatabase())("members sync simulator (DB)", () => {
  const seed = Number(process.env.SYNC_SIM_SEED ?? 20261109);
  const numRuns = Number(process.env.SYNC_SIM_MEMBERS_RUNS ?? process.env.SYNC_SIM_RUNS ?? 40);

  it(`holds the member rules and converges (seed ${seed}, ${numRuns} runs)`, async () => {
    if (process.env.SYNC_SIM_REPLAY) {
      const ops = JSON.parse(process.env.SYNC_SIM_REPLAY) as Op[];
      console.log(plain(ops));
      await play(ops);
      return;
    }
    try {
      await fc.assert(
        fc.asyncProperty(fc.array(opArbitraryMembers, { minLength: 6, maxLength: 36, size: "max" }), async (ops) => { await play(ops, { strictRetry: true, strictOccurrences: true, strictGradeOnce: true, strictUndo: true }); }),
        { seed, numRuns, path: process.env.SYNC_SIM_PATH, endOnFailure: false, interruptAfterTimeLimit: 8 * 60_000 },
      );
    } catch (error) {
      const failure = error as Error & { counterexample?: [Op[]] };
      console.error(`\n[sync-sim members] FAILED. Replay: SYNC_SIM_SEED=${seed} SYNC_SIM_MEMBERS_RUNS=${numRuns} (add SYNC_SIM_PATH from the report below)`);
      const ops = failure.counterexample?.[0];
      if (ops) console.error(`[sync-sim members] shrunk operations:\n${plain(ops)}\n[sync-sim members] as JSON for SYNC_SIM_REPLAY:\n${JSON.stringify(ops)}`);
      throw error;
    }
  }, 20 * 60_000);

  describe("fixed regression cases (members)", () => {
    for (const [name, c] of Object.entries(MEMBER_REGRESSIONS)) {
      (c.knownFailure && !process.env.SYNC_SIM_REPRO ? it.fails : it)(name, async () => { await play(c.ops, { strictRetry: c.strictRetry, strictOccurrences: c.strictOccurrences, strictUndo: c.strictUndo, strictGradeOnce: c.strictGradeOnce }, c.membershipFaults); }, 60_000);
    }
  });
});
