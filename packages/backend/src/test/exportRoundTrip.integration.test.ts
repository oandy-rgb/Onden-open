// D91: the Markdown zip export → folder import round trip keeps what a note
// is, not only its body text. Before the fix:
//   (1) a body link to a PDF exported its file, but the import left the link
//       dead (only image syntax was rewritten) and the PDF orphaned;
//   (2) a PDF note (empty body, pdf_url attribute) exported as a title alone;
//   (3) a media field (`cover: /api/media/a.png`) was neither copied nor
//       rewritten;
//   (4) an audio embed exported its file, but the import ignored .mp3;
//   (5) a relation field exported its raw node id, dangling in any other
//       workspace.
// The test exports through GET /api/export/markdown.zip, unpacks the archive,
// trashes the originals (as if importing elsewhere) and imports the files
// through POST /api/import/obsidian, as the folder import sends them.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import sharp from "sharp";
import { q, getWorkspaceId } from "../db.js";

// A workspace of its own: a backup or export reads the whole workspace, so in
// the shared default workspace its cost would grow with every other test's
// notes (on a reused DB the export query alone took 1–2 s).
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
import { apiOnError } from "../httpError.js";
import importRouter from "../modules/importers/routes.js";
import exportRouter from "../routes/export.js";
import { MEDIA_DIR } from "../services/mediaStore.js";
import { storeMedia } from "../services/media.js";
import { createNote } from "../services/noteCreate.js";
import { readFrontmatter, entryValue } from "@onden/markdown";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";

registerShippedModules();

const enabled = isTestDatabase();
const actor: ActorCtx = { id: "export-roundtrip", name: "Round trip", type: "human", role: "admin" };

function app() {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/import", importRouter);
  hono.route("/api/export", exportRouter);
  return hono;
}

/** The entries of a zip archive (central directory → local data). */
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

const frontmatter = (file: string) => Object.fromEntries((readFrontmatter(file)?.entries ?? []).flatMap((e) => (e.key ? [[e.key, entryValue(e)]] : [])));
const mediaFile = (url: string) => readFileSync(join(MEDIA_DIR, url.replace("/api/media/", "")));

describe.skipIf(!enabled)("Markdown export → import round trip (D91)", () => {
  let ws: string;
  const stamp = randomUUID().slice(0, 8);
  const title = (name: string) => `D91 ${name} ${stamp}`;
  const ids: Record<string, string> = {};
  const urls: Record<string, string> = {};
  const bytes: Record<string, Buffer> = {};
  let exported: Map<string, Buffer>;
  let byTitle: Map<string, { name: string; text: string }>;

  async function note(name: string, markdown: string, attributes: Array<{ key: string; value: string; value_type?: "node_ref" }> = []) {
    const created = await createNote({ actor, workspaceId: ws, title: title(name), markdown, parentId: null, attributes, event: { uiContext: "test.d91" } });
    ids[name] = String(created.node.id);
  }
  async function media(name: string, data: Buffer, ext: string) {
    const stored = await storeMedia(data, ext, { actor, workspaceId: ws, origin: "upload" });
    if (!stored.ok) throw new Error(`could not store ${name}: ${stored.reason}`);
    urls[name] = stored.url;
    bytes[name] = readFileSync(join(MEDIA_DIR, stored.filename));
  }

  beforeAll(async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Test', $1) RETURNING id::text`, [`export-rt-${randomUUID()}`])).rows[0]!.id;
    ws = await getWorkspaceId();
    Object.assign(actor, await persistActor(ws, actor));
    // Only its own notes: out of 共用, the actor reads its personal space (its
    // notes land there), so the archive holds what this test wrote and not
    // every other test's notes in the shared database.
    await q(`DELETE FROM space_members m USING spaces s WHERE s.id = m.space_id AND s.workspace_id = $1 AND s.is_default AND m.actor_id = $2`, [ws, actor.id]);
    await media("paper", Buffer.from(`%PDF-1.4 paper ${stamp}`), ".pdf");
    await media("scan", Buffer.from(`%PDF-1.4 scan ${stamp}`), ".pdf");
    await media("cover", await sharp({ create: { width: 4, height: 4, channels: 3, background: "#c33" } }).png().toBuffer(), ".png");
    await media("song", Buffer.from(`ID3 song ${stamp}`), ".mp3");
    await note("Paper link", `Read [the paper](${urls.paper}).\n`);
    await note("PDF note", "", [{ key: "pdf_url", value: urls.scan! }]);
    await note("Cover", "Has a cover.\n", [{ key: "cover", value: urls.cover! }]);
    await note("Audio", `![](${urls.song})\n`);
    await note("Target", "The related note.\n");
    await note("Missing", "Not in the import.\n");
    await note("Related", "Points at Target.\n", [
      { key: "related", value: ids.Target!, value_type: "node_ref" },
      { key: "gone", value: ids.Missing!, value_type: "node_ref" },
    ]);

    const res = await app().request("/api/export/markdown.zip");
    expect(res.status).toBe(200);
    exported = unzip(Buffer.from(await res.arrayBuffer()));
    byTitle = new Map([...exported].filter(([name]) => name.endsWith(".md")).map(([name, data]) => {
      const text = data.toString("utf8");
      return [String(frontmatter(text).title), { name, text }] as const;
    }));
  });

  it("exports a self-contained file per note: media in body and frontmatter bundled, relations as [[Title]]", () => {
    const file = (name: string) => byTitle.get(title(name))!.text;
    const attachment = (name: string) => `./attachments/${urls[name]!.replace("/api/media/", "")}`;
    expect(file("Paper link")).toContain(`[the paper](${attachment("paper")})`);
    expect(frontmatter(file("PDF note")).pdf_url).toBe(attachment("scan"));
    expect(frontmatter(file("Cover")).cover).toBe(attachment("cover"));
    expect(file("Audio")).toContain(`![](${attachment("song")})`);
    expect(frontmatter(file("Related")).related).toBe(`[[${title("Target")}]]`);
    for (const name of ["paper", "scan", "cover", "song"]) {
      expect(exported.get(attachment(name).slice(2)), name).toEqual(bytes[name]);
    }
    for (const { text } of byTitle.values()) expect(text).not.toMatch(/\/api\/media\//);
  });

  // The import half of the trip, run once by whichever test needs it first.
  let importRun: Promise<{ status: number; result: Record<string, unknown> }> | undefined;
  const importExported = () => importRun ??= (async () => {
    // As if into another workspace: the originals are gone.
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = ANY($1::uuid[])`, [Object.values(ids)]);
    const notes = ["Paper link", "PDF note", "Cover", "Audio", "Target", "Related"].map((name) => byTitle.get(title(name))!);
    const files = [
      ...notes.map(({ name, text }) => ({ path: name, content: text })),
      ...Object.values(urls).map((url) => `attachments/${url.replace("/api/media/", "")}`)
        .map((path) => ({ path, base64: exported.get(path)!.toString("base64"), kind: "media" })),
    ];
    const res = await app().request("/api/import/obsidian", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: randomUUID(), name: `D91 ${stamp}` }, files, upsert: true }) });
    return { status: res.status, result: await res.json() as Record<string, unknown> };
  })();

  it("imports them back with live links, the PDF note, the media field, the audio and the relation", async () => {
    const { status, result } = await importExported();
    expect(status).toBe(200);
    expect(result).toMatchObject({ imported: 6, skipped: 0, relations_resolved: 1, relations_unresolved: 1,
      unresolved_relations: [{ path: byTitle.get(title("Related"))!.name, key: "gone", value: `[[${title("Missing")}]]` }] });

    const imported = async (name: string) => (await q<{ id: string; markdown: string }>(
      `SELECT id, markdown FROM content_nodes WHERE workspace_id = $1 AND title = $2 AND deleted_at IS NULL`, [ws, title(name)])).rows;
    const attribute = async (nodeId: string, key: string) => (await q<{ value: string; value_type: string }>(
      `SELECT value, value_type FROM node_attributes WHERE node_id = $1 AND key = $2`, [nodeId, key])).rows[0];
    const stored = (text: string) => text.match(/\/api\/media\/[0-9a-f]{32}\.[a-z0-9]+/)?.[0];

    // (1) the PDF link points at the re-uploaded file, with the same bytes.
    const [paper] = await imported("Paper link");
    const paperUrl = stored(paper!.markdown)!;
    expect(paper!.markdown).toContain(`[the paper](${paperUrl})`);
    expect(mediaFile(paperUrl)).toEqual(bytes.paper);
    // (2) the PDF note is a PDF note again.
    const [pdfNote] = await imported("PDF note");
    const pdfUrl = (await attribute(pdfNote!.id, "pdf_url"))!.value;
    expect(pdfUrl).toMatch(/^\/api\/media\/[0-9a-f]{32}\.pdf$/);
    expect(mediaFile(pdfUrl)).toEqual(bytes.scan);
    // (3) the media field names the re-uploaded image.
    const [cover] = await imported("Cover");
    const coverUrl = (await attribute(cover!.id, "cover"))!.value;
    expect(existsSync(join(MEDIA_DIR, coverUrl.replace("/api/media/", "")))).toBe(true);
    expect(mediaFile(coverUrl)).toEqual(bytes.cover);
    // (4) the audio embed plays the re-uploaded .mp3.
    const [audio] = await imported("Audio");
    expect(audio!.markdown).toMatch(/!\[\]\(\/api\/media\/[0-9a-f]{32}\.mp3\)/);
    expect(mediaFile(stored(audio!.markdown)!)).toEqual(bytes.song);
    // (5) the relation names the imported Target, not the old id; the one
    // whose note was not imported keeps its text.
    const [related] = await imported("Related");
    const [target] = await imported("Target");
    expect(await attribute(related!.id, "related")).toEqual({ value: target!.id, value_type: "node_ref" });
    expect((await attribute(related!.id, "gone"))!.value).toBe(`[[${title("Missing")}]]`);
  });

  it("exports the imported notes again as the same frontmatter", async () => {
    expect((await importExported()).status).toBe(200);
    const res = await app().request("/api/export/markdown.zip");
    const again = unzip(Buffer.from(await res.arrayBuffer()));
    const file = [...again.values()].map((data) => data.toString("utf8"))
      .find((text) => text.startsWith("---") && frontmatter(text).title === title("Related"))!;
    expect(frontmatter(file).related).toBe(`[[${title("Target")}]]`);
    const pdfNote = [...again.values()].map((data) => data.toString("utf8"))
      .find((text) => text.startsWith("---") && frontmatter(text).title === title("PDF note"))!;
    expect(String(frontmatter(pdfNote).pdf_url)).toMatch(/^\.\/attachments\/[0-9a-f]{32}\.pdf$/);
  });
});
