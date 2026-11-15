// Anchor batch 1 (docs/architecture/proposals/block-anchors-2026-11-01.md §12 row 1, without the function
// parts): block nodes name their anchor; a paragraph stands alone as a note (獨立出去) and comes back (收回原文)
// with the same identity; 「本篇的段落」; the anchors a save had no budget for are settled in the background.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID, createHash } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import tasksRouter from "../modules/tasks/routes.js";
import { ensureBlockAnchor, FIND_BUDGET, listNoteAnchors, listNoteParagraphs, recoverAnchors, ANCHOR_RECOVER_EFFECT } from "../services/blockAnchors/index.js";
import { restoreEvent } from "../services/eventRestore/restore.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { buildBootstrap, buildSyncDelta, nodesFor } from "../services/sync/index.js";
import { bumpMembershipEpoch } from "../db.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
let workspaceId = "";
let actor: ActorCtx = { id: "anchors-b1-admin", name: "B1", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/nodes", nodesRouter);
app.route("/tasks", tasksRouter);
registerShippedModules();
const send = (url: string, method: string, body: unknown = {}) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const bodyOf = async (id: string) => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;

type BlockRow = { id: string; block_ref: string; anchor_id: string | null; detached_note_id: string | null; hidden: boolean; task_id: string | null };
const blockRows = async (noteId: string) => (await q<BlockRow>(
  `SELECT id::text, block_ref, anchor_id, detached_note_id::text, hidden_at IS NOT NULL AS hidden, task_id::text
     FROM block_nodes WHERE note_id = $1 ORDER BY created_at, id`, [noteId])).rows;
/** The ref (anchor id) the server gave the block whose label is `label`: the text carries no `^id` to read it from. */
const refByLabel = async (noteId: string, label: string) => {
  const row = (await q<{ block_ref: string }>(`SELECT block_ref FROM block_nodes WHERE note_id = $1 AND label = $2`, [noteId, label])).rows[0];
  expect(row, `no block labelled ${label}`).toBeTruthy();
  return row!.block_ref;
};
const blockByRef = async (noteId: string, ref: string) => (await blockRows(noteId)).find((b) => b.block_ref === ref)!;
const anchorRow = async (anchorId: string) => (await q<{ note_id: string; status: string; from_utf16: number }>(
  `SELECT note_id::text, status, from_utf16 FROM block_anchors WHERE workspace_id = $1 AND anchor_id = $2`, [workspaceId, anchorId])).rows[0]!;
async function create(title: string, markdown: string): Promise<string> {
  const res = await send("/nodes", "POST", { title: `${title} ${randomUUID().slice(0, 6)}`, markdown });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}
type Done = { child_id: string; event_id: string };
const detach = async (noteId: string, ref: string) => {
  const res = await send(`/nodes/${noteId}/block-to-child`, "POST", { block_ref: ref, keep_identity: true, fallback_title: "Untitled" });
  expect(res.status).toBe(200);
  return (await res.json()) as Done;
};
const reattach = async (noteId: string, childId: string) => {
  const res = await send(`/nodes/${noteId}/expand-child`, "POST", { child_id: childId });
  expect(res.status).toBe(200);
  return (await res.json()) as Done;
};

describe.skipIf(!isTestDb)("anchor batch 1 (DB)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('AnchorsB1',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
  });

  describe("block_nodes.anchor_id", () => {
    it("a saved block node names a valid anchor of its note, and the name survives edits before it", async () => {
      const id = await create("錨", "# 筆記\n\n二分搜尋要先排序 {考點}\n\n- [ ] 交報告 {task}\n");
      const b1 = await refByLabel(id, "二分搜尋要先排序");
      const rows = await blockRows(id);
      expect(rows.map((r) => r.anchor_id)).toSatisfy((ids: Array<string | null>) => ids.every((a) => a !== null) && new Set(ids).size === ids.length);
      const before = await anchorRow((await blockByRef(id, b1)).anchor_id!);
      expect(b1).toBe((await blockByRef(id, b1)).anchor_id); // the row's ref is its anchor's id
      expect(before).toMatchObject({ note_id: id, status: "valid" });
      const body = await bodyOf(id);
      expect((await send(`/nodes/${id}`, "PATCH", { markdown: `一段新的開頭，讓後面的位置往後移。\n\n${body}` })).status).toBe(200);
      const after = await blockByRef(id, b1); // the same ref after the edit: the text before it moved, the identity did not
      expect(after.anchor_id).toBe(b1);
      const moved = await anchorRow(after.anchor_id!);
      expect(moved.status).toBe("valid");
      expect(moved.from_utf16).toBeGreaterThan(before.from_utf16);
      // Two saves later it is the same anchor, not a new one.
      expect(rowsAnchors(await blockRows(id))).toEqual(rowsAnchors(rows));
    });

    it("a block that takes the place of a hidden one does not take its anchor (they come back together)", async () => {
      // 甲 loses its `{…}` (its row hides, its anchor stays on it) while 乙 gets one: 乙 is a new block, not 甲 again.
      const id = await create("取代", "甲段落 {考點}\n\n乙段落\n");
      const h1 = await refByLabel(id, "甲段落");
      const first = await blockByRef(id, h1);
      expect((await send(`/nodes/${id}`, "PATCH", { markdown: "甲段落\n\n乙段落 {考點}\n" })).status).toBe(200);
      const rows = await blockRows(id);
      expect(rows.find((r) => r.block_ref === h1)).toMatchObject({ hidden: true, anchor_id: first.anchor_id });
      const second = rows.find((r) => r.block_ref !== h1)!;
      expect(second.anchor_id).not.toBeNull();
      expect(second.anchor_id).not.toBe(first.anchor_id);
    });

    it("a lost anchor keeps the row and its data, and can be reassigned", async () => {
      const id = await create("遺失", "段落甲。\n\n- [ ] 交報告 {task}\n\n段落乙。\n");
      const l1 = await refByLabel(id, "交報告");
      const row = await blockByRef(id, l1);
      expect(row.task_id).not.toBeNull();
      await q(`UPDATE block_anchors SET status = 'lost', candidate_from_utf16 = NULL, candidate_to_utf16 = NULL WHERE workspace_id = $1 AND anchor_id = $2`, [workspaceId, row.anchor_id]);
      const listed = (await listNoteParagraphs(actor, workspaceId, id)).find((p) => p.id === row.id)!;
      expect(listed).toMatchObject({ where: "lost", anchorStatus: "lost" });
      const body = await bodyOf(id);
      // Refused when the note is not what the person saw.
      expect((await send(`/nodes/${id}/paragraphs/${row.id}/reassign`, "POST", { at: body.indexOf("交報告"), body_hash: sha("別的") })).status).toBe(409);
      const ok = await send(`/nodes/${id}/paragraphs/${row.id}/reassign`, "POST", { at: body.indexOf("交報告"), body_hash: sha(body) });
      expect(ok.status).toBe(200);
      expect(await anchorRow(row.anchor_id!)).toMatchObject({ note_id: id, status: "valid" });
      expect((await blockByRef(id, l1)).task_id).toBe(row.task_id);
    });
  });

  describe("獨立出去 / 收回原文 keep one identity", () => {
    it("task due date, recurrence, review schedule, links and the {…} are the same after detach → attach → detach → attach", async () => {
      const original = "# 筆記\n\n- [ ] 交報告 {task}\n\n二分搜尋每次砍半 {考點}\n";
      const id = await create("獨立", original);
      const r1 = await refByLabel(id, "交報告");
      const s1 = await refByLabel(id, "二分搜尋每次砍半");
      const taskRow = await blockByRef(id, r1);
      const cardRow = await blockByRef(id, s1);
      const taskId = taskRow.task_id!;
      expect((await send(`/tasks/${taskId}`, "PATCH", { due_date: "2026-11-20" })).status).toBe(200);
      expect((await send(`/tasks/${taskId}`, "PATCH", { recur: "1w" })).status).toBe(200);
      const parentTitle = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [id])).rows[0]!.title;
      const linker = await create("引用", `見 [[${parentTitle}#^${s1}]]。\n`);
      await seedQ(`INSERT INTO review_states(workspace_id, block_id, actor_id, state) VALUES ($1,$2,$3,$4)`, [workspaceId, cardRow.id, actor.id, JSON.stringify({ due: "2026-11-09", ease: 2.5 })]);
      const snapshot = async () => ({
        task: (await q(`SELECT key, value FROM node_attributes WHERE node_id = $1 AND key LIKE '\\_task\\_%' ORDER BY key`, [taskId])).rows,
        taskDeleted: (await q<{ d: boolean }>(`SELECT deleted_at IS NOT NULL AS d FROM content_nodes WHERE id = $1`, [taskId])).rows[0]!.d,
        review: (await q(`SELECT state FROM review_states WHERE block_id = $1`, [cardRow.id])).rows,
        rows: (await blockRows(id)).map((r) => ({ id: r.id, ref: r.block_ref, anchor: r.anchor_id, task: r.task_id })),
        links: await bodyOf(linker),
      });
      const before = await snapshot();
      expect(before.task.length).toBeGreaterThan(1);

      for (let round = 0; round < 2; round++) {
        for (const ref of [r1, s1]) {
          const row = await blockByRef(id, ref);
          const done = await detach(id, ref);
          const standing = await blockByRef(id, ref);
          expect(standing).toMatchObject({ id: row.id, anchor_id: row.anchor_id, detached_note_id: done.child_id, hidden: false });
          expect((await anchorRow(row.anchor_id!)).note_id).toBe(done.child_id);
          // New notes are not published by default: a paragraph does not become a public page by moving out.
          expect((await q(`SELECT 1 FROM node_attributes WHERE node_id = $1 AND key = '_published'`, [done.child_id])).rowCount).toBe(0);
          // The task stays on the paragraph while it stands alone; the child is not a second task.
          if (ref === r1) {
            expect((await snapshot()).taskDeleted).toBe(false);
            expect((await q(`SELECT 1 FROM node_tags nt JOIN content_nodes t ON t.id = nt.tag_id WHERE nt.node_id = $1 AND lower(t.title) = 'task'`, [done.child_id])).rowCount).toBe(0);
          }
          const paragraph = (await listNoteParagraphs(actor, workspaceId, id)).find((p) => p.id === row.id)!;
          expect(paragraph).toMatchObject({ where: "standing", noteId: done.child_id });
          await reattach(id, done.child_id);
          expect(await blockByRef(id, ref)).toMatchObject({ id: row.id, anchor_id: row.anchor_id, detached_note_id: null, hidden: false });
          expect((await anchorRow(row.anchor_id!)).note_id).toBe(id);
        }
        expect(await bodyOf(id)).toBe(original);
        expect(await snapshot()).toEqual(before);
      }
    });

    it("one restore of the detach event brings the paragraph back with its identity", async () => {
      const id = await create("復原", "一段 {考點}\n\n另一段。\n");
      const u1 = await refByLabel(id, "一段");
      const row = await blockByRef(id, u1);
      const body = await bodyOf(id);
      const done = await detach(id, u1);
      await restoreEvent(done.event_id, { actor, workspaceId, cascade: true });
      expect(await bodyOf(id)).toBe(body);
      expect(await blockByRef(id, u1)).toMatchObject({ id: row.id, detached_note_id: null, hidden: false });
      expect((await anchorRow(row.anchor_id!)).note_id).toBe(id);
    });

    it("tagging the first line of a standing paragraph's note saves (the moved anchor stays its row's)", async () => {
      const id = await create("獨立後加標籤", "買牛奶 {考點}\n\n另一段。\n");
      const m1 = await refByLabel(id, "買牛奶");
      const row = await blockByRef(id, m1);
      const done = await detach(id, m1);
      const childBody = await bodyOf(done.child_id);
      const firstLine = childBody.split("\n")[0]!;
      const res = await send(`/nodes/${done.child_id}`, "PATCH", { markdown: childBody.replace(firstLine, `${firstLine} {考點}`) });
      expect(res.status).toBe(200);
      const [fresh] = await blockRows(done.child_id);
      expect(fresh!.anchor_id).not.toBe(row.anchor_id);
      expect(await blockByRef(id, m1)).toMatchObject({ id: row.id, anchor_id: row.anchor_id, detached_note_id: done.child_id });
    });

    it("an inner task line still blocks the move (its row would be hidden)", async () => {
      const id = await create("內層", "## 區 {考點}\n\n- [ ] 內層任務 {task}\n");
      const res = await send(`/nodes/${id}/block-to-child`, "POST", { block_ref: await refByLabel(id, "區"), keep_identity: true });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "block_has_task_line" });
    });

    it("the old 搬成子筆記 still refuses a task line and copies, so the two entries do not mix", async () => {
      const id = await create("舊入口", "- [ ] 舊任務 {task}\n");
      const res = await send(`/nodes/${id}/block-to-child`, "POST", { block_ref: await refByLabel(id, "舊任務") });
      expect(res.status).toBe(409);
    });
  });

  describe("every place a paragraph that stays in its note could show up (§S4.3)", () => {
    it("block nodes add no note: not in the tree, the search index, the backups or the vectors", async () => {
      const notesBefore = Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM content_nodes WHERE workspace_id = $1`, [workspaceId])).rows[0]!.n);
      const id = await create("可見位置", "甲 {考點}\n\n乙 {考點}\n\n丙 {考點}\n");
      const notesAfter = Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM content_nodes WHERE workspace_id = $1`, [workspaceId])).rows[0]!.n);
      // The note itself, plus the 考點 tag the topic made: never one per paragraph.
      expect(notesAfter - notesBefore).toBeLessThanOrEqual(2);
      expect((await blockRows(id)).length).toBe(3);
      expect((await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND parent_id = $2`, [workspaceId, id])).rowCount).toBe(0);
      // One backup intent for the note's text, none for its paragraphs.
      const backups = (await q<{ n: string }>(`SELECT count(*)::text AS n FROM outbox WHERE workspace_id = $1 AND effect_kind IN ('git_commit','github_backup') AND payload->>'node_id' = $2`, [workspaceId, id])).rows[0]!.n;
      expect(Number(backups)).toBeLessThanOrEqual(2);
      // Paragraph-level readers never see a live row's text anywhere but its note: nothing is published or embedded for it.
      expect((await q(`SELECT 1 FROM node_attributes WHERE key = '_published' AND node_id IN (SELECT id FROM content_nodes WHERE parent_id = $1)`, [id])).rowCount).toBe(0);
    });

    it("a standing paragraph is a note of its own: in the tree under its note, and out of the block query", async () => {
      const id = await create("獨立出現", "只一段 {考點}\n\n");
      const done = await detach(id, await refByLabel(id, "只一段"));
      const child = (await q<{ parent_id: string; node_type: string }>(`SELECT parent_id::text, node_type FROM content_nodes WHERE id = $1`, [done.child_id])).rows[0]!;
      expect(child).toMatchObject({ parent_id: id, node_type: "content" });
      const { runNodeQuery } = await import("../services/nodeQuery.js");
      const tag = (await q<{ title: string }>(`SELECT t.title FROM node_tags nt JOIN content_nodes t ON t.id = nt.tag_id WHERE nt.node_id = $1 LIMIT 1`, [done.child_id])).rows[0]!.title;
      const found = await runNodeQuery(actor, workspaceId, { tags: [tag], limit: 200 });
      expect(found.rows.filter((r) => "block" in r && r.id === id)).toEqual([]);
    });
  });

  describe("who sees 「本篇的段落」 and a standing paragraph's note", () => {
    it("revoke and re-grant: the list, the standing note and its anchors follow what the reader may read", async () => {
      const owner = actor;
      const reader = await persistActor(workspaceId, { id: "", name: "B1 reader", type: "human", role: "viewer" });
      const shared = await makeSpace(workspaceId, "b1 shared", [{ id: owner.id, permission: "edit" }, { id: reader.id, permission: "view" }]);
      const priv = await makeSpace(workspaceId, "b1 private", [{ id: owner.id, permission: "edit" }]);
      const noteId = await create("權限", "一段 {考點}\n\n另一段 {考點}\n");
      await putInSpace(noteId, shared);
      const p1 = await refByLabel(noteId, "一段");
      const standing = await detach(noteId, p1);
      const row = await blockByRef(noteId, p1);
      const listed = async (who: ActorCtx) => (await listNoteParagraphs(who, workspaceId, noteId)).find((p) => p.id === row.id)!;

      // The reader may read the note and its child: the list says where the paragraph went.
      expect(await listed(reader)).toMatchObject({ where: "standing", noteId: standing.child_id, topics: [expect.any(String)] });

      // The child moves somewhere the reader cannot read: still listed as the note's paragraph, but no way into it,
      // and its anchor is not shipped to the reader's copy.
      await putInSpace(standing.child_id, priv);
      expect(await listed(reader)).toMatchObject({ where: "standing", noteId: null });
      expect(await listed(owner)).toMatchObject({ noteId: standing.child_id });
      const boot = await buildBootstrap(reader, workspaceId, { slimBodies: false });
      expect((boot.note_anchors as Array<{ anchor_id: string }>).some((a) => a.anchor_id === row.anchor_id)).toBe(false);
      expect((boot.note_anchors as Array<{ note_id: string }>).some((a) => a.note_id === noteId)).toBe(true);
      await putInSpace(standing.child_id, shared);

      // Revoked: the note is gone for the reader — the endpoint answers as for a missing note.
      actor = reader;
      await q(`DELETE FROM space_members WHERE space_id = $1 AND actor_id = $2::uuid`, [shared, reader.id]);
      await bumpMembershipEpoch(workspaceId);
      expect((await send(`/nodes/${noteId}/paragraphs`, "GET")).status).toBe(404);
      expect((await nodesFor(reader, workspaceId, [noteId, standing.child_id])).note_anchors.upsert).toEqual([]);
      const since = Number((await q<{ m: string }>(`SELECT COALESCE(MAX(id),0)::text AS m FROM domain_events WHERE workspace_id = $1`, [workspaceId])).rows[0]!.m);
      actor = owner;
      await send(`/nodes/${noteId}`, "PATCH", { markdown: `${await bodyOf(noteId)}\n補一段。\n` });
      const delta = await buildSyncDelta(reader, workspaceId, { since, known: [noteId] });
      expect(delta.note_anchors!.upsert.some((a) => a.note_id === noteId || a.note_id === standing.child_id)).toBe(false);

      // Re-granted: reachable again, same answer.
      await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2::uuid, 'view')`, [shared, reader.id]);
      await bumpMembershipEpoch(workspaceId);
      actor = reader;
      const again = await send(`/nodes/${noteId}/paragraphs`, "GET");
      expect(again.status).toBe(200);
      expect(((await again.json()) as { paragraphs: Array<{ id: string; where: string }> }).paragraphs.find((p) => p.id === row.id)?.where).toBe("standing");
      // After reconnecting, the readable set of anchors is whole again: the note's and the standing paragraph's.
      const rebooted = (await buildBootstrap(reader, workspaceId, { slimBodies: false })).note_anchors as Array<{ anchor_id: string; note_id: string }>;
      expect(rebooted.some((a) => a.anchor_id === row.anchor_id && a.note_id === standing.child_id)).toBe(true);
      expect(rebooted.some((a) => a.note_id === noteId)).toBe(true);
      actor = owner;
    });
  });

  describe("the anchors over a save's find budget are settled in the background", () => {
    it("queues one intent per note, and a pass settles every anchor", async () => {
      const paragraphs = Array.from({ length: FIND_BUDGET + 4 }, (_, i) => `第${i}段是一段足夠長而且彼此不同的文字，主題編號${i * 7919}。`);
      const id = await create("背景找回", paragraphs.join("\n\n"));
      const body = await bodyOf(id);
      for (const p of paragraphs) await ensureBlockAnchor(workspaceId, id, body, body.indexOf(p), { actor });
      expect((await listNoteAnchors(workspaceId, id)).length).toBe(paragraphs.length);
      // A write that did not move the anchors (none of today's paths, but a restore from a backup or an older
      // server could) leaves them untrusted: every one is looked up by its text, over the per-save budget.
      const reversed = [...paragraphs].reverse().join("\n\n");
      await seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [id, reversed]);
      expect((await send(`/nodes/${id}`, "PATCH", { markdown: `${reversed}\n` })).status).toBe(200);
      const pendingNow = (await q<{ n: string }>(`SELECT count(*)::text AS n FROM block_anchors WHERE note_id = $1 AND recovery_pending`, [id])).rows[0]!.n;
      expect(Number(pendingNow)).toBe(paragraphs.length - FIND_BUDGET);
      // The intent exists whatever the drain has done with it since (it may already have run).
      const queued = await q<{ status: string }>(`SELECT status FROM outbox WHERE workspace_id = $1 AND effect_kind = $2 AND payload->>'note_id' = $3`, [workspaceId, ANCHOR_RECOVER_EFFECT, id]);
      expect(queued.rows).toHaveLength(1);
      await recoverAnchors(workspaceId, id);
      const settled = await listNoteAnchors(workspaceId, id);
      expect(settled.every((a) => !a.recoveryPending)).toBe(true);
      const text = await bodyOf(id);
      for (const a of settled) {
        expect(a.status).toBe("valid");
        expect(text.slice(a.span.from, a.span.to)).toBe(a.quote.text);
      }
    });
  });
});

const rowsAnchors = (rows: BlockRow[]) => rows.map((r) => [r.block_ref, r.anchor_id]);
