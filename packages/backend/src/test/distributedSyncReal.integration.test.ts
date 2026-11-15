// Distributed sync step 2a: two COMPLETE backends (real services, real tables) syncing one workspace through the engine.
// Writes go through the real services of one node; the other node receives ops and projects them through its own services.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 300_000 });
import { randomUUID } from "node:crypto";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { q } from "../db.js";
import { createSharedSpace, setMember } from "../services/spaces.js";
import { createNote } from "../services/noteCreate.js";
import { updateNode } from "../services/nodeUpdate.js";
import { createTag } from "../services/tagHierarchy.js";
import { applyTagToNode } from "../services/tagMembershipWrites.js";
import { trashNode } from "../services/nodeTrash.js";
import type { ActorCtx } from "../types.js";
import { RealCluster } from "./helpers/distSim/realCluster.js";

const enabled = process.env.ONDEN_DB_DRIVER === "pglite" && isTestDatabase();
type World = { ws: string; alice: ActorCtx; bob: ActorCtx; carol: ActorCtx; team: string; notes: string[]; tag: string };
let w: World;

async function seedWorld(): Promise<string> {
  const ws = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Sync',$1) RETURNING id", [randomUUID()])).rows[0]!.id;
  const person = async (name: string) => (await q<ActorCtx>("INSERT INTO actors(workspace_id,name,type) VALUES($1,$2,'human') RETURNING id,name,type", [ws, name])).rows[0]!;
  const alice = await person("alice"), bob = await person("bob"), carol = await person("carol");
  const team = (await createSharedSpace(alice, ws, "team")).id;
  await setMember(alice, ws, team, bob.id, "edit");
  await setMember(alice, ws, team, carol.id, "view");
  const tag = (await createTag({ actor: alice, workspaceId: ws, name: "work" })).id;
  const notes: string[] = [];
  for (const [title, body] of [["Plan", "one\ntwo\nthree\nfour\nfive"], ["Ideas", "x\ny\nz"], ["Log", ""]] as const) {
    notes.push((await createNote({ actor: alice, workspaceId: ws, title, markdown: body, spaceId: team, event: { uiContext: "seed" } })).node.id);
  }
  w = { ws, alice, bob, carol, team, notes, tag };
  return ws;
}

describe.skipIf(!enabled)("two real backends", () => {
  let cluster: RealCluster | null = null;
  beforeAll(() => { process.env.ONDEN_DISTRIBUTED_SYNC = "1"; });
  afterEach(async () => { await cluster?.close(); cluster = null; });

  it("start in step (same genesis), then a write on one node reaches the other through its own services", async () => {
    cluster = await RealCluster.create(["A", "B"], seedWorld);
    expect(await cluster.checkConverged()).toEqual([]);
    const opsA = await cluster.ops("A"), opsB = await cluster.ops("B");
    expect(JSON.stringify(opsA)).toBe(JSON.stringify(opsB)); // identical genesis on both copies

    await cluster.on("A", () => updateNode(w.ws, w.notes[0]!, { title: "Plan v2", markdown: "one\ntwo\nthree\nfour\nfive\nsix" }, { actor: w.alice }));
    await cluster.quiesce();
    expect(await cluster.checkConverged()).toEqual([]);
    const title = await cluster.on("B", async () => (await q<{ title: string; markdown: string }>("SELECT title, markdown FROM content_nodes WHERE id = $1", [w.notes[0]])).rows[0]);
    expect(title).toEqual({ title: "Plan v2", markdown: "one\ntwo\nthree\nfour\nfive\nsix" });
  });

  const body = (id: string) => cluster!.on("B", async () => (await q<{ markdown: string }>("SELECT markdown FROM content_nodes WHERE id = $1", [id])).rows[0]?.markdown);
  const bodyOn = (node: string, id: string) => cluster!.on(node, async () => (await q<{ markdown: string; title: string; deleted_at: unknown; parent_id: string | null }>("SELECT markdown, title, deleted_at, parent_id FROM content_nodes WHERE id = $1", [id])).rows[0]);

  it("offline edits to different lines of one note both survive; the same line keeps the later one and the other stays on the note's record", async () => {
    cluster = await RealCluster.create(["A", "B"], seedWorld);
    const [plan] = w.notes;
    await cluster.on("A", () => updateNode(w.ws, plan!, { markdown: "ONE\ntwo\nthree\nfour\nfive" }, { actor: w.alice }));
    await cluster.on("B", () => updateNode(w.ws, plan!, { markdown: "one\ntwo\nthree\nfour\nFIVE" }, { actor: w.bob }));
    await cluster.quiesce();
    expect(await cluster.checkConverged()).toEqual([]);
    expect((await bodyOn("A", plan!))!.markdown).toBe("ONE\ntwo\nthree\nfour\nFIVE");
    expect((await bodyOn("B", plan!))!.markdown).toBe("ONE\ntwo\nthree\nfour\nFIVE");

    await cluster.on("A", () => updateNode(w.ws, plan!, { markdown: "ONE\ntwo\nA says\nfour\nFIVE" }, { actor: w.alice }));
    await cluster.on("B", () => updateNode(w.ws, plan!, { markdown: "ONE\ntwo\nB says\nfour\nFIVE" }, { actor: w.bob }));
    await cluster.quiesce();
    expect(await cluster.checkConverged()).toEqual([]);
    const a = (await bodyOn("A", plan!))!.markdown;
    expect(a === "ONE\ntwo\nA says\nfour\nFIVE" || a === "ONE\ntwo\nB says\nfour\nFIVE").toBe(true);
    expect((await bodyOn("B", plan!))!.markdown).toBe(a);
    const world = await cluster.on("A", async () => cluster!.node("A").replica.node.world());
    expect(world.notes.get(plan!)!.conflicts.length).toBe(1);
  });

  it("two moves that would make a cycle: the earlier one holds on every node", async () => {
    cluster = await RealCluster.create(["A", "B"], seedWorld);
    const [x, y] = w.notes;
    await cluster.on("A", () => updateNode(w.ws, x!, { parent_id: y! }, { actor: w.alice }));
    await cluster.on("B", () => updateNode(w.ws, y!, { parent_id: x! }, { actor: w.bob }));
    await cluster.quiesce();
    expect(await cluster.checkConverged()).toEqual([]);
    const [ax, ay, bx, by] = [await bodyOn("A", x!), await bodyOn("A", y!), await bodyOn("B", x!), await bodyOn("B", y!)];
    expect([ax!.parent_id, ay!.parent_id]).toEqual([bx!.parent_id, by!.parent_id]);
    expect(ax!.parent_id === y || ay!.parent_id === x).toBe(true);
    expect(ax!.parent_id === y && ay!.parent_id === x).toBe(false);
  });

  it("a revocation that arrives late: edits made before it stand, edits after it are void, on both nodes alike", async () => {
    cluster = await RealCluster.create(["A", "B"], seedWorld);
    const [plan, ideas] = w.notes;
    await cluster.on("B", () => updateNode(w.ws, ideas!, { title: "bob before" }, { actor: w.bob }));   // earlier clock
    await cluster.on("A", () => setMember(w.alice, w.ws, w.team, w.bob.id, null));                   // revoke
    await cluster.on("B", () => updateNode(w.ws, plan!, { title: "bob after" }, { actor: w.bob }));  // B has not heard of the revocation
    await cluster.quiesce();
    expect(await cluster.checkConverged()).toEqual([]);
    for (const n of ["A", "B"]) {
      expect((await bodyOn(n, ideas!))!.title).toBe("bob before");
      expect((await bodyOn(n, plan!))!.title).toBe("Plan");
    }
    const members = await cluster.on("B", async () => (await q<{ actor_id: string }>("SELECT actor_id FROM space_members WHERE space_id = $1", [w.team])).rows.map((r) => r.actor_id));
    expect(members).not.toContain(w.bob.id);
  });

  it("tags: applied on one node, removed on the other, a new tag and its name clash", async () => {
    cluster = await RealCluster.create(["A", "B"], seedWorld);
    const [plan] = w.notes;
    await cluster.on("A", () => applyTagToNode({ workspaceId: w.ws, actor: w.alice, nodeId: plan!, tagId: w.tag }));
    await cluster.on("A", () => createTag({ actor: w.alice, workspaceId: w.ws, name: "idea" }));
    await cluster.on("B", () => createTag({ actor: w.alice, workspaceId: w.ws, name: "idea" }));
    await cluster.quiesce();
    expect(await cluster.checkConverged()).toEqual([]);
    const names = (id: string) => cluster!.on(id, async () => (await q<{ title: string }>("SELECT title FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND title LIKE 'idea%' ORDER BY title", [w.ws])).rows.map((r) => r.title));
    expect(await names("A")).toEqual(["idea", "idea (2)"]);
    expect(await names("B")).toEqual(["idea", "idea (2)"]);
  });

  it("delete on one node, restore of another note, same title created on both", async () => {
    cluster = await RealCluster.create(["A", "B"], seedWorld);
    const [, ideas, log] = w.notes;
    await cluster.on("A", () => trashNode(w.alice, w.ws, ideas!));
    for (const n of ["A", "B"]) await cluster.on(n, () => createNote({ actor: w.alice, workspaceId: w.ws, title: "Same title", markdown: `from ${n}`, spaceId: w.team, event: { uiContext: "t" } }));
    await cluster.on("B", () => updateNode(w.ws, log!, { markdown: "log entry" }, { actor: w.bob }));
    await cluster.quiesce();
    expect(await cluster.checkConverged()).toEqual([]);
    expect((await bodyOn("B", ideas!))!.deleted_at).not.toBeNull();
    const same = (id: string) => cluster!.on(id, async () => (await q<{ slug: string }>("SELECT slug FROM content_nodes WHERE workspace_id = $1 AND title = 'Same title' AND deleted_at IS NULL", [w.ws])).rows.map((r) => r.slug).sort());
    expect(await same("A")).toHaveLength(2);
    expect(new Set(await same("A")).size).toBe(2);
    expect(new Set(await same("B")).size).toBe(2);
  });

  it("a node that loses power and restarts from disk keeps its sequence and goes on syncing", async () => {
    cluster = await RealCluster.create(["A", "B"], seedWorld);
    const [plan] = w.notes;
    await cluster.on("B", () => updateNode(w.ws, plan!, { title: "before restart" }, { actor: w.bob }));
    await cluster.on("B", async () => { await cluster!.node("B").node.restart(); });
    await cluster.reopen("B");
    await cluster.on("B", () => updateNode(w.ws, plan!, { markdown: "after restart" }, { actor: w.bob }));
    await cluster.quiesce();
    expect(await cluster.checkConverged()).toEqual([]);
    const fromB = (await cluster.ops("A")).filter((o) => o.origin === "B").map((o) => o.seq);
    expect(fromB).toEqual([1, 2, 3].slice(0, fromB.length)); // no gap, no reuse
    expect((await bodyOn("A", plan!))).toMatchObject({ title: "before restart", markdown: "after restart" });
  });
});
