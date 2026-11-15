// 業主 2026-11-08（proposal block-anchors §5.3）：段落裡有 `{標籤}` 時 Enter 把它切成兩段，身分（錨點、block_nodes 那一列、
// 複習進度、任務、標籤）跟著有 `{標籤}` 的那一半；沒有身分的那一半再打 `{標籤}` 是新項目，不複製任何進度。
// 這裡走存檔路徑：編輯器送出的 ChangeSet（body_change）與只送全文兩種都要落在同一半。
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { ChangeSet } from "@codemirror/state";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import { splitTaggedParagraph } from "@onden/markdown";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
let workspaceId = "";
let actor: ActorCtx = { id: "anchors-split-admin", name: "Split", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/nodes", nodesRouter);
registerShippedModules();
const send = (url: string, method: string, body: unknown = {}) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const bodyOf = async (id: string) => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;

type Row = { id: string; block_ref: string; label: string; hidden: boolean; task_id: string | null };
const rows = async (noteId: string) => (await q<Row>(
  `SELECT id::text, block_ref, label, hidden_at IS NOT NULL AS hidden, task_id::text FROM block_nodes WHERE note_id = $1 ORDER BY created_at, id`, [noteId])).rows;
const visible = async (noteId: string) => (await rows(noteId)).filter((r) => !r.hidden);
const anchorFrom = async (anchorId: string) => (await q<{ from_utf16: number; status: string }>(
  `SELECT from_utf16, status FROM block_anchors WHERE workspace_id = $1 AND anchor_id = $2`, [workspaceId, anchorId])).rows[0]!;
const progressOf = async (blockId: string) => (await q(`SELECT state FROM review_states WHERE block_id = $1`, [blockId])).rows;
async function create(markdown: string): Promise<string> {
  const res = await send("/nodes", "POST", { title: `切段 ${randomUUID().slice(0, 6)}`, markdown });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}
/** Enter at `|` the way the editor does it (splitTaggedParagraph), saved with the editor's ChangeSet or the text alone. */
async function enterAt(noteId: string, marked: string, withChangeSet: boolean) {
  const before = await bodyOf(noteId);
  const offset = marked.indexOf("|");
  expect(marked.replace("|", "")).toBe(before);
  const cut = splitTaggedParagraph(before, offset)!;
  expect(cut).not.toBeNull();
  const after = before.slice(0, cut.at) + cut.insert + before.slice(cut.at);
  const body = { markdown: after, ...(withChangeSet ? { body_change: { changes: ChangeSet.of({ from: cut.at, insert: cut.insert }, before.length).toJSON(), device: "test" } } : {}) };
  expect((await send(`/nodes/${noteId}`, "PATCH", body)).status).toBe(200);
  return after;
}

describe.skipIf(!isTestDb)("{標籤}切段：身分跟著有標籤的那一半（DB）", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('AnchorsSplit',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
  });

  for (const withChangeSet of [true, false]) {
    const how = withChangeSet ? "編輯器的 ChangeSet" : "只有全文（伺服器自己算差異）";

    it(`標籤在後半：複習進度與任務留在後半那一列，前半沒有列（${how}）`, async () => {
      const id = await create("二分搜尋要先排序，再比較中間值，找到就回傳位置 {考點}\n\n- [ ] 交報告 {task}\n");
      const task = (await visible(id)).find((r) => r.task_id)!;
      const card = (await visible(id)).find((r) => !r.task_id)!;
      const ref = card.block_ref;
      await seedQ(`INSERT INTO review_states(workspace_id, block_id, actor_id, state) VALUES ($1,$2,$3,$4)`, [workspaceId, card.id, actor.id, JSON.stringify({ due: "2026-11-09", ease: 2.5 })]);

      const after = await enterAt(id, "二分搜尋要先排序，再比較中間值，|找到就回傳位置 {考點}\n\n- [ ] 交報告 {task}\n", withChangeSet);
      expect(after.startsWith("二分搜尋要先排序，再比較中間值，\n\n找到就回傳位置 {考點}")).toBe(true);

      const now = await visible(id);
      expect(now).toHaveLength(2); // the card (on its second half) and the task
      expect(now.find((r) => r.id === card.id)).toMatchObject({ block_ref: ref, hidden: false, label: "找到就回傳位置" });
      expect((await anchorFrom(ref))).toMatchObject({ status: "valid", from_utf16: after.indexOf("找到就回傳位置") });
      expect(await progressOf(card.id)).toHaveLength(1);
      expect(now.find((r) => r.task_id)!.id).toBe(task.id);
      // The first half has no row of its own and no progress.
      expect(now.some((r) => r.label.startsWith("二分搜尋"))).toBe(false);
      expect((await q(`SELECT 1 FROM review_states WHERE block_id <> $1 AND block_id IN (SELECT id FROM block_nodes WHERE note_id = $2)`, [card.id, id])).rowCount).toBe(0);
    });

    it(`標籤在前半（游標在標籤後或標籤裡）：身分留在前半，後半是空的新段落（${how}）`, async () => {
      const id = await create("雜湊表用鍵算位置 {考點}\n");
      const [card] = await visible(id);
      const ref = card!.block_ref;
      const after = await enterAt(id, "雜湊表用鍵算位置 {考|點}\n", withChangeSet);
      expect(after).toBe("雜湊表用鍵算位置 {考點}\n\n\n");
      const now = await visible(id);
      expect(now).toHaveLength(1);
      expect(now[0]).toMatchObject({ id: card!.id, block_ref: ref });
      expect((await anchorFrom(ref)).from_utf16).toBe(0);
    });
  }

  it("沒有身分的那一半再打 {標籤} 是新項目，不複製進度；原項目不變", async () => {
    const id = await create("遞迴要有終止條件，否則會無限呼叫自己 {考點}\n");
    const [card] = await visible(id);
    await seedQ(`INSERT INTO review_states(workspace_id, block_id, actor_id, state) VALUES ($1,$2,$3,$4)`, [workspaceId, card!.id, actor.id, JSON.stringify({ due: "2026-11-09", ease: 2.5 })]);
    await enterAt(id, "遞迴要有終止條件，否則會無限呼叫自己 {考點}|\n", true);
    const typed = `${await bodyOf(id)}`.replace(/\n+$/, "") + "\n\n新的一段，也想複習 {考點}\n";
    expect((await send(`/nodes/${id}`, "PATCH", { markdown: typed })).status).toBe(200);
    const now = await visible(id);
    expect(now).toHaveLength(2);
    const fresh = now.find((r) => r.id !== card!.id)!;
    expect(fresh.block_ref).not.toBe(card!.block_ref);
    expect(await progressOf(fresh.id)).toHaveLength(0);
    expect(await progressOf(card!.id)).toHaveLength(1);
  });

  it("沒有標籤的段落照 §5.3：錨點留在前半（整段存檔時兩半之間有空行）", async () => {
    const id = await create("甲段落文字很長，用來當作被切開的段落。\n\n乙段落 {考點}\n");
    const [card] = await visible(id);
    const body = await bodyOf(id);
    const cut = body.indexOf("很長");
    const after = body.slice(0, cut) + "\n\n" + body.slice(cut);
    const res = await send(`/nodes/${id}`, "PATCH", { markdown: after, body_change: { changes: ChangeSet.of({ from: cut, insert: "\n\n" }, body.length).toJSON(), device: "test" } });
    expect(res.status).toBe(200);
    expect((await visible(id)).map((r) => r.id)).toEqual([card!.id]);
    expect((await anchorFrom(card!.block_ref)).status).toBe("valid");
  });
});
