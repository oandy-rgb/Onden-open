// `[[筆記/段落開頭]]` on the server (services/blockLinks.ts): the anchor and the binding come in one transaction,
// the sync ships both, a doubtful anchor is confirmed by someone who may edit the note, links are counted from the
// text, and the published site reads the same link by its words. Skips unless DATABASE_URL names a *_test database.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import blockLinkRouter from "../routes/blockLinks.js";
import { buildSyncDelta, buildBootstrap } from "../services/sync/index.js";
import { createNote } from "../services/noteCreate.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { listNoteAnchors } from "../services/blockAnchors/index.js";
import { bindingBackupRowsByNote, restoreBackupBindings } from "../services/blockLinks.js";
import { md2html } from "../modules/website/publishing/htmlUtils.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
let workspaceId = "";
let admin: ActorCtx = { id: "links-admin", name: "Links", role: "admin", type: "human" };
let viewer: ActorCtx = { id: "links-viewer", name: "Viewer", role: "viewer", type: "human" };
let current: ActorCtx = admin;
let shared = "";
let privateSpace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", current); await next(); });
app.route("/nodes", nodesRouter);
app.route("/nodes", blockLinkRouter);
registerShippedModules();
const send = (url: string, method: string, body: unknown = {}) =>
  method === "GET" ? app.request(url) : app.request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const A = "二分搜尋要先排序，再比較中間值，找不到就縮小範圍。";
const B = "雜湊表用鍵直接算出位置，碰撞要另外處理，例如鏈結法。";
const LIST = "- 第一項要買牛奶\n- 第二項要買雞蛋\n  - 巢狀的小項目\n- 第三項要買麵包";
const BODY = `# 演算法\n\n${A}\n\n${B}\n\n${LIST}\n`;

/** A note in the space the viewer can read (view only) unless `spaceId` says otherwise. */
async function note(markdown = BODY, title = `筆記 ${randomUUID().slice(0, 6)}`, spaceId = shared): Promise<{ id: string; title: string }> {
  const made = await createNote({ actor: admin, workspaceId, title, markdown, spaceId, event: { uiContext: "test.blockLinks" } });
  return { id: String(made.node.id), title };
}
const link = (targetId: string, body: Record<string, unknown>) => send(`/nodes/${targetId}/block-links`, "POST", body);
const bodyOf = async (id: string) => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;
const bindings = async (sourceId: string) =>
  (await q<{ link_text: string; anchor_id: string }>(`SELECT link_text, anchor_id FROM block_link_bindings WHERE note_id = $1 ORDER BY link_text`, [sourceId])).rows;

describe.skipIf(!isTestDb)("part links (DB)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Links',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    admin = await persistActor(workspaceId, admin);
    viewer = await persistActor(workspaceId, viewer);
    current = admin;
    shared = await makeSpace(workspaceId, "links shared", [{ id: admin.id, permission: "edit" }, { id: viewer.id, permission: "view" }]);
    privateSpace = await makeSpace(workspaceId, "links private", [{ id: admin.id, permission: "edit" }]);
  });

  it("makes the anchor and the binding together, and answers what goes between [[ ]]", async () => {
    const target = await note();
    const source = await note("來源\n", "來源筆記");
    const body = await bodyOf(target.id);
    const res = await link(target.id, { source_note_id: source.id, at: body.indexOf(B), seen_text: B });
    expect(res.status).toBe(201);
    const made = await res.json() as { anchor_id: string; link: string; link_text: string };
    expect(made.link).toBe(`${target.title}/${made.link_text}`);
    expect(made.link_text.startsWith("雜湊表用鍵直接算出位置")).toBe(true);
    expect(made.link_text).not.toMatch(/[\/|\[\]]/);
    const anchors = await listNoteAnchors(workspaceId, target.id);
    expect(anchors.map((a) => a.anchorId)).toContain(made.anchor_id);
    expect(body.slice(anchors.find((a) => a.anchorId === made.anchor_id)!.span.from, anchors.find((a) => a.anchorId === made.anchor_id)!.span.to)).toBe(B);
    expect(await bindings(source.id)).toEqual([{ link_text: `${target.title}/${made.link_text}`, anchor_id: made.anchor_id }]);
  });

  it("linking the same paragraph again reuses its anchor; another paragraph with the same words gets another text", async () => {
    const same = "待辦事項：整理桌面。";
    const target = await note(`${same}\n\n${same}\n`);
    const source = await note("來源\n", "來源二");
    const body = await bodyOf(target.id);
    const first = await (await link(target.id, { source_note_id: source.id, at: 0, seen_text: same })).json() as { anchor_id: string; link: string };
    const again = await (await link(target.id, { source_note_id: source.id, at: 0, seen_text: same })).json() as { anchor_id: string; link: string };
    expect(again).toEqual(first);
    const second = await (await link(target.id, { source_note_id: source.id, at: body.lastIndexOf(same), seen_text: same })).json() as { anchor_id: string; link: string };
    expect(second.anchor_id).not.toBe(first.anchor_id);
    expect(second.link).not.toBe(first.link);
    expect((await bindings(source.id)).length).toBe(2);
  });

  it("links in the note itself are written [[/…]]", async () => {
    const t = await note();
    const body = await bodyOf(t.id);
    const made = await (await link(t.id, { source_note_id: t.id, at: body.indexOf(A), seen_text: A })).json() as { link: string };
    expect(made.link.startsWith("/")).toBe(true);
  });

  it("a list item is its own part, a heading is its own line", async () => {
    const t = await note();
    const s = await note("來源\n", "來源三");
    const body = await bodyOf(t.id);
    const item = await (await link(t.id, { source_note_id: s.id, at: body.indexOf("第二項"), seen_text: "第二項要買雞蛋" })).json() as { anchor_id: string };
    const head = await (await link(t.id, { source_note_id: s.id, at: body.indexOf("# 演算法"), seen_text: "演算法" })).json() as { anchor_id: string };
    const anchors = await listNoteAnchors(workspaceId, t.id);
    const textOf = (id: string) => { const a = anchors.find((x) => x.anchorId === id)!; return body.slice(a.span.from, a.span.to); };
    expect(textOf(item.anchor_id)).toBe("- 第二項要買雞蛋\n  - 巢狀的小項目");
    expect(textOf(head.anchor_id)).toBe("# 演算法");
  });

  it("a heading link survives the heading being renamed and the paragraphs around it being edited", async () => {
    const t = await note();
    const s = await note("來源\n", "來源標題");
    const body = await bodyOf(t.id);
    const made = await (await link(t.id, { source_note_id: s.id, at: body.indexOf("# 演算法"), seen_text: "演算法" })).json() as { anchor_id: string };
    expect((await send(`/nodes/${t.id}`, "PATCH", { markdown: body.replace("# 演算法", "# 演算法與資料結構").replace(A, "前言\n\n" + A) })).status).toBe(200);
    const after = await bodyOf(t.id);
    const a = (await listNoteAnchors(workspaceId, t.id)).find((x) => x.anchorId === made.anchor_id)!;
    expect(a.status).toBe("valid");
    expect(after.slice(a.span.from, a.span.from + 4)).toBe("# 演算"); // still the heading's own line (words added at its end are read from the text)
    expect(await bindings(s.id)).toHaveLength(1); // the binding is by id: the link did not break
  });

  it("refuses rather than guesses when the paragraph changed under the caller", async () => {
    const t = await note();
    const s = await note("來源\n", "來源四");
    const res = await link(t.id, { source_note_id: s.id, at: 0, seen_text: "這段文字從來不存在於筆記裡" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("the part changed");
    expect(await bindings(s.id)).toEqual([]);
    expect(await listNoteAnchors(workspaceId, t.id)).toEqual([]);
  });

  it("when the text moved, the part is found by its words", async () => {
    const t = await note();
    const s = await note("來源\n", "來源五");
    const res = await link(t.id, { source_note_id: s.id, at: 1, seen_text: B });
    expect(res.status).toBe(201);
  });

  it("a note the caller cannot read or find is 404; a note they may only read cannot take a new anchor", async () => {
    const t = await note();
    const s = await note("來源\n", "來源六");
    const body = await bodyOf(t.id);
    expect((await link(randomUUID(), { source_note_id: s.id, at: 0, seen_text: A })).status).toBe(404);
    // A hidden note answers exactly like a missing one: nothing about it leaks.
    const hidden = await note(BODY, "秘密筆記", privateSpace);
    current = viewer;
    try { expect((await link(hidden.id, { source_note_id: s.id, at: 0, seen_text: A })).status).toBe(404); } finally { current = admin; }
    current = viewer;
    try {
      // The viewer may not change the note the link is written in.
      expect((await link(t.id, { source_note_id: s.id, at: body.indexOf(A), seen_text: A })).status).toBe(403);
    } finally { current = admin; }
    // The part already has a valid anchor: a reader-linker still cannot write the binding without editing the source.
    expect(await bindings(s.id)).toEqual([]);
  });

  it("the sync ships the binding and the anchor's words with the notes", async () => {
    const t = await note();
    const s = await note("來源\n", "來源七");
    const cursor = Number((await q<{ m: string }>(`SELECT COALESCE(MAX(id),0)::text AS m FROM domain_events WHERE workspace_id = $1`, [workspaceId])).rows[0]!.m);
    const body = await bodyOf(t.id);
    const made = await (await link(t.id, { source_note_id: s.id, at: body.indexOf(A), seen_text: A })).json() as { anchor_id: string; link_text: string };
    const delta = await buildSyncDelta(admin, workspaceId, { since: cursor, known: [] });
    expect(delta.note_link_bindings!.replace_for).toContain(s.id);
    expect(delta.note_link_bindings!.upsert).toContainEqual({ note_id: s.id, link_text: `${t.title}/${made.link_text}`, anchor_id: made.anchor_id });
    const boot = await buildBootstrap(admin, workspaceId, { slimBodies: false }) as { note_link_bindings?: Array<{ note_id: string; link_text: string; anchor_id: string }>; note_anchors?: Array<{ anchor_id: string; quote: string }> };
    expect(boot.note_link_bindings).toContainEqual({ note_id: s.id, link_text: `${t.title}/${made.link_text}`, anchor_id: made.anchor_id });
    expect(boot.note_anchors?.find((a) => a.anchor_id === made.anchor_id)?.quote).toBe(A);
  });

  it("counts the links that are still written; a binding whose link is gone does not count", async () => {
    const t = await note();
    const s = await note("來源\n", "來源八");
    const body = await bodyOf(t.id);
    const made = await (await link(t.id, { source_note_id: s.id, at: body.indexOf(A), seen_text: A })).json() as { anchor_id: string; link: string };
    const count = async () => ((await (await send(`/nodes/${t.id}/block-link-counts`, "GET")).json()) as { counts: Array<{ anchor_id: string; links: number }> }).counts;
    expect(await count()).toEqual([]); // bound, not yet written into the note's text
    expect((await send(`/nodes/${s.id}`, "PATCH", { markdown: `看 [[${made.link}]] 這段\n` })).status).toBe(200);
    expect(await count()).toEqual([{ anchor_id: made.anchor_id, links: 1 }]);
    expect((await send(`/nodes/${s.id}`, "PATCH", { markdown: "刪掉了\n" })).status).toBe(200);
    expect(await count()).toEqual([]);
  });

  it("confirms a doubtful anchor only for someone who may edit the note", async () => {
    const t = await note();
    const s = await note("來源\n", "來源九");
    const body = await bodyOf(t.id);
    const made = await (await link(t.id, { source_note_id: s.id, at: body.indexOf(B), seen_text: B })).json() as { anchor_id: string };
    const from = body.indexOf(A);
    await q(`UPDATE block_anchors SET status = 'maybe', candidate_from_utf16 = $3, candidate_to_utf16 = $4 WHERE workspace_id = $1 AND anchor_id = $2`, [workspaceId, made.anchor_id, from, from + A.length]);
    const url = `/nodes/${t.id}/block-anchors/${made.anchor_id}/confirm`;
    current = viewer;
    try { expect((await send(url, "POST")).status).toBe(403); } finally { current = admin; }
    expect((await listNoteAnchors(workspaceId, t.id)).find((a) => a.anchorId === made.anchor_id)!.status).toBe("maybe");
    expect(await (await send(url, "POST")).json()).toEqual({ confirmed: true });
    const a = (await listNoteAnchors(workspaceId, t.id)).find((x) => x.anchorId === made.anchor_id)!;
    expect(a.status).toBe("valid");
    expect(body.slice(a.span.from, a.span.to)).toBe(A);
    expect(await (await send(url, "POST")).json()).toEqual({ confirmed: false });
  });

  it("a backup keeps the bindings and puts them back on the restored note", async () => {
    const t = await note();
    const s = await note("來源\n", "來源十");
    const body = await bodyOf(t.id);
    const made = await (await link(t.id, { source_note_id: s.id, at: body.indexOf(A), seen_text: A })).json() as { anchor_id: string; link_text: string };
    const rows = (await bindingBackupRowsByNote(workspaceId, [s.id])).get(s.id) ?? [];
    expect(rows).toEqual([{ text: `${t.title}/${made.link_text}`, anchor: made.anchor_id }]);
    const copy = await note("來源的還原\n", "來源還原");
    expect(await restoreBackupBindings(workspaceId, copy.id, rows)).toBe(1);
    expect(await restoreBackupBindings(workspaceId, copy.id, rows)).toBe(0); // idempotent
    expect(await bindings(copy.id)).toEqual([{ link_text: rows[0]!.text, anchor_id: made.anchor_id }]);
  });

  it("the published site reads [[筆記/段落]] by its words: 「筆記 › 開頭」, no anchor leaves the app", () => {
    const pages = [
      { id: "p1", slug: "algo", title: "演算法", markdown: BODY },
      { id: "p2", slug: "home", title: "首頁", markdown: "看 [[演算法/雜湊表]]" },
    ];
    const html = md2html("看 [[演算法/雜湊表]] 與 [[演算法/不存在的段]]", { pages, from: "p2", relative: false } as never);
    expect(html).toContain("演算法 › 雜湊表用鍵直接算出位置");
    expect(html).toContain("演算法/不存在的段"); // a part that is not found stays as typed
    expect(html).not.toMatch(/block_anchors|anchor_id/);
  });
});
