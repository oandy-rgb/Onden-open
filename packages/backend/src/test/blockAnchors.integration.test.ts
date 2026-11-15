// Block anchors move with the body, in the body's transaction (batch A of
// docs/architecture/proposals/block-anchors-2026-11-01.md):
//   * a PATCH moves them (derived line diff, or the editor's own ChangeSet when it checks out);
//   * a two-device merge moves them in the merged text;
//   * a write that bypassed the move leaves a stale hash and the next write finds them by quote;
//   * a refused write leaves text and anchors as they were;
//   * undo (restore) moves them too.
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { ChangeSet } from "@codemirror/state";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import { buildSyncDelta } from "../services/sync/index.js";
import { listEvents } from "../services/eventQuery.js";
import { sha256Hex } from "../utils.js";
import { anchorBackupRowsByNote, anchorRowsForNotes, ensureBlockAnchor, listNoteAnchors, restoreBackupAnchors } from "../services/blockAnchors/index.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
let workspaceId = "";
let actor: ActorCtx = { id: "anchors-admin", name: "Anchors", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/nodes", nodesRouter);
registerShippedModules();
const send = (url: string, method: string, body: unknown = {}) =>
  method === "GET" ? app.request(url) : app.request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const A = "二分搜尋要先排序，再比較中間值，找不到就縮小範圍。";
const B = "雜湊表用鍵直接算出位置，碰撞要另外處理，例如鏈結法。";
const C = "圖的最短路徑可以用 Dijkstra，但是邊的權重不能是負數。";
const BODY = [A, B, C].join("\n\n");

const bodyOf = async (id: string) => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;
const anchor = async (noteId: string, id: string) => (await listNoteAnchors(workspaceId, noteId)).find((a) => a.anchorId === id)!;
async function newNote(): Promise<{ id: string; ids: [string, string, string] }> {
  const res = await send("/nodes", "POST", { title: `Anchors ${randomUUID().slice(0, 6)}`, markdown: BODY });
  expect(res.status).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  const body = await bodyOf(id);
  const ids = [] as string[];
  for (const t of [A, B, C]) ids.push((await ensureBlockAnchor(workspaceId, id, body, body.indexOf(t), { actor }))!);
  return { id, ids: ids as [string, string, string] };
}
const patch = (id: string, body: Record<string, unknown>) => send(`/nodes/${id}`, "PATCH", body);
const textAt = (body: string, a: { span: { from: number; to: number } }) => body.slice(a.span.from, a.span.to);

describe.skipIf(!isTestDb)("block anchors move with the body (DB)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Anchors',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
  });

  it("ensureBlockAnchor is idempotent for a block and rejects blank lines", async () => {
    const { id, ids } = await newNote();
    const body = await bodyOf(id);
    expect(await ensureBlockAnchor(workspaceId, id, body, body.indexOf(B), { actor })).toBe(ids[1]);
    expect(await ensureBlockAnchor(workspaceId, id, body, body.indexOf("\n\n") + 1, { actor })).toBeNull();
    expect(new Set(ids).size).toBe(3);
  });

  it("an edit before the block, a title-only save and an edit inside keep every anchor on its text", async () => {
    const { id, ids } = await newNote();
    expect((await patch(id, { markdown: "新的開頭一行\n\n" + BODY })).status).toBe(200);
    let body = await bodyOf(id);
    for (const [i, t] of [A, B, C].entries()) expect(textAt(body, await anchor(id, ids[i]!))).toBe(t);
    expect((await patch(id, { title: "改名" })).status).toBe(200);
    const B2 = B.replace("例如鏈結法", "例如開放定址法");
    expect((await patch(id, { markdown: body.replace(B, B2) })).status).toBe(200);
    body = await bodyOf(id);
    const b = await anchor(id, ids[1]);
    expect(b.status).toBe("valid");
    expect(textAt(body, b)).toBe(B2);
    expect(b.atBodyHash).toBeTruthy();
  });

  it("uses the editor's ChangeSet when it checks out, and ignores one that does not", async () => {
    const { id, ids } = await newNote();
    const body = await bodyOf(id);
    const cs = ChangeSet.of({ from: 0, insert: "前" }, body.length);
    expect((await patch(id, { markdown: "前" + body, body_change: { changes: cs.toJSON(), device: "d1" } })).status).toBe(200);
    expect((await q<{ moved_how: string }>(`SELECT moved_how FROM block_anchors WHERE anchor_id = $1`, [ids[0]])).rows[0]!.moved_how).toBe("editor");
    const bad = ChangeSet.of({ from: 0, insert: "別的" }, body.length + 1);
    const now = await bodyOf(id);
    expect((await patch(id, { markdown: "後" + now, body_change: { changes: bad.toJSON(), device: "d1" } })).status).toBe(200);
    const after = await bodyOf(id);
    expect(textAt(after, await anchor(id, ids[2]))).toBe(C); // fell back to the derived diff
  });

  it("two devices editing different blocks: the merged text keeps both anchors right", async () => {
    const { id, ids } = await newNote();
    const base = await bodyOf(id);
    expect((await patch(id, { markdown: base.replace(A, A + "（甲裝置加的）"), base_markdown: base })).status).toBe(200);
    // The second device still has `base`: merged by the server.
    const res = await patch(id, { markdown: base.replace(C, C + "（乙裝置加的）"), base_markdown: base });
    expect(res.status).toBe(200);
    const merged = await bodyOf(id);
    expect(merged).toContain("甲裝置加的");
    expect(merged).toContain("乙裝置加的");
    // Text typed at the end of a block is not taken into it (the block does not grow outward).
    for (const [i, t] of [A, B, C].entries()) {
      const a = await anchor(id, ids[i]!);
      expect(a.status).toBe("valid");
      expect(textAt(merged, a)).toBe(t);
    }
  });

  it("a cut-and-paste of a block elsewhere in the note is found by its text", async () => {
    const { id, ids } = await newNote();
    expect((await patch(id, { markdown: [C, A, B].join("\n\n") })).status).toBe(200);
    const body = await bodyOf(id);
    for (const [i, t] of [A, B, C].entries()) {
      const a = await anchor(id, ids[i]!);
      expect(a.status).toBe("valid");
      expect(textAt(body, a)).toBe(t);
    }
  });

  it("a deleted block is lost with its text kept, never moved onto another block; restoring the text brings it back", async () => {
    const { id, ids } = await newNote();
    expect((await patch(id, { markdown: [A, C].join("\n\n") })).status).toBe(200);
    const gone = await anchor(id, ids[1]);
    expect(gone.status).toBe("lost");
    expect(gone.quote.text).toBe(B);
    expect((await anchor(id, ids[2])).status).toBe("valid");
    expect((await patch(id, { markdown: BODY })).status).toBe(200);
    const back = await anchor(id, ids[1]);
    expect(back.status).toBe("valid");
    expect(textAt(BODY, back)).toBe(B);
  });

  it("a write that bypassed the move leaves a stale hash; the next write finds the anchors by quote", async () => {
    const { id, ids } = await newNote();
    // Simulates a path not yet on applyBodyChange (see the guard's list): body changes, anchors stay.
    await seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [id, "插入的一段話放在最前面\n\n" + BODY]);
    expect((await patch(id, { markdown: "插入的一段話放在最前面\n\n" + BODY + "\n\n結尾" })).status).toBe(200);
    const body = await bodyOf(id);
    for (const [i, t] of [A, B, C].entries()) {
      const a = await anchor(id, ids[i]!);
      expect(a.status).toBe("valid");
      expect(textAt(body, a)).toBe(t);
    }
  });

  it("a refused write (note too large) rolls the anchors back with the text", async () => {
    const { id, ids } = await newNote();
    const before = await listNoteAnchors(workspaceId, id);
    const res = await patch(id, { markdown: "字".repeat(3_000_000) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await listNoteAnchors(workspaceId, id)).toEqual(before);
    expect(await bodyOf(id)).toBe(BODY);
    expect(ids).toHaveLength(3);
  });

  it("undoing an edit moves the anchors back", async () => {
    const { id, ids } = await newNote();
    const res = await patch(id, { markdown: "新的開頭\n\n" + BODY });
    expect(res.status).toBe(200);
    const eventId = (await q<{ id: string }>(
      `SELECT id FROM domain_events WHERE target_id = $1 AND event_type = 'NODE_UPDATED' ORDER BY id DESC LIMIT 1`, [id])).rows[0]!.id;
    const { restoreEvent } = await import("../services/eventRestore/restore.js");
    await restoreEvent(eventId, { actor, workspaceId });
    const body = await bodyOf(id);
    expect(body).toBe(BODY);
    for (const [i, t] of [A, B, C].entries()) expect(textAt(body, await anchor(id, ids[i]!))).toBe(t);
  });

  it("ships a note's anchors for sync, and backs them up and restores them onto another note", async () => {
    const { id, ids } = await newNote();
    const wire = await anchorRowsForNotes(workspaceId, [id]);
    expect(wire.map((r) => r.anchor_id).sort()).toEqual([...ids].sort());
    expect(wire.every((r) => r.status === "valid" && r.note_id === id)).toBe(true);

    const backed = (await anchorBackupRowsByNote(workspaceId, [id])).get(id) ?? [];
    expect(backed).toHaveLength(3);
    // Restore onto a new note with the same text: ids are workspace-unique, so a second restore
    // into the same workspace is skipped rather than duplicated or stolen.
    const body = await bodyOf(id);
    const other = (await newNote()).id;
    expect(await restoreBackupAnchors(workspaceId, other, body, backed)).toBe(0);
    await q(`DELETE FROM block_anchors WHERE note_id = $1`, [id]);
    expect(await restoreBackupAnchors(workspaceId, other, body, backed)).toBe(3);
    // A span that no longer fits the text is dropped.
    expect(await restoreBackupAnchors(workspaceId, other, "短", [{ id: "zzzzzz", from: 0, to: 99 }])).toBe(0);
  });

  const anchorEvents = async (noteId: string) => (await q<{ event_id: string; event_type: string; payload: Record<string, unknown>; target_type: string; triggered_by_event_id: string | null; actor_id: string }>(
    `SELECT id::text AS event_id, event_type, payload, target_type, triggered_by_event_id::text, actor_id FROM domain_events
      WHERE target_id = $1 AND event_type LIKE 'BLOCK\\_ANCHOR\\_%' ORDER BY id`, [noteId])).rows;
  const updatedAt = async (id: string) => (await q<{ t: string }>(`SELECT updated_at::text AS t FROM content_nodes WHERE id = $1`, [id])).rows[0]!.t;

  it("records an anchor event when an anchor is created or changes state, with the parent version and device — and only then", async () => {
    const { id, ids } = await newNote();
    expect((await anchorEvents(id)).map((e) => e.event_type)).toEqual(["BLOCK_ANCHOR_CREATED", "BLOCK_ANCHOR_CREATED", "BLOCK_ANCHOR_CREATED"]);

    // Edits that keep every anchor valid record nothing, however many anchors they move.
    const v0 = await bodyOf(id);
    expect((await patch(id, { markdown: "新的開頭一行\n\n" + v0 })).status).toBe(200);
    expect(await anchorEvents(id)).toHaveLength(3);

    // Deleting the middle block loses its anchor: one BLOCK_ANCHOR_LOST, measured on the version before, from this device.
    const v1 = await bodyOf(id);
    const cs = ChangeSet.of({ from: v1.indexOf(B), to: v1.indexOf(C), insert: "" }, v1.length);
    expect((await patch(id, { markdown: v1.replace(B + "\n\n", ""), body_change: { changes: cs.toJSON(), device: "phone-1" } })).status).toBe(200);
    const events = await anchorEvents(id);
    expect(events.map((e) => e.event_type)).toEqual([...Array(3).fill("BLOCK_ANCHOR_CREATED"), "BLOCK_ANCHOR_LOST"]);
    const lost = events[3]!;
    expect(lost.payload).toMatchObject({ anchor_id: ids[1], parent_version: sha256Hex(v1), device: "phone-1" });
    expect(lost.target_type).toBe("node");
    expect(lost.actor_id).toBe(actor.id);
    // Not part of the edit's undo chain, and not a save.
    expect(lost.triggered_by_event_id).toBeNull();
    expect(lost.payload).not.toHaveProperty("body_hash");

    // The text comes back: the anchor is found again, which is a confirmation.
    expect((await patch(id, { markdown: v1 })).status).toBe(200);
    expect((await anchorEvents(id)).at(-1)!.event_type).toBe("BLOCK_ANCHOR_CONFIRMED");
  });

  it("anchor events are not edits: no change to 'recently updated', no version, absent from the event log; undoing an edit leaves them alone", async () => {
    const { id } = await newNote();
    const D = "排序演算法：氣泡排序每次交換相鄰的逆序對，時間複雜度是平方。";
    expect((await patch(id, { markdown: BODY + "\n\n" + D })).status).toBe(200);
    const body = await bodyOf(id);
    const t0 = await updatedAt(id);
    const versions = async () => ((await (await send(`/nodes/${id}/versions`, "GET")).json()) as unknown[]).length;
    const v0 = await versions();
    expect(await ensureBlockAnchor(workspaceId, id, body, body.indexOf(D), { actor })).toBeTruthy();
    expect(await anchorEvents(id)).toHaveLength(4);
    expect(await updatedAt(id)).toBe(t0);
    expect(await versions()).toBe(v0);
    const log = await listEvents(actor, workspaceId, { target_id: id, limit: "200" });
    const types = ("events" in log ? log.events : []).map((e) => e.event_type as string);
    expect(types).toContain("NODE_CREATED");
    expect(types.some((t) => t.startsWith("BLOCK_ANCHOR_"))).toBe(false);
    // Asked for by name, they list.
    const named = await listEvents(actor, workspaceId, { target_id: id, event_type: "BLOCK_ANCHOR_CREATED", limit: "200" });
    expect("events" in named && named.events.length).toBe(4);
  });

  it("an anchor event alone re-ships the note's anchors in the next sync delta", async () => {
    const { id } = await newNote();
    const cursor = Number((await q<{ m: string }>(`SELECT COALESCE(MAX(id),0)::text AS m FROM domain_events WHERE workspace_id = $1`, [workspaceId])).rows[0]!.m);
    const body = await bodyOf(id);
    await ensureBlockAnchor(workspaceId, id, body, body.indexOf(A) + 1, { actor }); // already anchored: no new event
    expect(await anchorEvents(id)).toHaveLength(3);
    await q(`DELETE FROM block_anchors WHERE note_id = $1 AND from_utf16 = 0`, [id]);
    await ensureBlockAnchor(workspaceId, id, body, 0, { actor });
    const delta = await buildSyncDelta(actor, workspaceId, { since: cursor, known: [] });
    const shipped = delta.note_anchors!;
    expect(shipped.replace_for).toContain(id);
    expect(shipped.upsert.filter((r) => r.note_id === id)).toHaveLength(3);
  });

  it("going back to an older version moves the anchors with it: a block that is back is found, one that never existed is lost and kept", async () => {
    const { id, ids } = await newNote();
    const v0 = await bodyOf(id);
    const versions = async () => ((await (await send(`/nodes/${id}/versions`, "GET")).json()) as Array<{ id: string }>);
    const first = (await versions()).at(-1)!; // oldest = the creation
    const D = "排序演算法：氣泡排序每次交換相鄰的逆序對，時間複雜度是平方。";
    expect((await patch(id, { markdown: v0 + "\n\n" + D })).status).toBe(200);
    const withD = await bodyOf(id);
    const dId = (await ensureBlockAnchor(workspaceId, id, withD, withD.indexOf(D), { actor }))!;
    expect((await patch(id, { markdown: [A, C, D].join("\n\n") })).status).toBe(200); // B removed
    expect((await anchor(id, ids[1])).status).toBe("lost");

    const res = await send(`/nodes/${id}/versions/${first.id}/restore`, "POST");
    expect(res.status).toBe(200);
    const body = await bodyOf(id);
    expect(body).toBe(v0);
    for (const [i, t] of [A, B, C].entries()) {
      const a = await anchor(id, ids[i]!);
      expect(a.status).toBe("valid");
      expect(textAt(body, a)).toBe(t);
    }
    // D is not in that version: the row stays, marked lost, with its text.
    const gone = await anchor(id, dId);
    expect(gone.status).toBe("lost");
    expect(gone.quote.text).toBe(D);
    expect((await q(`SELECT 1 FROM block_anchors WHERE anchor_id = $1`, [dId])).rowCount).toBe(1);
  });
});
