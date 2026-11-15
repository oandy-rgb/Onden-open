// withReplicatedOp (spine/replicatedOp.ts) lets the author of an op the sync engine already judged valid pass the space and node
// checks. This proves the path is not a general back door: without an engine verdict nothing gets through, and a verdict covers
// only its own author. Doc: docs/architecture/distributed-sync.md §12 (review point 1).
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { q } from "../db.js";
import { seedQ } from "./helpers/seedQ.js";
import { updateNode } from "../services/nodeUpdate.js";
import { withReplicatedOp } from "../spine/replicatedOp.js";
import { Replica } from "../distributedSync/bridge/index.js";
import { ensureConfigNode } from "./helpers/siteConfigFixture.js";
import { reservedTagId, RESERVED_TAGS } from "../services/reservedTags.js";
import { applyTagToNode } from "../services/tagMembershipWrites.js";
import type { ActorCtx } from "../types.js";

describe.skipIf(process.env.ONDEN_DB_DRIVER !== "pglite" || !isTestDatabase())("a validated replicated op is the only way through", () => {
  it("viewer is refused normally, passes only as the named author, only inside the scope, and never as someone else or a token", async () => {
    const ws = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Rep',$1) RETURNING id", [randomUUID()])).rows[0]!.id;
    const person = async (name: string) => (await q<ActorCtx>("INSERT INTO actors(workspace_id,name,type) VALUES($1,$2,'human') RETURNING id,name,type", [ws, name])).rows[0]!;
    await person("owner");
    const viewer = await person("viewer"), other = await person("other");
    const space = (await seedQ<{ id: string }>("INSERT INTO spaces (workspace_id, name, kind) VALUES ($1,'team','shared') RETURNING id", [ws])).rows[0]!.id;
    await seedQ("INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1,$2,'view')", [space, viewer.id]);
    await seedQ("INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1,$2,'view')", [space, other.id]);
    const note = randomUUID();
    await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id) VALUES ($1::uuid,$2,'manual','content','n',$1::text,'x',$3)`, [note, ws, space]);
    const edit = (actor: ActorCtx, title: string) => updateNode(ws, note, { title }, { actor });
    const title = async () => (await q<{ title: string }>("SELECT title FROM content_nodes WHERE id = $1", [note])).rows[0]!.title;

    await expect(edit(viewer, "no verdict")).rejects.toBeTruthy();                                              // no engine verdict
    await expect(withReplicatedOp({ opId: "op1", authorId: other.id }, () => edit(viewer, "wrong author"))).rejects.toBeTruthy(); // verdict is for someone else
    await expect(withReplicatedOp({ opId: "op1", authorId: viewer.id }, () => edit({ ...viewer, tokenScope: { access: "write" } } as ActorCtx, "token"))).rejects.toBeTruthy(); // a token never rides on it
    expect(await title()).toBe("n");
    await withReplicatedOp({ opId: "op1", authorId: viewer.id }, () => edit(viewer, "validated"));              // the named author, inside the scope
    expect(await title()).toBe("validated");
    await expect(edit(viewer, "after the scope")).rejects.toBeTruthy();                                         // the scope ended
    expect(await title()).toBe("validated");
  });

  it("with the feature off the projection cannot be reached: no replica opens", async () => {
    const was = process.env.ONDEN_DISTRIBUTED_SYNC;
    delete process.env.ONDEN_DISTRIBUTED_SYNC;
    try { await expect(Replica.open({ workspaceId: randomUUID(), nodeId: "x" })).rejects.toThrow(); }
    finally { if (was !== undefined) process.env.ONDEN_DISTRIBUTED_SYNC = was; }
  });
});

// The engine models spaces and members, not the workspace settings: a replayed op still needs the owner for the config node and
// the config tag (spine/authority.ts assertReplicatedConfig), or an editor on another node could rewrite the settings through sync.
describe.skipIf(!isTestDatabase())("a replayed op does not reach the workspace settings", () => {
  it("an editor is refused on the config node and the config tag while replaying; the owner is not", async () => {
    const ws = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('RepCfg',$1) RETURNING id", [randomUUID()])).rows[0]!.id;
    const person = async (name: string) => (await q<ActorCtx>("INSERT INTO actors(workspace_id,name,type) VALUES($1,$2,'human') RETURNING id,name,type", [ws, name])).rows[0]!;
    const owner = await person("owner"), bob = await person("bob");
    const space = (await seedQ<{ id: string }>("INSERT INTO spaces (workspace_id, name, kind) VALUES ($1,'team','shared') RETURNING id", [ws])).rows[0]!.id;
    await seedQ("INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1,$2,'edit'),($1,$3,'edit')", [space, owner.id, bob.id]);
    const note = randomUUID();
    await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id) VALUES ($1::uuid,$2,'manual','content','n',$1::text,'x',$3)`, [note, ws, space]);
    const configNode = await ensureConfigNode(ws);
    const configTag = (await reservedTagId(ws, RESERVED_TAGS.config))!;
    const tagAs = (a: ActorCtx) => applyTagToNode({ workspaceId: ws, actor: a, nodeId: note, tagId: configTag });
    const renameAs = (a: ActorCtx) => updateNode(ws, configNode, { title: "renamed" }, { actor: a });

    await expect(withReplicatedOp({ opId: "c1", authorId: bob.id }, () => tagAs(bob))).rejects.toThrow(/workspace settings/);
    await expect(withReplicatedOp({ opId: "c2", authorId: bob.id }, () => renameAs(bob))).rejects.toThrow(/workspace settings/);
    await withReplicatedOp({ opId: "c3", authorId: owner.id }, () => renameAs(owner));
    expect((await q<{ title: string }>("SELECT title FROM content_nodes WHERE id = $1", [configNode])).rows[0]!.title).toBe("renamed");
  });
});
