// Events are append-only: after migration 201 an event written before it still names the OLD id of a capture tag or a space.
// Undoing it must land on the row as it is now (services/idRewrites.ts follows id_rewrites), not be refused or fail on an id nothing has.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { derivedIdName } from "@onden/markdown";
import { pool, q } from "../db.js";

let ws = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
import { createNote } from "../services/noteCreate.js";
import { listNoteVersions } from "../services/history/noteVersions.js";
import { updateNode } from "../services/nodeUpdate.js";
import { derivedId } from "../services/derivedIds.js";
import { restoreEvent } from "../services/eventRestore/restore.js";
import { moveToSpace } from "../services/spaces.js";
import { applyTagToNode, removeTagFromNode } from "../services/tagMembershipWrites.js";
import { trashNode } from "../services/nodeTrash.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { rerunMigration } from "./helpers/rerunMigration.js";
import { seedQ } from "./helpers/seedQ.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

describe.skipIf(!isTestDatabase())("undoing history that was written before migration 201", () => {
  const tag = randomUUID().slice(0, 8);
  let owner!: ActorCtx;
  const oldCapture = randomUUID();
  const oldDefault = randomUUID();
  let note = "";
  let other = "";
  let moveEvent = "";
  let tagEvent = "";
  let untagEvent = "";
  let deleteEvent = "";
  let second = "";

  const event = async (type: string, target: string) => (await q<{ id: string }>(
    `SELECT e.id::text AS id FROM domain_events e WHERE e.workspace_id = $1 AND e.event_type = $2 AND e.target_id = $3 ORDER BY e.id DESC LIMIT 1`, [ws, type, target])).rows[0]!.id;

  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Derived history', $1) RETURNING id::text`, [`derived-history-${tag}`])).rows[0]!.id;
    owner = await persistActor(ws, { id: "", name: `Owner ${tag}`, role: "admin", type: "human" });
    await setWorkspaceOwner(ws, owner.id);
    // the default space under the id an older server gave it
    const current = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [ws])).rows[0]!.id;
    const members = (await q<{ actor_id: string; permission: string }>(`SELECT actor_id::text, permission FROM space_members WHERE space_id = $1`, [current])).rows;
    await seedQ(`DELETE FROM space_members WHERE space_id = $1`, [current]);
    await seedQ(`UPDATE spaces SET id = $2 WHERE id = $1`, [current, oldDefault]);
    for (const m of members) await seedQ(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, $3)`, [oldDefault, m.actor_id, m.permission]);
    other = await makeSpace(ws, `Other ${tag}`, [{ id: owner.id, permission: "edit" }]);
    await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, tag_schema) VALUES ($1, $2, 'manual', 'class_tag', $3, $4, '', $5::jsonb)`,
      [oldCapture, ws, `收件匣${tag}`, `module-${oldCapture}`, JSON.stringify({ module: "capture" })]);
    // its description saved once (a tag has versions since migration 231): a version, its position and the event mapped to it, under the old id
    await updateNode(ws, oldCapture, { markdown: `what lands here ${tag}\n` }, { actor: owner });

    const made = await createNote({ actor: owner, workspaceId: ws, title: `Captured ${tag}`, markdown: "x\n", spaceId: oldDefault, event: { uiContext: "test" } });
    note = made.node.id;
    await applyTagToNode({ workspaceId: ws, actor: owner, nodeId: note, tagId: oldCapture });
    tagEvent = await event("TAG_APPLIED", note);
    await moveToSpace(owner, ws, note, other, null);
    moveEvent = await event("NODE_MOVED_SPACE", note);
    // a second note, in the old default space: tagged and untagged, then deleted — all before the rewrite
    second = (await createNote({ actor: owner, workspaceId: ws, title: `Second ${tag}`, markdown: "y\n", spaceId: oldDefault, event: { uiContext: "test" } })).node.id;
    await applyTagToNode({ workspaceId: ws, actor: owner, nodeId: second, tagId: oldCapture });
    await removeTagFromNode({ workspaceId: ws, actor: owner, nodeId: second, tagId: oldCapture });
    untagEvent = await event("TAG_REMOVED", second);
    await trashNode(owner, ws, second);
    deleteEvent = await event("NODE_DELETED", second);
    await moveToSpace(owner, ws, note, oldDefault, null); // back, so the undo below has something to do after the migration
    await rerunMigration("201_derived_ids_function_ref_stamps");
    await moveToSpace(owner, ws, note, other, null);
  }, 60_000);
  afterAll(async () => { await pool.end(); });

  it("the migration recorded the old -> new ids", async () => {
    const rows = (await q<{ old_id: string; new_id: string }>(`SELECT old_id::text, new_id::text FROM id_rewrites WHERE workspace_id = $1`, [ws])).rows;
    expect(Object.fromEntries(rows.map((r) => [r.old_id, r.new_id]))).toMatchObject({
      [oldCapture]: derivedId(derivedIdName.moduleTag(ws, "capture")),
      [oldDefault]: derivedId(derivedIdName.defaultSpace(ws)),
    });
  });

  it("the tag's saved description is still in its history, under its new id", async () => {
    const versions = await listNoteVersions(ws, owner, derivedId(derivedIdName.moduleTag(ws, "capture")), { raw: true });
    expect(versions?.length, JSON.stringify(versions)).toBe(1);
    expect(await listNoteVersions(ws, owner, oldCapture, { raw: true })).toBeNull(); // nothing is left under the old one
  });

  it("undoing an earlier space move puts the note back in the space as it is now (under its new id)", async () => {
    const before = (await q<{ space_id: string }>(`SELECT space_id::text FROM content_nodes WHERE id = $1`, [note])).rows[0]!.space_id;
    expect(before).toBe(other);
    const result = await restoreEvent(moveEvent, { actor: owner, workspaceId: ws });
    expect(result, JSON.stringify(result)).toMatchObject({ restored: true });
    expect((await q<{ space_id: string }>(`SELECT space_id::text FROM content_nodes WHERE id = $1`, [note])).rows[0]!.space_id).toBe(derivedId(derivedIdName.defaultSpace(ws)));
  });

  it("undoing an earlier tag change works on the tag under its new id", async () => {
    const newTag = derivedId(derivedIdName.moduleTag(ws, "capture"));
    expect((await q(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [note, newTag])).rows).toHaveLength(1);
    const result = await restoreEvent(tagEvent, { actor: owner, workspaceId: ws });
    expect(result, JSON.stringify(result)).toMatchObject({ restored: true });
    expect((await q(`SELECT 1 FROM node_tags WHERE node_id = $1`, [note])).rows).toHaveLength(0);
  });

  it("undoing a tag removal and then the deletion of a note that sat in the old default space: both are correct restores", async () => {
    // (one test, in this order: the note is deleted last, and a tag cannot be put back on a deleted note)
    const untagged = await restoreEvent(untagEvent, { actor: owner, workspaceId: ws });
    expect(untagged, JSON.stringify(untagged)).toMatchObject({ restored: true });
    expect((await q(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [second, derivedId(derivedIdName.moduleTag(ws, "capture"))])).rows).toHaveLength(1);
    const undeleted = await restoreEvent(deleteEvent, { actor: owner, workspaceId: ws });
    expect(undeleted, JSON.stringify(undeleted)).toMatchObject({ restored: true });
    expect((await q<{ deleted_at: string | null }>(`SELECT deleted_at FROM content_nodes WHERE id = $1`, [second])).rows[0]!.deleted_at).toBeNull();
  });
});
