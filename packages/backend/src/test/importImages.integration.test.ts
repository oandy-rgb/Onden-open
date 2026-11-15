import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { q, getWorkspaceId } from "../db.js";
import { apiOnError } from "../httpError.js";
import importRouter from "../modules/importers/routes.js";
import { MEDIA_DIR } from "../services/mediaStore.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { prepareImportedImages } from "../modules/importers/shared/images.js";
import { adminOnlySpace, makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { storeMedia } from "../services/media.js";
import { canReadNode } from "../services/readPolicy.js";
import { canReadMedia } from "../services/mediaAccess.js";
import sharp from "sharp";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";

registerShippedModules();

const enabled = isTestDatabase();
const actor: ActorCtx = { id: "image-import-audit", name: "Image audit", type: "human", role: "admin" };
type File = { path: string; content: string } | { path: string; base64: string; kind: "image" };
async function upload(files: File[], as = actor) {
  const app = new Hono<{ Variables: { actor: ActorCtx } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", as); await next(); });
  app.route("/api/import", importRouter);
  const res = await app.request("/api/import/obsidian", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: { id:"legacy",name:"Older imports" }, files, upsert: true }) });
  expect(res.status).toBe(200);
  return res.json();
}
const image = (path: string, color: string): File => ({ path, kind: "image", base64: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><rect fill="${color}" width="10" height="10"/></svg>`).toString("base64") });
const mediaUrl = (md: string) => md.match(/\/api\/media\/[a-z0-9.]+/)![0];
const bytes = (url: string) => readFileSync(join(MEDIA_DIR, url.split("/").pop()!), "utf8");

describe.skipIf(!enabled)("imported image identity and reference resolution", () => {
  let ws: string;
  beforeAll(async () => {
    ws = await getWorkspaceId();
    Object.assign(actor, await persistActor(ws, actor));
  });
  const note = async (path: string) => (await q<{ id: string; markdown: string }>(`SELECT n.id,n.markdown FROM content_nodes n JOIN node_attributes a ON a.node_id=n.id AND a.key='_import_path' WHERE n.workspace_id=$1 AND a.value=$2 AND n.deleted_at IS NULL`, [ws, path])).rows[0]!;

  it("reuses identical bytes after another upload and keeps the note unchanged", async () => {
    const path = `${randomUUID()}/note.md`, picture = image("images/repeat.svg", `#${randomUUID().slice(0,6)}`);
    const files = [{ path, content: "![picture](../images/repeat.svg)" }, picture];
    expect(await upload(files)).toMatchObject({ imported: 1, images_imported: 1 });
    const first = await note(path);
    expect(await upload(files)).toMatchObject({ imported: 0, updated: 0, unchanged: 1, images_imported: 0, images_reused: 1 });
    expect(await note(path)).toEqual(first);
  });

  it("resolves identical basenames relative to each note instead of choosing the last image", async () => {
    const root = randomUUID(), pathA = `${root}/a/note.md`, pathB = `${root}/b/note.md`;
    await upload([{ path: pathA, content: "![A](image.svg)" }, { path: pathB, content: "![B](image.svg)" }, image(`${root}/a/image.svg`, "red"), image(`${root}/b/image.svg`, "blue")]);
    const a = mediaUrl((await note(pathA)).markdown), b = mediaUrl((await note(pathB)).markdown);
    expect(a).not.toBe(b);
    expect(bytes(a)).toContain('fill="red"');
    expect(bytes(b)).toContain('fill="blue"');
  });

  it("creates a new URL for changed bytes and retains the historical image", async () => {
    const path = `${randomUUID()}/n.md`, filePath = `${path}/image.svg`;
    const noteFile = { path, content: "![x](n.md/image.svg)" };
    await upload([noteFile, image(filePath, "red")]);
    const oldUrl = mediaUrl((await note(path)).markdown);
    expect(await upload([noteFile, image(filePath, "green")])).toMatchObject({ updated: 1 });
    const newUrl = mediaUrl((await note(path)).markdown);
    expect(newUrl).not.toBe(oldUrl);
    expect(bytes(oldUrl)).toContain('fill="red"');
    expect(bytes(newUrl)).toContain('fill="green"');
  });

  it("does not reveal another actor or workspace's asset by matching supplied bytes", async () => {
    const file = image("a.svg", `#${randomUUID().slice(0,6)}`);
    const first = await prepareImportedImages({ actor, workspaceId: ws, files: [file] });
    const other = await persistActor(ws, { ...actor, name: "Other uploader" });
    const second = await prepareImportedImages({ actor: other, workspaceId: ws, files: [file] });
    const otherWs = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES($1,$1) RETURNING id", [randomUUID()])).rows[0]!.id;
    const third = await prepareImportedImages({ actor, workspaceId: otherWs, files: [file] });
    const urls = [first, second, third].map(result => mediaUrl(result.rewrite("![x](a.svg)", "n.md")));
    expect(new Set(urls).size).toBe(3);
    expect(second.reused).toBe(0);
  });

  it("does not reuse an asset that is no longer readable, even for the same uploader", async () => {
    const path = `${randomUUID()}/n.md`, pic = image("a.svg", `#${randomUUID().slice(0,6)}`);
    const editor = await persistActor(ws, { ...actor, role: "editor" });
    await upload([{ path, content: "![x](a.svg)" }, pic], editor);
    const original = await note(path), oldUrl = mediaUrl(original.markdown);
    // No longer readable: the note moves to a space the editor is not in.
    await putInSpace(original.id, await adminOnlySpace(ws, `img-${randomUUID()}`, [actor.id]));
    expect(await canReadNode(editor, original.id)).toBe(false);
    expect(await canReadMedia(editor, oldUrl.split("/").pop()!, ws)).toBe(false);
    const prepared = await prepareImportedImages({ actor: editor, workspaceId: ws, files: [pic] });
    expect(prepared.reused).toBe(0);
    expect(mediaUrl(prepared.rewrite("![x](a.svg)", "n.md"))).not.toBe(oldUrl);
    expect((await note(path)).markdown).toBe(original.markdown);
  });

  it("reuses a file only from a note in the space the import lands in (D107)", async () => {
    const path = `${randomUUID()}/n.md`, pic = image("a.svg", `#${randomUUID().slice(0,6)}`);
    const teammate = await persistActor(ws, { ...actor, name: "Teammate", role: "editor" });
    const team = await makeSpace(ws, `team-${randomUUID()}`, [{ id: actor.id, role: "manager" }, { id: teammate.id, role: "editor" }]);
    await upload([{ path, content: "![x](a.svg)" }, pic], actor);
    const original = await note(path), oldFile = mediaUrl(original.markdown).split("/").pop()!;
    expect(await canReadMedia(teammate, oldFile, ws)).toBe(false); // owned by the importer's own space

    // The same bytes imported for space Team: the copy owned elsewhere would
    // hide the image from teammates, so a new id is stored.
    const bytesIn = Buffer.from((pic as { base64: string }).base64, "base64");
    const forTeam = await storeMedia(bytesIn, ".svg", { actor, workspaceId: ws, origin: "import", spaceId: team });
    expect(forTeam).toMatchObject({ ok: true, reused: false });
    const teamFile = (forTeam as { filename: string }).filename;
    expect(teamFile).not.toBe(oldFile);
    const teamNote = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$2,$3) RETURNING id`, [ws, `team-${randomUUID()}`, `![x](/api/media/${teamFile})`])).rows[0]!;
    await putInSpace(teamNote.id, team);
    expect(await canReadMedia(teammate, teamFile, ws)).toBe(true);
    // Imported for Team again, that copy (owned in Team) is reused.
    expect(await storeMedia(bytesIn, ".svg", { actor, workspaceId: ws, origin: "import", spaceId: team }))
      .toMatchObject({ ok: true, reused: true, filename: teamFile });

    // The other way round: the owning note moved to Team, a re-import into
    // the importer's own space stores its own copy too.
    await putInSpace(original.id, team);
    const prepared = await prepareImportedImages({ actor, workspaceId: ws, files: [pic] });
    expect(prepared.reused).toBe(0);
    expect(mediaUrl(prepared.rewrite("![x](a.svg)", "n.md"))).not.toBe(`/api/media/${oldFile}`);
  });

  it("serializes concurrent preparations and reuses one committed file", async () => {
    const file = image("a.svg", `#${randomUUID().slice(0,6)}`);
    const results = await Promise.all([1,2].map(() => prepareImportedImages({ actor, workspaceId: ws, files: [file] })));
    expect(results.reduce((n, result) => n + result.imported, 0)).toBe(1);
    expect(results.reduce((n, result) => n + result.reused, 0)).toBe(1);
    expect(results[0]!.rewrite("![x](a.svg)", "n.md")).toBe(results[1]!.rewrite("![x](a.svg)", "n.md"));
  });

  it("repairs missing or corrupt stored bytes using the verified identical content", async () => {
    const file = image("a.svg", `#${randomUUID().slice(0,6)}`);
    const first = await prepareImportedImages({ actor, workspaceId: ws, files: [file] });
    const url = mediaUrl(first.rewrite("![x](a.svg)", "n.md")), diskPath = join(MEDIA_DIR, url.split("/").pop()!);
    const original = bytes(url);
    unlinkSync(diskPath);
    expect((await prepareImportedImages({ actor, workspaceId: ws, files: [file] })).reused).toBe(1);
    expect(bytes(url)).toBe(original);
    writeFileSync(diskPath, "incomplete");
    await prepareImportedImages({ actor, workspaceId: ws, files: [file] });
    expect(bytes(url)).toBe(original);
  });

  it("sanitizes SVG before hashing and never stores an active script", async () => {
    const file = image("safe.svg", `#${randomUUID().slice(0,6)}`) as { path: string; kind: "image"; base64: string };
    const unsafe = { ...file, base64: Buffer.from(Buffer.from(file.base64, "base64").toString().replace("</svg>", "<script>alert(1)</script></svg>")).toString("base64") };
    const first = await prepareImportedImages({ actor, workspaceId: ws, files: [unsafe] });
    expect(bytes(mediaUrl(first.rewrite("![x](safe.svg)", "n.md")))).not.toContain("script");
    expect((await prepareImportedImages({ actor, workspaceId: ws, files: [file] })).reused).toBe(1);
  });

  it("counts invalid and duplicate paths and leaves their references intact", async () => {
    const result = await prepareImportedImages({ actor, workspaceId: ws, files: [image("dup.svg", "red"), image("dup.svg", "blue"),
      { path: "bad.png", base64: "bm90IGFuIGltYWdl" }, { path: "base64.png", base64: "!!!!" }, image("../escape.svg", "red")] });
    expect(result).toMatchObject({ imported: 0, reused: 0 });
    expect(result.skippedFiles.map(file => file.reason)).toEqual(["unreadable", "unreadable", "unreadable", "unreadable", "unreadable"]);
    expect(result.rewrite("![a](dup.svg) ![b](bad.png)", "n.md")).toBe("![a](dup.svg) ![b](bad.png)");
    expect(result.unresolvedReferences).toBe(2);
  });

  it("accepts supported raster formats without changing their original bytes", async () => {
    for (const format of ["png", "jpeg", "webp", "gif", "avif"] as const) {
      const data = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#a1b2c3" } }).toFormat(format).toBuffer();
      const ext = format === "jpeg" ? "jpg" : format;
      const file = { path: `raster.${ext}`, base64: data.toString("base64") };
      const result = await prepareImportedImages({ actor, workspaceId: ws, files: [file] });
      expect(result.skippedFiles).toEqual([]);
      const url = mediaUrl(result.rewrite(`![x](raster.${ext})`, "n.md"));
      expect(readFileSync(join(MEDIA_DIR, url.split("/").pop()!))).toEqual(data);
    }
  });

  it("propagates a real file read failure instead of claiming reuse or a skipped bad input", async () => {
    const file = image("a.svg", `#${randomUUID().slice(0,6)}`);
    const first = await prepareImportedImages({ actor, workspaceId: ws, files: [file] });
    const url = mediaUrl(first.rewrite("![x](a.svg)", "n.md")), diskPath = join(MEDIA_DIR, url.split("/").pop()!);
    const original = readFileSync(diskPath);
    unlinkSync(diskPath);
    mkdirSync(diskPath);
    try {
      await expect(prepareImportedImages({ actor, workspaceId: ws, files: [file] })).rejects.toMatchObject({ code: "EISDIR" });
    } finally { rmdirSync(diskPath); writeFileSync(diskPath, original); }
    expect((await prepareImportedImages({ actor, workspaceId: ws, files: [file] })).reused).toBe(1);
  });
});
