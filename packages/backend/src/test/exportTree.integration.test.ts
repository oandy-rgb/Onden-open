// D106 + D109: the Markdown zip export → folder import round trip keeps the
// note tree and the values a person set in the app.
// Before the fix:
//   (D109) the zip was flat (`${slug}.md`), so `課程/演算法.md` imported,
//          exported and imported again came back as two root notes;
//   (D106) a writer stored `explicit`, which the export left out, so an
//          `author` set there was lost on re-import (the same value typed in a
//          table cell, `ui`, was kept).
// As in exportRoundTrip.integration.test.ts: export through GET
// /api/export/markdown.zip, trash the originals (as if importing into a fresh
// workspace) and send the files to POST /api/import/obsidian.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { q, getWorkspaceId } from "../db.js";

// A workspace of its own: the export is the whole workspace, so in the shared
// default one its size (and time) would grow with every other test's notes.
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
import { apiOnError } from "../httpError.js";
import importRouter from "../modules/importers/routes.js";
import exportRouter from "../routes/export.js";
import { createNote } from "../services/noteCreate.js";
import { setNodeAttribute } from "../services/attributeWrites.js";
import { duplicateNote } from "../services/noteDuplicate.js";
import { readFrontmatter, entryValue } from "@onden/markdown";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";

const enabled = isTestDatabase();
const actor: ActorCtx = { id: "export-tree", name: "Export tree", type: "human", role: "admin" };

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

describe.skipIf(!enabled)("export → import keeps the note tree and attribute values (D106, D109)", () => {
  let ws: string;
  const stamp = randomUUID().slice(0, 8);
  const title = (name: string) => `D109 ${name} ${stamp}`;
  const ids: Record<string, string> = {};
  let exported: Map<string, Buffer>;
  /** Exported file path by note title, for this test's notes. */
  let fileOf: Map<string, string>;
  const names = ["課程", "演算法", "排序", "Dune"];
  const source = { id: randomUUID(), name: `D109 ${stamp}` };

  const attribute = async (nodeId: string, key: string) => (await q<{ value: string; source: string }>(
    `SELECT value, source FROM node_attributes WHERE node_id = $1 AND key = $2`, [nodeId, key])).rows[0];
  const setAuthor = (nodeId: string, value: string) => setNodeAttribute({
    workspaceId: ws, actor, nodeId, attribute: { key: "author", value, value_type: "text", is_inheritable: false },
  });
  const live = async (name: string) => (await q<{ id: string; parent_id: string | null }>(
    `SELECT id, parent_id::text FROM content_nodes WHERE workspace_id = $1 AND title = $2 AND deleted_at IS NULL`, [ws, title(name)])).rows;

  async function importExported(): Promise<Record<string, unknown>> {
    const files = names.map((name) => {
      const path = fileOf.get(title(name))!;
      return { path, content: exported.get(path)!.toString("utf8") };
    });
    const res = await app().request("/api/import/obsidian", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, files, upsert: true }) });
    expect(res.status, await res.clone().text()).toBe(200);
    return res.json() as Promise<Record<string, unknown>>;
  }

  /** Trash the originals and import the zip, once, whichever test needs it
   *  first: the re-import test compares against this first import. */
  let firstImport: Promise<Record<string, unknown>> | null = null;
  const importOnce = () => firstImport ??= (async () => {
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = ANY($1::uuid[])`, [Object.values(ids)]);
    return importExported();
  })();

  beforeAll(async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('D109', $1) RETURNING id::text`, [`d109-${randomUUID()}`])).rows[0]!.id;
    ws = await getWorkspaceId();
    Object.assign(actor, await persistActor(ws, actor));
    const note = async (name: string, parentId: string | null) => {
      const created = await createNote({ actor, workspaceId: ws, title: title(name), markdown: `${name} body\n`, parentId, event: { uiContext: "test.d109" } });
      ids[name] = String(created.node.id);
    };
    await note("課程", null);
    await note("演算法", ids["課程"]!);
    await note("排序", ids["演算法"]!);
    // A value from before D106: the bookmark route… wrote it as `explicit`;
    // it is still a person's value.
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source)
             VALUES ($1, $2, 'venue', 'SIGCSE', 'text', 'explicit')`, [ws, ids["演算法"]]);
    // A note whose author is set, then edited, in the app.
    await note("Dune", null);
    await setAuthor(ids.Dune!, "Frank Herbert");
    await setAuthor(ids.Dune!, "王小明");

    const res = await app().request("/api/export/markdown.zip");
    expect(res.status).toBe(200);
    exported = unzip(Buffer.from(await res.arrayBuffer()));
    const wanted = new Set(names.map(title));
    fileOf = new Map([...exported].filter(([path]) => path.endsWith(".md")).flatMap(([path, data]) => {
      const t = String(frontmatter(data.toString("utf8")).title);
      return wanted.has(t) ? [[t, path] as const] : [];
    }));
  });

  it("an app write stores a person's value as ui, not legacy explicit", async () => {
    expect(await attribute(ids.Dune!, "author")).toEqual({ value: "王小明", source: "ui" });
  });

  it("a duplicate keeps the values set in the app (and a legacy explicit one, as ui)", async () => {
    // Its own originals: the round-trip tests trash the shared ones.
    const item = await createNote({ actor, workspaceId: ws, title: `D109 dup ${stamp}`, markdown: "x\n", parentId: null, event: { uiContext: "test.d109" } });
    await setAuthor(String(item.node.id), "Frank Herbert");
    await setAuthor(String(item.node.id), "王小明");
    const legacy = await createNote({ actor, workspaceId: ws, title: `D109 dup legacy ${stamp}`, markdown: "x\n", parentId: null, event: { uiContext: "test.d109" } });
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source)
             VALUES ($1, $2, 'venue', 'SIGCSE', 'text', 'explicit')`, [ws, legacy.node.id]);
    const copy = await duplicateNote({ workspaceId: ws, actor, sourceId: String(item.node.id) });
    expect(await attribute(String(copy.node.id), "author")).toEqual({ value: "王小明", source: "ui" });
    const childCopy = await duplicateNote({ workspaceId: ws, actor, sourceId: String(legacy.node.id) });
    expect(await attribute(String(childCopy.node.id), "venue")).toEqual({ value: "SIGCSE", source: "ui" });
    // Copies are not part of the round trip below.
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = ANY($1::uuid[])`, [[copy.node.id, childCopy.node.id]]);
  });

  it("the zip writes the tree as folders: a parent note is a folder plus its own file beside it", async () => {
    // A file is named by the note's title, which is what Obsidian links by.
    const [course, algo, sort] = [title("課程"), title("演算法"), title("排序")];
    expect(fileOf.get(title("課程"))).toBe(`${course}.md`);
    expect(fileOf.get(title("演算法"))).toBe(`${course}/${algo}.md`);
    expect(fileOf.get(title("排序"))).toBe(`${course}/${algo}/${sort}.md`);
    // Values a person set are in the frontmatter, whichever rail wrote them.
    expect(frontmatter(exported.get(fileOf.get(title("Dune"))!)!.toString("utf8")).author).toBe("王小明");
    expect(frontmatter(exported.get(fileOf.get(title("演算法"))!)!.toString("utf8")).venue).toBe("SIGCSE");
  });

  it("imports them into a fresh workspace with the tree and the attributes", async () => {
    const result = await importOnce();
    // The parent note IS the folder: no extra empty "課程" folder note.
    expect(result).toMatchObject({ imported: 4, skipped: 0, folders: 0, folders_skipped: 0, conflicts: [] });
    const [course] = await live("課程");
    const [algo] = await live("演算法");
    const [sort] = await live("排序");
    const [dune] = await live("Dune");
    expect(await live("課程")).toHaveLength(1);
    expect(course!.parent_id).toBeNull();
    expect(algo!.parent_id).toBe(course!.id);
    expect(sort!.parent_id).toBe(algo!.id);
    expect((await attribute(dune!.id, "author"))!.value).toBe("王小明");
    expect((await attribute(algo!.id, "venue"))!.value).toBe("SIGCSE");
  });

  it("re-importing the same files changes nothing and makes no second tree", async () => {
    await importOnce();
    const result = await importExported();
    expect(result).toMatchObject({ imported: 0, updated: 0, unchanged: 4, skipped: 0, folders: 0, folders_reused: 0 });
    for (const name of names) expect(await live(name), name).toHaveLength(1);
  });
});
