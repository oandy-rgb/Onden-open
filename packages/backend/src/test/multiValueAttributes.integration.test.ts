// D117: multi-value attributes (a JSON array in the value column) have one
// codec (@onden/markdown attributeValues/encodeValues) and every door reads
// them alike. Before the fix:
//   (1) a pack field `topics: select [ml, db], cardinality many` refused the
//       panel's `["ml"]` (422 "must be one of": the gate checked the whole
//       string), and number/date/rating "many" fields could never be saved;
//   (2) an exported relation list re-imported as `["idA","idB"]`, but nothing
//       read it as a list (the panel showed it empty);
//   (3) an Obsidian `authors: [Alice, Bob]` never matched `authors eq Alice`.
// (The panel's side of (2) — showing both targets and a pick adding — is
// src/test/MultiValueFields.test.tsx in the frontend.)
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { q } from "../db.js";

// A workspace of its own (as exportTree.integration.test.ts): the export is the
// whole workspace, and the shared default one holds whatever other files left
// there (media whose read check needs the website module, thousands of notes).
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
import { apiOnError } from "../httpError.js";
import importRouter from "../modules/importers/routes.js";
import exportRouter from "../routes/export.js";
import nodeRouter from "../routes/nodes.js";
import tagsRouter from "../routes/tags.js";
import queryRouter from "../routes/query.js";
import { createNote } from "../services/noteCreate.js";
import { attributeValues, readFrontmatter, entryValue } from "@onden/markdown";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";

const enabled = isTestDatabase();
const actor: ActorCtx = { id: "multi-value", name: "Multi value", type: "human", role: "admin" };

function app() {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/import", importRouter);
  hono.route("/api/export", exportRouter);
  hono.route("/api/nodes", nodeRouter);
  hono.route("/api/tags", tagsRouter);
  hono.route("/api/query", queryRouter);
  return hono;
}
const send = (path: string, method: string, json: unknown) =>
  app().request(path, { method, headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify(json) });

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

describe.skipIf(!enabled)("multi-value attributes (D117)", () => {
  let ws: string;
  const stamp = randomUUID().slice(0, 8);
  const title = (name: string) => `D117 ${name} ${stamp}`;
  const tagName = `d117-${stamp}`;
  let tagId = "";
  let noteId = "";
  const attribute = async (nodeId: string, key: string) => (await q<{ value: string; value_type: string }>(
    `SELECT value, value_type FROM node_attributes WHERE node_id = $1 AND key = $2`, [nodeId, key])).rows[0];
  const note = async (name: string, markdown: string, attributes: Array<{ key: string; value: string; value_type?: "node_ref" }> = []) =>
    String((await createNote({ actor, workspaceId: ws, title: title(name), markdown, parentId: null, attributes, event: { uiContext: "test.d117" } })).node.id);

  beforeAll(async () => {
    ws = ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('D117', $1) RETURNING id::text`, [`d117-${stamp}`])).rows[0]!.id;
    Object.assign(actor, await persistActor(ws, actor));
    const pack = await send("/api/tags/import", "POST", {
      name: tagName,
      fields: [
        { name: "topics", type: "select", options: ["ml", "db"], cardinality: "many" },
        { name: "scores", type: "number", cardinality: "many" },
        { name: "due", type: "date", cardinality: "many" },
        { name: "stars", type: "rating", cardinality: "many" },
      ],
    });
    expect(pack.status).toBe(201);
    tagId = ((await pack.json()) as { id: string }).id;
    noteId = await note("Tagged", "Tagged note.\n");
    expect((await send(`/api/nodes/${noteId}/tags/${tagId}`, "PUT", {})).status).toBe(200);
  });

  it("a select-many field saves the panel's list, and refuses a list holding a value it refuses", async () => {
    const res = await send(`/api/nodes/${noteId}/attributes/topics`, "PUT", { value: '["ml"]' });
    expect(res.status).toBe(200);
    expect(await attribute(noteId, "topics")).toEqual({ value: '["ml"]', value_type: "text" });
    expect((await send(`/api/nodes/${noteId}/attributes/topics`, "PUT", { value: '["ml","db"]' })).status).toBe(200);

    const refused = await send(`/api/nodes/${noteId}/attributes/topics`, "PUT", { value: '["ml","web"]' });
    expect(refused.status).toBe(422);
    expect(JSON.stringify(await refused.json())).toContain('\\"topics\\" must be one of: ml, db');
    expect((await attribute(noteId, "topics"))!.value).toBe('["ml","db"]');
  });

  it("number, date and rating many fields can be saved, stored as text; a bad element is refused", async () => {
    expect((await send(`/api/nodes/${noteId}/attributes/scores`, "PUT", { value: '["1","2.5"]' })).status).toBe(200);
    expect(await attribute(noteId, "scores")).toEqual({ value: '["1","2.5"]', value_type: "text" });
    expect((await send(`/api/nodes/${noteId}/attributes/due`, "PUT", { value: '["2026-10-20"]' })).status).toBe(200);
    expect((await attribute(noteId, "due"))!.value_type).toBe("text");
    expect((await send(`/api/nodes/${noteId}/attributes/stars`, "PUT", { value: '["3","5"]' })).status).toBe(200);
    expect((await send(`/api/nodes/${noteId}/attributes/scores`, "PUT", { value: '["1","x"]' })).status).toBe(422);
  });

  it("a date range filter and a number range still run with lists stored under the key", async () => {
    const range = await send("/api/query", "POST", { tags: [tagName], where: { due: { op: "gte", value: "2026-01-01" } } });
    expect(range.status).toBe(200);
    const below = await send("/api/query", "POST", { tags: [tagName], where: { scores: { op: "gt", value: "1" } } });
    expect(below.status).toBe(200);
  });

  it("an Obsidian list `authors: [Alice, Bob]` matches authors eq, by element", async () => {
    const listed = await note("Authors", "---\nauthors: [Alice, Bob]\n---\nBy two.\n");
    const single = await note("Alicia", "---\nauthors: Alicia\n---\nBy one.\n");
    const other = await note("Bracket", "---\nauthors: \"[Alice\"\n---\nNot a list.\n");
    for (const id of [listed, single, other]) expect((await send(`/api/nodes/${id}/tags/${tagId}`, "PUT", {})).status).toBe(200);
    expect(attributeValues((await attribute(listed, "authors"))!.value)).toEqual(["Alice", "Bob"]);

    const query = async (where: Record<string, unknown>) => {
      const res = await send("/api/query", "POST", { tags: [tagName], where });
      expect(res.status).toBe(200);
      const body = await res.json() as { rows: Array<{ id: string }> };
      return body.rows.map((n) => n.id).filter((id) => [listed, single, other].includes(id)).sort();
    };
    expect(await query({ authors: "Alice" })).toEqual([listed]);
    expect(await query({ authors: { op: "eq", value: "Bob" } })).toEqual([listed]);
    expect(await query({ authors: { op: "ne", value: "Alice" } })).toEqual([single, other].sort());
    expect(await query({ authors: { op: "eq", value: "[Alice" } })).toEqual([other]);
  });

  it("an exported relation list re-imports as a list of the imported notes' ids, and stays editable", async () => {
    const a = await note("Target A", "A.\n");
    const b = await note("Target B", "B.\n");
    const c = await note("Target C", "C.\n");
    const holder = await note("Holder", "Points at A and B.\n", [{ key: "related", value: JSON.stringify([a, b]), value_type: "node_ref" }]);

    const res = await app().request("/api/export/markdown.zip");
    expect(res.status).toBe(200);
    const files = [...unzip(Buffer.from(await res.arrayBuffer()))]
      .filter(([name]) => name.endsWith(".md"))
      .map(([name, data]) => ({ path: name, content: data.toString("utf8") }))
      .filter((f) => [title("Target A"), title("Target B"), title("Holder")].includes(String(frontmatter(f.content).title)));
    expect(files).toHaveLength(3);
    const exported = files.find((f) => frontmatter(f.content).title === title("Holder"))!;
    expect(frontmatter(exported.content).related).toEqual([`[[${title("Target A")}]]`, `[[${title("Target B")}]]`]);

    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = ANY($1::uuid[])`, [[a, b, holder]]);
    const imported = await app().request("/api/import/obsidian", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: { id: randomUUID(), name: `D117 ${stamp}` }, files, upsert: true }) });
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({ relations_resolved: 1, relations_unresolved: 0 });

    const idOf = async (name: string) => (await q<{ id: string }>(
      `SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = $2 AND deleted_at IS NULL`, [ws, title(name)])).rows[0]!.id;
    const [newA, newB, newHolder] = [await idOf("Target A"), await idOf("Target B"), await idOf("Holder")];
    const stored = (await attribute(newHolder, "related"))!;
    expect(stored.value_type).toBe("node_ref");
    expect(attributeValues(stored.value)).toEqual([newA, newB]);

    // The panel appends a pick to the list (RelationFieldEditor): the list is
    // written back whole and keeps its type.
    const appended = JSON.stringify([newA, newB, c]);
    expect((await send(`/api/nodes/${newHolder}/attributes/related`, "PUT", { value: appended, value_type: "node_ref" })).status).toBe(200);
    expect(await attribute(newHolder, "related")).toEqual({ value: appended, value_type: "node_ref" });
  });
});
