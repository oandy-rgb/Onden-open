import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import importRouter from "../modules/importers/routes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

registerShippedModules();

// A real Obsidian vault (2026-10-14) imported almost nothing: the whole folder
// went up as one 58 MB request, over nginx's 20 MB, so the frontend now sends
// batches (settings/folderImport.ts). These cases pin what batching relies
// on, and the vault's folder names, which must stay folders.
const enabled = isTestDatabase();
// Its own workspace: every imported note re-links the notes whose [[links]]
// may name it (relinkTarget scans the workspace's bodies), so in the shared
// 'default' one these imports slowed down with everything other files left.
let ws = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
const owner: ActorCtx = { id: "vault-batch-owner", name: "Vault owner", type: "human", role: "admin" };
type File = { path: string; content: string } | { path: string; base64: string; kind: "image" | "pdf" };
type Source = { id: string; name: string };

async function post(body: { files: File[]; source: Source; upsert?: boolean; uploaded_images?: Record<string, string | null> }) {
  const app = new Hono<{ Variables: { actor: ActorCtx } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", owner); await next(); });
  app.route("/api/import", importRouter);
  const res = await app.request("/api/import/obsidian", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ upsert: true, ...body }) });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}
const svg = (path: string, color = `#${randomUUID().slice(0, 6)}`): File => ({ path, kind: "image",
  base64: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><rect fill="${color}" width="10" height="10"/></svg>`).toString("base64") });
const newSource = (): Source => ({ id: randomUUID(), name: "obsidian-vault" });
const pdf = (path: string, text = randomUUID()): File => ({ path, kind: "pdf",
  base64: Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`).toString("base64") });

describe.skipIf(!enabled)("importing a whole vault in batches", () => {
  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Vault batches', $1) RETURNING id::text`, [`vault-batches-${randomUUID()}`])).rows[0]!.id;
    Object.assign(owner, await persistActor(ws, owner));
  });
  /** Live nodes stamped by this source: import path → { id, parent, title, markdown }. */
  async function imported(source: Source) {
    const rows = (await q<{ id: string; parent_id: string | null; title: string; markdown: string; note: string | null; folder: string | null }>(
      `SELECT n.id, n.parent_id, n.title, n.markdown,
              (SELECT value FROM node_attributes WHERE node_id=n.id AND key='_import_path') AS note,
              (SELECT value FROM node_attributes WHERE node_id=n.id AND key='_import_folder_path') AS folder
         FROM content_nodes n JOIN node_attributes s ON s.node_id=n.id AND s.key='_import_source_id' AND s.value=$2
        WHERE n.workspace_id=$1 AND n.deleted_at IS NULL`, [ws, source.id])).rows;
    return {
      notes: new Map(rows.filter(row => row.note).map(row => [row.note!, row])),
      folders: new Map(rows.filter(row => row.folder).map(row => [row.folder!, row])),
      count: rows.length,
    };
  }

  it("keeps full-width parentheses, unclosed brackets and inner/trailing spaces as nested folders", async () => {
    const source = newSource();
    const paths = [
      "1.Project（專案/計畫.md",
      "2.Area（領域/_Calendar（日記/每日日記/2026-10-14.md",
      "3.Archive（封存/Extra （額外資料/註解/[未完.md",
      "_Inbox（暫存/[[半開/筆記 .md",
      "尾端空白 /內容.md",
      "cpu.md",
    ];
    const result = await post({ source, files: paths.map(path => ({ path, content: path.endsWith("cpu.md") ? "" : `Body of ${path}` })) });
    expect(result).toMatchObject({ imported: paths.length, skipped: 0, folders_skipped: 0, conflicts: [] });
    const { notes, folders } = await imported(source);
    expect([...notes.keys()].sort()).toEqual([...paths].sort());
    const parentOf = (path: string) => folders.get(path.slice(0, path.lastIndexOf("/")))?.id;
    for (const path of paths.filter(path => path.includes("/"))) expect(notes.get(path)!.parent_id).toBe(parentOf(path));
    expect(folders.get("3.Archive（封存/Extra （額外資料")!.parent_id).toBe(folders.get("3.Archive（封存")!.id);
    expect(folders.get("3.Archive（封存/Extra （額外資料")!.title).toBe("Extra （額外資料");
    expect(notes.get("cpu.md")!.parent_id).toBeNull();
  });

  it("resolves a note's image sent in an earlier batch, and reuses that batch's folders", async () => {
    const source = newSource();
    const images = await post({ source, files: [svg("3.Archive（封存/Extra （額外資料/圖片/a.svg")] });
    expect(images.image_urls["3.Archive（封存/Extra （額外資料/圖片/a.svg"]).toMatch(/^\/api\/media\/[0-9a-f]{32}\.svg$/);
    const first = await post({ source, uploaded_images: images.image_urls, files: [
      { path: "3.Archive（封存/Extra （額外資料/註解/n.md", content: "![[a.svg]] and ![rel](../圖片/a.svg)" },
    ] });
    expect(first).toMatchObject({ imported: 1, image_refs_unresolved: 0 });
    const second = await post({ source, uploaded_images: images.image_urls, files: [
      { path: "3.Archive（封存/Extra （額外資料/註解/m.md", content: "second batch" },
    ] });
    expect(second).toMatchObject({ imported: 1, folders: 0, folders_reused: 3 });
    const { notes, folders } = await imported(source);
    const url = images.image_urls["3.Archive（封存/Extra （額外資料/圖片/a.svg"];
    expect(notes.get("3.Archive（封存/Extra （額外資料/註解/n.md")!.markdown).toBe(`![a](${url}) and ![rel](${url})`);
    expect(folders.size).toBe(3);
  });

  it("never trusts an uploaded image URL the actor cannot read: the reference stays as written", async () => {
    const source = newSource();
    const result = await post({ source, uploaded_images: { "x.svg": `/api/media/${"0".repeat(32)}.svg`, "y.svg": "https://example.com/y.svg" },
      files: [{ path: "n.md", content: "![x](x.svg) ![y](y.svg)" }] });
    expect(result).toMatchObject({ imported: 1, image_refs_unresolved: 2 });
    expect((await imported(source)).notes.get("n.md")!.markdown).toBe("![x](x.svg) ![y](y.svg)");
  });

  it("re-importing the full set into the same source adds only the missing notes, without duplicates", async () => {
    const source = newSource();
    const all = Array.from({ length: 12 }, (_, i) => ({ path: `2.Area（領域/資工主內容/第${i % 3}章/${i}.md`, content: `note ${i}` }));
    expect(await post({ source, files: all.slice(0, 4) })).toMatchObject({ imported: 4 });
    expect(await post({ source, files: all })).toMatchObject({ imported: 8, unchanged: 4, skipped: 0, folders_skipped: 0 });
    const after = await imported(source);
    expect(after.notes.size).toBe(12);
    expect(after.folders.size).toBe(5);
    expect(after.count).toBe(17);
  });

  it("lists every skipped note and image with a reason", async () => {
    const source = newSource();
    // Two copy imports leave two folders with this source + path: reuse is
    // ambiguous, the folder is skipped, and its note must say so.
    await post({ source, upsert: false, files: [{ path: "重複（資料夾/a.md", content: "a" }] });
    await post({ source, upsert: false, files: [{ path: "重複（資料夾/a.md", content: "a" }] });
    const result = await post({ source, files: [
      { path: "重複（資料夾/b.md", content: "b" },
      { path: "bad.png", kind: "image", base64: Buffer.from("not an image").toString("base64") },
    ] });
    expect(result).toMatchObject({ skipped: 1, folders_skipped: 1, images_skipped: 1 });
    expect(result.conflicts).toEqual([{ path: "重複（資料夾/b.md", reason: "folder_unavailable" }]);
    expect(result.skipped_images).toEqual([{ path: "bad.png", reason: "unreadable" }]);
    expect(result.image_urls).toEqual({ "bad.png": null });
  });
  it("a vault's PDFs are stored and ![[x.pdf]] links to them; an unclosed embed leaves the next line alone", async () => {
    const source = newSource();
    const dir = "3.Archive（封存/Extra （額外資料/圖片";
    const files: File[] = [
      pdf("1121-exam2_241016_104956.pdf"),
      svg(`${dir}/Pasted image 20241027003912.jpg`.replace(/\.jpg$/, ".svg")),
      svg(`${dir}/Pasted image 20241027003046.svg`),
      { path: "書籤 新.md", content: "考卷：![[1121-exam2_241016_104956.pdf]]" },
      { path: "2.Area（領域/離散數學/Ppt離散數學.md",
        content: "![[Pasted image 20241027003912.svg\n![[Pasted image 20241027003046.svg]]" },
      { path: "fake.md", content: "![[not-a-pdf.pdf]]" },
      { ...pdf("not-a-pdf.pdf"), base64: Buffer.from("hello").toString("base64") },
    ];
    const first = await post({ source, files });
    expect(first).toMatchObject({ imported: 3, pdfs_imported: 1, skipped_images: [{ path: "not-a-pdf.pdf", reason: "unreadable" }] });
    const { notes } = await imported(source);
    expect(notes.get("書籤 新.md")!.markdown).toMatch(/^考卷：\[1121-exam2_241016_104956\]\(\/api\/media\/[0-9a-f]{32}\.pdf\)$/);
    const ppt = notes.get("2.Area（領域/離散數學/Ppt離散數學.md")!.markdown;
    expect(ppt.split("\n")[0]).toBe("![[Pasted image 20241027003912.svg");
    expect(ppt.split("\n")[1]).toMatch(/^!\[Pasted image 20241027003046\]\(\/api\/media\/[0-9a-f]{32}\.svg\)$/);
    expect(notes.get("fake.md")!.markdown).toBe("![[not-a-pdf.pdf]]");

    // Importing the same folder again: the same files come back, nothing doubles.
    const again = await post({ source, files });
    expect(again).toMatchObject({ imported: 0, unchanged: 3, pdfs_imported: 1, images_reused: 3 });
    expect((await imported(source)).count).toBe((await imported(source)).count);
    const after = await imported(source);
    expect(after.notes.size).toBe(3);
    expect(after.notes.get("書籤 新.md")!.markdown).toBe(notes.get("書籤 新.md")!.markdown);
  });
  it("re-importing with Obsidian's trash ticked adds only the trash notes, under their folder", async () => {
    const source = newSource();
    const vault: File[] = [{ path: "課程/筆記.md", content: "現行" }, { path: "日記.md", content: "今天" }];
    await post({ source, files: vault });
    const trash: File[] = [{ path: "Obsidian 垃圾桶/舊筆記.md", content: "丟掉的" }, { path: "Obsidian 垃圾桶/課程/草稿.md", content: "草稿" }];
    const again = await post({ source, files: [...vault, ...trash] });
    expect(again).toMatchObject({ imported: 2, unchanged: 2, skipped: 0 });
    const { notes, folders } = await imported(source);
    expect([...notes.keys()].sort()).toEqual(["Obsidian 垃圾桶/舊筆記.md", "Obsidian 垃圾桶/課程/草稿.md", "日記.md", "課程/筆記.md"].sort());
    expect(notes.get("Obsidian 垃圾桶/課程/草稿.md")!.parent_id).toBe(folders.get("Obsidian 垃圾桶/課程")!.id);
    expect(folders.get("Obsidian 垃圾桶/課程")!.parent_id).toBe(folders.get("Obsidian 垃圾桶")!.id);
    // A third run changes nothing.
    expect(await post({ source, files: [...vault, ...trash] })).toMatchObject({ imported: 0, unchanged: 4 });
    expect((await imported(source)).notes.size).toBe(4);
  });
});
