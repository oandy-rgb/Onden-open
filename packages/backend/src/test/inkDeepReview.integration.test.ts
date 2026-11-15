// 深入審查 2026-11-11（手寫）：docs/archive/deep-review-ink-2026-11-11.md。
// 手寫 × 垃圾桶／複製／匯出：一則筆記的四個手寫屬性（ink_data、board_ink、page_text、page_images）
// 是不是跟著筆記走。`it.fails` 釘住已重現的缺口：名稱寫應有的行為，修好後拿掉 `.fails`。

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { getWorkspaceId } from "../db.js";
import { seedQ } from "./helpers/seedQ.js";
import { seedViewElements } from "./helpers/seedView.js";

let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
import { apiOnError } from "../httpError.js";
import exportRouter from "../routes/export.js";
import { createNote } from "../services/noteCreate.js";
import { duplicateNote } from "../services/noteDuplicate.js";
import { trashNode, undeleteNode } from "../services/nodeTrash.js";
import { encodeInk, type InkDocument } from "@onden/markdown/ink";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

const actor: ActorCtx = { id: "ink-deep-review", name: "Ink review", type: "human", role: "admin" };
const BOARD_VIEW = [{ id: "v1", name: "Canvas", layout: "canvas", layout_config: {} }];
const doc = (x: number): InkDocument => ({
  version: 1, erased: {}, page: { width: 1000 },
  strokes: [{ id: `s${x}`, color: "#d33", size: 4, toolId: "pen", points: [[x, 40], [x + 60, 90], [x + 120, 60], [x + 180, 140]] }],
});
const KEYS = ["ink_data", "board_ink", "page_text", "page_images"] as const;
const VALUES: Record<(typeof KEYS)[number], string> = {
  ink_data: encodeInk(doc(10)),
  board_ink: encodeInk(doc(-300)),
  page_text: JSON.stringify({ version: 1, pages: { "1": { boxes: [{ id: "t1", x: 1, y: 2, w: 100, text: "hello", size: 20, color: "#222", align: "left", updated_at: "2026-01-01T00:00:00Z" }] } } }),
  page_images: JSON.stringify({ version: 1, pages: { "1": { images: [] } } }),
};

function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10), size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28), extraLength = zip.readUInt16LE(at + 30), commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(dataAt, dataAt + size);
    files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

describe.skipIf(!isTestDatabase())("手寫 × 垃圾桶／複製／匯出（深入審查 2026-11-11）", () => {
  let ws = "";
  beforeAll(async () => {
    ownWorkspace = (await seedQ<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('ink deep review', $1) RETURNING id::text`, [`ink-deep-${randomUUID()}`])).rows[0]!.id;
    ws = await getWorkspaceId();
    Object.assign(actor, await persistActor(ws, actor));
  });

  async function noteWithInk(title: string, whiteboard = false): Promise<string> {
    const created = await createNote({ actor, workspaceId: ws, title, markdown: `${title}\n`, parentId: null, event: { uiContext: "test.inkDeepReview" } });
    const id = String(created.node.id);
    for (const key of KEYS) {
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, $3, $4, 'text', 'ui')`, [ws, id, key, VALUES[key]]);
    }
    if (whiteboard) await seedViewElements(id, BOARD_VIEW);
    return id;
  }
  const handwriting = async (id: string) => Object.fromEntries((await seedQ<{ key: string; value: string }>(
    `SELECT key, value FROM node_attributes WHERE node_id = $1 AND key = ANY($2::text[])`, [id, [...KEYS]])).rows.map((r) => [r.key, r.value]));

  it("丟進垃圾桶再復原：四個手寫屬性原樣在", async () => {
    const id = await noteWithInk("trash ink");
    await trashNode(actor, ws, id);
    await undeleteNode(actor, ws, id);
    expect(await handwriting(id)).toEqual(VALUES);
  });

  it("複製筆記：四個手寫屬性跟著複製", async () => {
    const source = await noteWithInk("copy ink");
    const copyId = randomUUID();
    await duplicateNote({ workspaceId: ws, actor, sourceId: source, newNodeId: copyId });
    expect(await handwriting(copyId)).toEqual(VALUES);
  });

  // （已修）exportInk.noteInkFiles 原本對白板筆記讀 ink_data；白板的筆畫層自 migration 172 起存在 board_ink，
  // 所以只畫在白板上的筆畫不會出現在 Markdown 匯出。修法：白板分支改讀 board_ink（ink_data 是筆記自己的手寫頁，另算一張）。
  it("白板上只有 board_ink 的筆畫：Markdown 匯出有那一張圖", async () => {
    const created = await createNote({ actor, workspaceId: ws, title: "board only", markdown: "board only\n", parentId: null, event: { uiContext: "test.inkDeepReview" } });
    const id = String(created.node.id);
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, 'board_ink', $3, 'text', 'ui')`, [ws, id, VALUES.board_ink]);
    await seedViewElements(id, BOARD_VIEW);
    const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
    hono.onError(apiOnError);
    hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
    hono.route("/api/export", exportRouter);
    const res = await hono.request("/api/export/markdown.zip");
    const files = unzip(Buffer.from(await res.arrayBuffer()));
    expect([...files.keys()].some((p) => p.startsWith(`attachments/ink-${id.split("-")[0]}-`))).toBe(true);
  });
});
