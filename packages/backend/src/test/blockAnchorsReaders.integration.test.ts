// Batch 0 acceptance (docs/architecture/proposals/block-anchors-2026-11-01.md §12, §9): who is shipped a
// note's anchors is who is shipped the note.
//   * bootstrap, sync delta and the grant projection (POST /api/sync/nodes) carry anchors only for notes
//     in the same payload, which are the reader's readable notes;
//   * revoking the note's space: the delta deletes the note and ships none of its anchors, even when the
//     note is edited afterwards; the bootstrap has none;
//   * re-granting: the projection brings the anchors back with the note.
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { q, bumpMembershipEpoch } from "../db.js";
import { buildBootstrap, buildSyncDelta, nodesFor } from "../services/sync/index.js";
import { createNote } from "../services/noteCreate.js";
import { updateNode } from "../services/nodeUpdate.js";
import { ensureBlockAnchor } from "../services/blockAnchors/index.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
let ws = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
registerShippedModules();

const A = "二分搜尋要先排序，再比較中間值，找不到就縮小範圍。";
const B = "雜湊表用鍵直接算出位置，碰撞要另外處理，例如鏈結法。";

describe.skipIf(!isTestDb)("anchors are shipped with the notes a reader can read (DB)", () => {
  let owner: ActorCtx;
  let reader: ActorCtx;
  let shared = "";
  let privateSpace = "";
  let shownNote = "";
  let hiddenNote = "";
  let shownAnchors: string[] = [];
  let hiddenAnchors: string[] = [];

  const cursor = async () => Number((await q<{ m: string }>(`SELECT COALESCE(MAX(id),0)::text AS m FROM domain_events WHERE workspace_id = $1`, [ws])).rows[0]!.m);
  async function noteIn(space: string, title: string): Promise<{ id: string; anchors: string[] }> {
    const id = String((await createNote({ actor: owner, workspaceId: ws, title: `${title} ${randomUUID().slice(0, 6)}`, markdown: `${A}\n\n${B}\n`, spaceId: space, event: { uiContext: "test.anchors" } })).node.id);
    const body = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;
    const anchors = [(await ensureBlockAnchor(ws, id, body, body.indexOf(A), { actor: owner }))!, (await ensureBlockAnchor(ws, id, body, body.indexOf(B), { actor: owner }))!];
    return { id, anchors };
  }
  /** Every anchor in a payload belongs to a note in the same payload. */
  const belongsToShipped = (anchors: Array<{ note_id: string }>, shippedNoteIds: string[]) =>
    expect(anchors.every((a) => shippedNoteIds.includes(a.note_id))).toBe(true);

  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('AnchorsReaders',$1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    owner = await persistActor(ws, { id: "", name: "Anchors owner", type: "human", role: "admin" });
    reader = await persistActor(ws, { id: "", name: "Anchors reader", type: "human", role: "viewer" });
    shared = await makeSpace(ws, "anchors shared", [{ id: owner.id, permission: "edit" }, { id: reader.id, permission: "view" }]);
    privateSpace = await makeSpace(ws, "anchors private", [{ id: owner.id, permission: "edit" }]);
    ({ id: shownNote, anchors: shownAnchors } = await noteIn(shared, "Shown"));
    ({ id: hiddenNote, anchors: hiddenAnchors } = await noteIn(privateSpace, "Hidden"));
  });

  it("the bootstrap carries the anchors of the notes the reader can read, and only those", async () => {
    const boot = await buildBootstrap(reader, ws, { slimBodies: false });
    const noteIds = (boot.nodes as Array<{ id: string }>).map((n) => n.id);
    expect(noteIds).toContain(shownNote);
    expect(noteIds).not.toContain(hiddenNote);
    const anchors = boot.note_anchors as Array<{ anchor_id: string; note_id: string }>;
    expect(anchors.filter((a) => a.note_id === shownNote).map((a) => a.anchor_id).sort()).toEqual([...shownAnchors].sort());
    expect(anchors.some((a) => hiddenAnchors.includes(a.anchor_id))).toBe(false);
    belongsToShipped(anchors, noteIds);
    // The owner sees both.
    const mine = await buildBootstrap(owner, ws, { slimBodies: false });
    expect((mine.note_anchors as Array<{ note_id: string }>).map((a) => a.note_id)).toEqual(expect.arrayContaining([shownNote, hiddenNote]));
    // A ?nodes=none snapshot says nothing about anchors (a client keeps what it holds).
    expect(await buildBootstrap(reader, ws, { slimBodies: false, metaOnly: true })).not.toHaveProperty("note_anchors");
  });

  it("an edit ships the note's anchors whole in the next delta; the same edit of a hidden note ships nothing to the reader", async () => {
    const since = await cursor();
    await updateNode(ws, shownNote, { markdown: `前言\n\n${A}\n\n${B}\n` }, { actor: owner });
    await updateNode(ws, hiddenNote, { markdown: `前言\n\n${A}\n\n${B}\n` }, { actor: owner });
    const delta = await buildSyncDelta(reader, ws, { since, known: [] });
    const shipped = delta.nodes.upsert.map((r) => r.id as string);
    expect(shipped).toContain(shownNote);
    expect(shipped).not.toContain(hiddenNote);
    expect(delta.note_anchors!.replace_for).toContain(shownNote);
    expect(delta.note_anchors!.replace_for).not.toContain(hiddenNote);
    expect(delta.note_anchors!.upsert.filter((a) => a.note_id === shownNote).map((a) => a.anchor_id).sort()).toEqual([...shownAnchors].sort());
    belongsToShipped(delta.note_anchors!.upsert, shipped);
  });

  it("revoked: the note is deleted from the reader's copy and none of its anchors are shipped, edits after included; re-granted: the projection brings them back", async () => {
    await q(`DELETE FROM space_members WHERE space_id = $1 AND actor_id = $2::uuid`, [shared, reader.id]);
    await bumpMembershipEpoch(ws);
    const since = await cursor();
    await updateNode(ws, shownNote, { markdown: `前言\n\n再改一次\n\n${A}\n\n${B}\n` }, { actor: owner });

    const boot = await buildBootstrap(reader, ws, { slimBodies: false });
    expect((boot.nodes as Array<{ id: string }>).map((n) => n.id)).not.toContain(shownNote);
    expect((boot.note_anchors as Array<{ note_id: string }>).some((a) => a.note_id === shownNote)).toBe(false);

    const delta = await buildSyncDelta(reader, ws, { since, known: [shownNote] });
    expect(delta.nodes.delete).toContain(shownNote);
    expect(delta.nodes.upsert.map((r) => r.id)).not.toContain(shownNote);
    expect(delta.note_anchors!.replace_for).not.toContain(shownNote);
    expect(delta.note_anchors!.upsert.some((a) => a.note_id === shownNote)).toBe(false);
    // Asked for by id, a note the reader cannot read gives no anchors either.
    const denied = await nodesFor(reader, ws, [shownNote, hiddenNote]);
    expect(denied.nodes).toEqual([]);
    expect(denied.note_anchors.upsert).toEqual([]);

    await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2::uuid, 'view')`, [shared, reader.id]);
    await bumpMembershipEpoch(ws);
    const granted = await nodesFor(reader, ws, [shownNote, hiddenNote]);
    expect(granted.nodes.map((n) => n.id)).toEqual([shownNote]);
    expect(granted.note_anchors!.replace_for).toEqual([shownNote]);
    expect(granted.note_anchors!.upsert.map((a) => a.anchor_id).sort()).toEqual([...shownAnchors].sort());
    belongsToShipped(granted.note_anchors!.upsert, granted.nodes.map((n) => n.id as string));
  });
});
