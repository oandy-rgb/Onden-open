// A Markdown export carries drawings as pictures (services/exportInk.ts): the
// SVG under attachments/, embedded at the end of the note, the same string
// @onden/markdown draws everywhere else. The strokes themselves stay out.

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
import { encodeInk, inkToSvg, inkPages, legacyFingerprint, pdfPageRecord, type InkDocument } from "@onden/markdown/ink";
import { encodePageText, emptyPageText } from "@onden/markdown/page-text";
import { readLeftOut, leftOutText } from "../services/exportLeftOut.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

const enabled = isTestDatabase();
const actor: ActorCtx = { id: "export-ink", name: "Export ink", type: "human", role: "admin" };

function app() {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/export", exportRouter);
  return hono;
}

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

const doc = (x: number): InkDocument => ({
  version: 1, erased: {}, page: { width: 1000 },
  strokes: [{ id: "s1", color: "#d33", size: 4, toolId: "pen", points: [[x, 40], [x + 60, 90], [x + 120, 60], [x + 180, 140]] }],
});

describe.skipIf(!enabled)("Markdown export carries drawings as SVG pictures", () => {
  let ws: string;
  const ids: Record<string, string> = {};
  let files: Map<string, Buffer>;
  const text = (path: string) => files.get(path)!.toString("utf8");
  const mdOf = (title: string) => [...files].find(([p, d]) => p.endsWith(".md") && d.toString("utf8").includes(`title: ${title}`) || p.endsWith(`${title}.md`))![1].toString("utf8");

  beforeAll(async () => {
    ownWorkspace = (await seedQ<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('ink export', $1) RETURNING id::text`, [`ink-${randomUUID()}`])).rows[0]!.id;
    ws = await getWorkspaceId();
    Object.assign(actor, await persistActor(ws, actor));
    const make = async (name: string) => {
      const created = await createNote({ actor, workspaceId: ws, title: name, markdown: `${name} body\n`, parentId: null, event: { uiContext: "test.exportInk" } });
      ids[name] = String(created.node.id);
    };
    const attr = (name: string, key: string, value: string) => seedQ(
      `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, $3, $4, 'text', 'ui')`, [ws, ids[name], key, value]);
    for (const name of ["HandNote", "BoardNote", "PdfNote", "PlainNote"]) await make(name);
    await attr("HandNote", "ink_data", encodeInk(doc(100)));
    await attr("BoardNote", "board_ink", encodeInk(doc(-300))); // the board's pen layer lives in board_ink (migration 172)
    await seedViewElements(ids.BoardNote, [{ id: "v1", layout: "canvas", name: "board" }]);
    const env = { version: 1 as const, pages: {}, annotations: [], units: { version: 1 as const, pages: { "pdf:2": pdfPageRecord(2, doc(50), 1.4) } } };
    await attr("PdfNote", "ink_data", JSON.stringify({ ...env, unitsFrom: legacyFingerprint(env) }));
    await attr("PdfNote", "pdf_url", "/api/media/x.pdf");
    const texts = emptyPageText();
    texts.pages["pdf:3"] = { boxes: [{ id: "t1", x: 100, y: 200, w: 300, text: "註解 <b>&", size: 22, color: "#222", align: "left", updated_at: "2026-01-01T00:00:00Z" }] };
    await attr("PdfNote", "page_text", encodePageText(texts));
    const res = await app().request("/api/export/markdown.zip");
    expect(res.status).toBe(200);
    files = unzip(Buffer.from(await res.arrayBuffer()));
  });

  it("handwriting page: the page picture is in attachments/ and embedded after the text", () => {
    const name = `ink-${ids.HandNote!.slice(0, 8)}-1.svg`;
    expect(text(`attachments/${name}`)).toBe(inkPages(encodeInk(doc(100)))[0]!.draw());
    const md = mdOf("HandNote");
    expect(md.trimEnd().endsWith(`![](./attachments/${name})`)).toBe(true);
    expect(md).not.toContain("ink_data");
  });

  it("whiteboard note: the ink layer is drawn by inkToSvg, in board coordinates", () => {
    const name = `ink-${ids.BoardNote!.slice(0, 8)}-1.svg`;
    expect(text(`attachments/${name}`)).toBe(inkToSvg(doc(-300)));
    expect(mdOf("BoardNote")).toContain(`![](./attachments/${name})`);
  });

  it("PDF note: one picture per page with strokes or text boxes, no PDF, no paper", () => {
    const pages = [...files.keys()].filter((p) => p.startsWith(`attachments/ink-${ids.PdfNote!.slice(0, 8)}-`)).sort();
    expect(pages).toHaveLength(2);
    expect(text(pages[0]!)).toContain("<path d=");
    expect(text(pages[0]!)).not.toContain("<rect");
    const words = text(pages[1]!);
    expect(words).toContain("註解 &lt;b&gt;&amp;");
    expect(words).not.toContain("<b>");
    const md = mdOf("PdfNote");
    for (const p of pages) expect(md).toContain(`![](./${p})`);
  });

  it("a note without a drawing gets no picture", () => {
    expect(mdOf("PlainNote")).not.toContain("attachments/ink-");
  });

  it("the left-out report counts whiteboards (notes with a whiteboard tab) and says what is lost", async () => {
    const left = await readLeftOut(actor, ws);
    expect(left.canvases).toBe(1);
    expect(leftOutText(left, "zh-TW")).toContain("白板上的卡片位置與連線：1 張白板");
  });
});
