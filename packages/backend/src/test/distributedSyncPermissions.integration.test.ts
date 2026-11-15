// Distributed sync step 2a, permission alignment (doc §5, §10-5, §11-2): for one set of situations the engine's roles
// (derived from genesis, which reads spaces / space_members) and the server's own gates must give the same answers.
//   read   readableScopeSql / readableAmong      vs  canRead(world)
//   write  assertAuthority(node, write_node)      vs  roleIn(world) === "edit"
// The situations: an editor, a viewer, a `suggest` member (stored permission added by migration 174), a person in no shared space,
// an agent, the workspace owner who manages a shared space without being a member of it, a deleted space, a trashed note, a tag.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { q } from "../db.js";
import { seedQ } from "./helpers/seedQ.js";
import { planGenesis } from "../distributedSync/bridge/index.js";
import { materialize, roleIn, canRead } from "../distributedSync/materialize.js";
import { assertAuthority } from "../spine/authority.js";
import { readableAmong } from "../services/readPolicy.js";
import { updateNode } from "../services/nodeUpdate.js";
import type { ActorCtx } from "../types.js";

describe.skipIf(!isTestDatabase())("the engine's roles equal the server's gates", () => {
  it("read and write answers agree for every person and every note", async () => {
    const ws = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Perm',$1) RETURNING id", [randomUUID()])).rows[0]!.id;
    const person = async (name: string, type: "human" | "agent" = "human") => (await q<ActorCtx>("INSERT INTO actors(workspace_id,name,type) VALUES($1,$2,$3) RETURNING id,name,type", [ws, name, type])).rows[0]!;
    const alice = await person("alice"); // the first human: the workspace owner
    const bob = await person("bob"), carol = await person("carol"), dave = await person("dave"), erin = await person("erin"), bot = await person("bot", "agent");
    const space = async (name: string, members: Array<[ActorCtx, "view" | "suggest" | "edit"]>) => {
      const id = (await seedQ<{ id: string }>("INSERT INTO spaces (workspace_id, name, kind, capabilities) VALUES ($1,$2,'shared','{\"external_ai\": true}'::jsonb) RETURNING id", [ws, name])).rows[0]!.id;
      for (const [a, permission] of members) await seedQ("INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1,$2,$3)", [id, a.id, permission]);
      return id;
    };
    const team = await space("team", [[alice, "edit"], [bob, "edit"], [carol, "view"], [dave, "suggest"], [bot, "view"]]);
    const secret = await space("secret", [[bob, "edit"]]); // the owner manages it without being in it
    const gone = await space("gone", [[alice, "edit"], [bob, "edit"]]);
    const note = async (title: string, spaceId: string, deleted = false) => {
      const id = randomUUID();
      await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id, deleted_at) VALUES ($1::uuid,$2,'manual','content',$3,$1::text,'x',$4,$5)`, [id, ws, title, spaceId, deleted ? new Date() : null]);
      return id;
    };
    const notes = [await note("t1", team), await note("t2", team, true), await note("s1", secret), await note("g1", gone), await note("p1", (await q<{ id: string }>("SELECT id FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'", [bob.id])).rows[0]!.id)];
    const tag = randomUUID();
    await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1,$2,'manual','class_tag','work','tag-work','')`, [tag, ws]);
    await seedQ("UPDATE spaces SET deleted_at = now() WHERE id = $1", [gone]);

    const plan = await planGenesis(ws);
    const world = materialize(plan.ops);
    expect([...world.verdicts.values()].filter((v) => !v.ok)).toEqual([]); // genesis is valid, every op of it
    expect(plan.skipped["content in a deleted space"]).toBe(1);

    const checked: string[] = [];
    for (const actor of [alice, bob, carol, dave, erin, bot]) {
      const readable = await readableAmong(actor, ws, [...notes, tag]);
      for (const id of [...notes, tag]) {
        const n = world.notes.get(id);
        if (!n) continue; // the note in the deleted space is not carried
        const live = !n.deleted;
        const engineRead = live && canRead(world, n.space, actor.id);
        expect(readable.has(id), `${actor.name} reads ${n.id.slice(0, 4)} (${n.title}): server ${readable.has(id)}, engine ${engineRead}`).toBe(engineRead);
        const engineWrite = roleIn(world, n.space, actor.id) === "edit" && live;
        let serverWrite = false;
        if (live) { try { await assertAuthority(actor, { kind: "node", nodeId: id, op: "write_node" }); serverWrite = true; } catch { serverWrite = false; } }
        expect(serverWrite, `${actor.name} writes ${n.title}: server ${serverWrite}, engine ${engineWrite}`).toBe(engineWrite);
        checked.push(`${actor.name}/${n.title}`);
      }
    }
    expect(checked.length).toBe(6 * 5); // 4 notes in live spaces (one trashed) + the tag, for 6 people
    // The stored `suggest` role reads but a real write by it is refused by the service itself.
    await expect(updateNode(ws, notes[0]!, { title: "dave edits" }, { actor: dave })).rejects.toThrow();
    expect((await q<{ title: string }>("SELECT title FROM content_nodes WHERE id = $1", [notes[0]])).rows[0]!.title).toBe("t1");
  });
});
