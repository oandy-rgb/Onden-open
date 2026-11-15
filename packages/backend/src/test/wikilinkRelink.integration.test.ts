// D61: a backlink is the same whichever side saved last. Outgoing wikilink
// edges follow the source's save (syncWikilinkEdges); the edges INTO a note
// follow what names it — its title, slug and aliases, its space, its return
// from the trash — through relinkTarget, with the same matching rule.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { createNote } from "../services/noteCreate.js";
import { updateNode } from "../services/nodeUpdate.js";
import { recordAttributeChange } from "../services/attributeChange.js";
import { trashNode, undeleteNode } from "../services/nodeTrash.js";
import { moveToSpace } from "../services/spaces.js";
import { updateTagIdentity } from "../services/tagIdentity.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
let workspaceId = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));

describe.skipIf(!isTestDb)("wikilink edges into a note follow what names it (D61)", () => {
  let actor: ActorCtx = { id: "relink-admin", name: "Relinker", role: "admin", type: "human" };
  let spaceA = "";
  let spaceB = "";

  const note = async (title: string, markdown: string, spaceId = spaceA) =>
    (await createNote({ actor, workspaceId, title, markdown, spaceId, event: { uiContext: "test.relink" } })).node.id as string;
  const incoming = async (id: string) => (await q<{ source_node_id: string }>(
    `SELECT source_node_id::text FROM node_edges WHERE target_node_id = $1 AND origin = 'wikilink' ORDER BY source_node_id`, [id],
  )).rows.map((r) => r.source_node_id);
  const sorted = (...ids: string[]) => [...ids].sort();
  const stamp = () => randomUUID().replace(/-/g, "").slice(0, 8);
  const epoch = async () =>
    (await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [workspaceId])).rows[0]!.e;

  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Relink', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
    spaceA = await makeSpace(workspaceId, `A ${stamp()}`, [{ id: actor.id, role: "manager" }]);
    spaceB = await makeSpace(workspaceId, `B ${stamp()}`, [{ id: actor.id, role: "manager" }]);
  });

  it("a rename drops the old name's backlinks and wires the new name's", async () => {
    const s = stamp();
    const plan = await note(`Plan ${s}`, "the plan");
    const x = await note(`X ${s}`, `see [[Plan ${s}]]`);
    const y = await note(`Y ${s}`, `see [[Roadmap ${s}]] (not written yet)`);
    const other = await note(`Elsewhere ${s}`, `see [[Roadmap ${s}]]`, spaceB);
    expect(await incoming(plan)).toEqual([x]);

    await updateNode(workspaceId, plan, { title: `Roadmap ${s}` }, { actor });
    // X still says [[Plan …]]: no longer this note. Y named it before it had
    // the name; the note in another space never reaches it.
    expect(await incoming(plan)).toEqual([y]);
    expect(await incoming(plan)).not.toContain(other);
    // Y's link by the slug form survives a case change of the title.
    await updateNode(workspaceId, plan, { title: `ROADMAP ${s}` }, { actor });
    expect(await incoming(plan)).toEqual([y]);
  });

  it("an alias added later wires [[alias]] links; removing it drops them", async () => {
    const s = stamp();
    const mp = await note(`Mega Project ${s}`, "");
    const z = await note(`Z ${s}`, `ship [[MP${s}]] soon`);
    const prose = await note(`Prose ${s}`, `MP${s} without brackets`);
    expect(await incoming(mp)).toEqual([]);

    await recordAttributeChange({
      workspaceId, nodeId: mp, key: "aliases", actor, next: { value: JSON.stringify([`mp${s}`]) },
      rule: "always", authority: { kind: "node", nodeId: mp, op: "write_node" }, uiContext: "test.relink",
    });
    expect(await incoming(mp)).toEqual([z]);
    expect(await incoming(mp)).not.toContain(prose);

    await recordAttributeChange({
      workspaceId, nodeId: mp, key: "aliases", actor, next: null,
      rule: "always", authority: { kind: "node", nodeId: mp, op: "write_node" }, uiContext: "test.relink",
    });
    expect(await incoming(mp)).toEqual([]);
  });

  it("a new note gets backlinks from links naming its slug, not only its title", async () => {
    const s = stamp();
    const bySlug = await note(`Slug linker ${s}`, `next: [[my-plan-${s}]]`);
    const byForm = await note(`Form linker ${s}`, `next: [[  My   PLAN ${s}! |shown]]`);
    const byTitle = await note(`Title linker ${s}`, `next: [[my plan ${s}#Goals]]`);
    const otherSpace = await note(`Far linker ${s}`, `next: [[my-plan-${s}]]`, spaceB);
    const myPlan = await note(`My Plan ${s}`, "");
    expect((await q<{ slug: string }>(`SELECT slug FROM content_nodes WHERE id = $1`, [myPlan])).rows[0]!.slug).toBe(`my-plan-${s}`);
    expect(await incoming(myPlan)).toEqual(sorted(bySlug, byForm, byTitle));
    expect(await incoming(myPlan)).not.toContain(otherSpace);
  });

  it("a space move re-links the moved note in its new space", async () => {
    const s = stamp();
    const target = await note(`Mover ${s}`, "", spaceB);
    const fromA = await note(`A linker ${s}`, `[[Mover ${s}]]`);
    const fromB = await note(`B linker ${s}`, `[[Mover ${s}]]`, spaceB);
    expect(await incoming(target)).toEqual([fromB]);
    await moveToSpace(actor, workspaceId, target, spaceA, await epoch());
    expect(await incoming(target)).toEqual([fromA]);
  });

  it("a tag is linkable from every space, and its rename re-links all of them", async () => {
    const s = stamp();
    const tag = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1, 'manual', 'class_tag', $2, $3, '') RETURNING id::text`,
      [workspaceId, `reading${s}`, `tag-reading${s}`],
    )).rows[0]!.id;
    const old = await note(`Old ${s}`, `[[reading${s}]]`, spaceB);
    const a = await note(`Tag A ${s}`, `[[study${s}]]`);
    const b = await note(`Tag B ${s}`, `[[Study${s}]]`, spaceB);
    expect(await incoming(tag)).toEqual([old]);
    await updateTagIdentity(actor, workspaceId, tag, async () => ({ name: `study${s}` }));
    expect(await incoming(tag)).toEqual(sorted(a, b));
  });

  it("a note back from the trash gets the links written while it was there", async () => {
    const s = stamp();
    const ghost = await note(`Ghost ${s}`, `back to [[Haunt ${s}]]`);
    const before = await note(`Before ${s}`, `[[Ghost ${s}]]`);
    expect(await incoming(ghost)).toEqual([before]);
    await trashNode(actor, workspaceId, ghost);
    // Written while the target is in the trash: it names nothing yet, and the
    // target's own link outlived the note it names (Haunt is made meanwhile).
    const during = await note(`During ${s}`, `[[ghost ${s}]]`);
    const haunt = await note(`Haunt ${s}`, "");
    expect(await incoming(ghost)).toEqual([before]);
    await undeleteNode(actor, workspaceId, ghost);
    expect(await incoming(ghost)).toEqual(sorted(before, during));
    expect(await incoming(haunt)).toEqual([ghost]);
  });
});
