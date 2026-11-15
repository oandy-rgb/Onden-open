// Field inheritance (services/tagFields.ts, module-library phase 2b): a tag
// gives its notes the fields of its parent tags (上層) and of the tags it
// extends too —
// validated, with defaults seeded on apply, in the catalog's effective_fields
// and in a saved view's field types. A tag's own field of the same name wins
// for legacy data; new same-name declarations are refused (409).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const { app } = await import("../app.js");

// Top-level notes created as the System actor must name their space (it has
// no personal space and may be in several shared ones).
let defaultSpaceId = "";

const NATIVE = { origin: "http://localhost" };
function req(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  const headers: Record<string, string> = { ...NATIVE, ...(rest.headers as Record<string, string> | undefined) };
  if (json !== undefined) headers["content-type"] = "application/json";
  return Promise.resolve(app.request(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body }));
}

describe.skipIf(!isTestDb)("field inheritance through extends (DB)", () => {
  const stamp = Date.now();
  let bookId = "", novelId = "", nodeId = "";
  const attr = (key: string) => `/api/nodes/${nodeId}/attributes/${key}`;

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    const wsId = await getWorkspaceId();
    defaultSpaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [wsId])).rows[0]!.id;
    const book = await req("/api/tags/import", { method: "POST", json: { name: `書-${stamp}`, fields: [
      { name: "finished", type: "date" },
      { name: "status", type: "select", options: ["reading", "done"], default: "reading" },
      { name: "rating", type: "rating", max: 5 },
      { name: "pages", type: "text" },
    ] } });
    expect(book.status).toBe(201);
    bookId = ((await book.json()) as { id: string }).id;
    // #小說 declares its own `pages` (a number): its own wins over the inherited text.
    const novel = await req("/api/tags/import", { method: "POST", json: { name: `小說-${stamp}`, fields: [{ name: "pages", type: "number" }] } });
    expect(novel.status).toBe(201);
    novelId = ((await novel.json()) as { id: string }).id;
    // Declaring a field an ancestor gives is refused now; legacy data from
    // before the rule is written directly and must keep working (nearest wins).
    await seedQ(`UPDATE content_nodes SET tag_schema = jsonb_set(tag_schema, '{extends}', $2::jsonb) WHERE id = $1`, [novelId, JSON.stringify([bookId])]);
  });

  // A fresh #小說 note per test: the validation test rewrites its values.
  beforeEach(async () => {
    const created = await req("/api/nodes", { method: "POST", json: { space_id: defaultSpaceId, title: `沙丘 ${stamp}`, markdown: "x" } });
    nodeId = ((await created.json()) as { id: string }).id;
    expect((await req(`/api/nodes/${nodeId}/tags/${novelId}`, { method: "PUT", json: {} })).status).toBe(200);
  });

  it("applying the extending tag seeds the inherited default", async () => {
    const row = (await q<{ value: string; source: string }>(
      `SELECT value, source FROM node_attributes WHERE node_id = $1 AND key = 'status'`, [nodeId])).rows[0];
    expect(row).toMatchObject({ value: "reading", source: "derived" });
  });

  it("inherited fields are validated like own ones; the tag's own declaration wins", async () => {
    expect((await req(attr("finished"), { method: "PUT", json: { value: "not a date" } })).status).toBe(422);
    expect((await req(attr("finished"), { method: "PUT", json: { value: "2026-10-15" } })).status).toBe(200);
    expect((await req(attr("status"), { method: "PUT", json: { value: "lost" } })).status).toBe(422);
    expect((await req(attr("status"), { method: "PUT", json: { value: "done" } })).status).toBe(200);
    // #小說's own `pages` is a number; the inherited text field does not govern.
    expect((await req(attr("pages"), { method: "PUT", json: { value: "many" } })).status).toBe(422);
    expect((await req(attr("pages"), { method: "PUT", json: { value: "412" } })).status).toBe(200);
  });

  it("the catalog carries the effective fields, inherited ones naming their tag", async () => {
    const tags = (await (await req("/api/tags")).json()) as Array<{ id: string; effective_fields: Array<{ name: string; type: string; inherited_from?: string }> }>;
    const novel = tags.find((t) => t.id === novelId)!;
    expect(novel.effective_fields.map((f) => [f.name, f.type, f.inherited_from ?? null])).toEqual([
      ["pages", "number", null],
      ["finished", "date", bookId],
      ["status", "select", bookId],
      ["rating", "rating", bookId],
    ]);
    expect(tags.find((t) => t.id === bookId)!.effective_fields.every((f) => !f.inherited_from)).toBe(true);
  });

  it("a saved view of the extending tag knows the inherited field types", async () => {
    const view = await req(`/api/tags/${novelId}/views`, { method: "POST", json: { name: `Board ${stamp}`, layout: "kanban", group_by: "status", visible_fields: ["title", "status", "rating"] } });
    expect(view.status).toBe(201);
    const id = ((await view.json()) as { id: string }).id;
    const exec = (await (await req(`/api/tags/${novelId}/views/${id}/exec`)).json()) as { view: { field_meta?: Record<string, { type: string }>; group_field_options?: string[] | null } };
    expect(exec.view.field_meta?.rating?.type).toBe("rating");
    expect(exec.view.group_field_options).toEqual(["reading", "done"]);
  });

  it("a child tag (#書/小說, no schema of its own) gets its parent's fields", async () => {
    const leaf = await req("/api/tags/resolve-path", { method: "POST", json: { path: `書-${stamp}/短篇-${stamp}` } });
    expect(leaf.status).toBeLessThan(300);
    const childId = ((await leaf.json()) as { leaf_id: string }).leaf_id;
    const created = await req("/api/nodes", { method: "POST", json: { space_id: defaultSpaceId, title: `短篇 ${stamp}`, markdown: "x" } });
    const shortId = ((await created.json()) as { id: string }).id;
    expect((await req(`/api/nodes/${shortId}/tags/${childId}`, { method: "PUT", json: {} })).status).toBe(200);
    expect((await req(`/api/nodes/${shortId}/attributes/finished`, { method: "PUT", json: { value: "someday" } })).status).toBe(422);
    expect((await req(`/api/nodes/${shortId}/attributes/finished`, { method: "PUT", json: { value: "2026-10-01" } })).status).toBe(200);
    const tags = (await (await req("/api/tags")).json()) as Array<{ id: string; effective_fields: Array<{ name: string; inherited_from?: string }> }>;
    expect(tags.find((t) => t.id === childId)!.effective_fields.map((f) => [f.name, f.inherited_from])).toEqual([
      ["finished", bookId], ["status", bookId], ["rating", bookId], ["pages", bookId],
    ]);
  });
});

describe.skipIf(!isTestDb)("same-name fields are refused (DB)", () => {
  const baseStamp = Date.now();
  let bookId = "", novelId = "", lonelyId = "";
  const tagWith = async (name: string, fields: unknown[]) => {
    const res = await req("/api/tags/import", { method: "POST", json: { name, fields } });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const fieldsOf = (id: string, fields: unknown[]) => req(`/api/tags/${id}/schema`, { method: "PATCH", json: { fields } });

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
  });
  // Tags of its own per test: the legacy-clash test writes an extends
  // straight into #散文 that the refusal tests must not find.
  let seq = 0;
  let stamp = "";
  beforeEach(async () => {
    stamp = `${baseStamp}-${++seq}`;
    bookId = await tagWith(`書-${stamp}`, [{ name: "pages", type: "number" }]);
    novelId = await tagWith(`小說-${stamp}`, [{ name: "plot", type: "text" }]);
    lonelyId = await tagWith(`散文-${stamp}`, [{ name: "pages", type: "text" }]);
    // Only a module tag can be a new extends target (D105): #書 plays one.
    await seedQ(`UPDATE content_nodes SET tag_schema = tag_schema || jsonb_build_object('module', $2::text) WHERE id = $1`, [bookId, `test-book-${stamp}`]);
    expect((await req(`/api/tags/${novelId}/extends`, { method: "PUT", json: { extends: [bookId] } })).status).toBe(200);
  });

  it("adding or renaming to a field an ancestor gives is refused, naming both tags", async () => {
    const res = await fieldsOf(novelId, [{ name: "plot", type: "text" }, { name: "pages", type: "text" }]);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; clashes: Array<{ tag: string; field: string; from: string; from_title: string }> };
    expect(body.error).toBe("field_name_inherited");
    expect(body.clashes).toEqual([expect.objectContaining({ tag: novelId, field: "pages", from: bookId, from_title: `書-${stamp}` })]);
    expect((await fieldsOf(novelId, [{ name: "pages", type: "text" }])).status).toBe(409);
    expect((await fieldsOf(novelId, [{ name: "plot", type: "text" }, { name: "blurb", type: "text" }])).status).toBe(200);
  });

  it("an ancestor gaining a field one of its heirs declares is refused", async () => {
    expect((await fieldsOf(bookId, [{ name: "pages", type: "number" }, { name: "plot", type: "text" }])).status).toBe(409);
  });

  it("extending or moving under a tag that gives a field the tag declares is refused", async () => {
    expect((await req(`/api/tags/${lonelyId}/extends`, { method: "PUT", json: { extends: [bookId] } })).status).toBe(409);
    const moved = await req(`/api/nodes/${lonelyId}`, { method: "PATCH", json: { parent_id: bookId } });
    expect(moved.status).toBe(409);
    const row = (await q<{ parent_id: string | null; extends: unknown }>(
      `SELECT parent_id::text AS parent_id, tag_schema->'extends' AS extends FROM content_nodes WHERE id = $1`, [lonelyId])).rows[0];
    expect(row?.parent_id).toBeNull();
    expect(row?.extends ?? []).toEqual([]);
  });

  it("merging moves no child tag under a tag that gives one of its fields", async () => {
    const source = await tagWith(`舊書-${stamp}`, []);
    const leaf = await req("/api/tags/resolve-path", { method: "POST", json: { path: `舊書-${stamp}/頁-${stamp}` } });
    const childId = ((await leaf.json()) as { leaf_id: string }).leaf_id;
    expect((await fieldsOf(childId, [{ name: "pages", type: "text" }])).status).toBe(200);
    expect((await req(`/api/tags/${source}/merge`, { method: "POST", json: { target_id: bookId } })).status).toBe(409);
    expect((await q(`SELECT 1 FROM content_nodes WHERE id = $1 AND deleted_at IS NULL`, [source])).rowCount).toBe(1);
  });

  it("a clash already in the data does not block other edits of that tag", async () => {
    await seedQ(`UPDATE content_nodes SET tag_schema = jsonb_set(tag_schema, '{extends}', $2::jsonb) WHERE id = $1`, [lonelyId, JSON.stringify([bookId])]);
    expect((await fieldsOf(lonelyId, [{ name: "pages", type: "text" }, { name: "mood", type: "text" }])).status).toBe(200);
  });
});

// D93: one rule (@onden/markdown fieldNameClashes) — names only — checked at
// every schema door: the schema PATCH, and the two
// writers themselves (insertTagRow for pack import / proposals / module
// templates, writeTagSchema for every schema write). Restore is not judged.
describe.skipIf(!isTestDb)("same-name fields at every door (D93, DB)", () => {
  const stamp = Date.now();
  let WS = "", bookId = "", novelId = "";
  const storedFields = async (id: string) => (await q<{ fields: Array<{ name: string }> }>(
    `SELECT tag_schema->'fields' AS fields FROM content_nodes WHERE id = $1`, [id])).rows[0]!.fields.map((f) => f.name);
  const schemaPatch = (id: string, fields: unknown[]) => req(`/api/tags/${id}/schema`, { method: "PATCH", json: { fields } });

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
  });

  // A #書/小說 pair of its own per test: each test starts from the schema it
  // sets itself, not from the fields an earlier test left on the novel tag.
  let seq = 0;
  beforeEach(async () => {
    const n = ++seq;
    const book = await req("/api/tags/import", { method: "POST", json: { name: `書D93-${stamp}-${n}`, fields: [{ name: "author", label: "作者", type: "text" }] } });
    expect(book.status).toBe(201);
    bookId = ((await book.json()) as { id: string }).id;
    const leaf = await req("/api/tags/resolve-path", { method: "POST", json: { path: `書D93-${stamp}-${n}/小說D93-${stamp}-${n}` } });
    novelId = ((await leaf.json()) as { leaf_id: string }).leaf_id;
  });
  /** The novel tag with its own `writer` (labelled like the book's 作者) and `pages`. */
  const novelWithOwnFields = async () => {
    expect((await schemaPatch(novelId, [
      { name: "writer", label: "作者", type: "text" }, { name: "pages", label: "頁數", type: "number" },
    ])).status).toBe(200);
    expect(await storedFields(novelId)).toEqual(["writer", "pages"]);
  };

  it("a label-only clash saves, and later edits of that tag save too", async () => {
    expect((await schemaPatch(novelId, [{ name: "writer", label: "作者", type: "text" }])).status).toBe(200);
    expect((await schemaPatch(novelId, [
      { name: "writer", label: "作者", type: "text" }, { name: "pages", label: "頁數", type: "number" },
    ])).status).toBe(200);
    expect(await storedFields(novelId)).toEqual(["writer", "pages"]);
  });

  it("writeTagSchema itself refuses it (a merge too); a restore puts it back unjudged", async () => {
    const { writeTagSchema } = await import("../services/tagWrites.js");
    const { FieldNameClashError } = await import("../services/tagFields.js");
    const { withTransaction } = await import("../db.js");
    await novelWithOwnFields();
    await expect(withTransaction(() => writeTagSchema(WS, novelId, { merge: { fields: [{ name: "author", type: "text" }] } })))
      .rejects.toBeInstanceOf(FieldNameClashError);
    expect(await storedFields(novelId)).toEqual(["writer", "pages"]);
    await withTransaction(() => writeTagSchema(WS, novelId,
      { merge: { fields: [{ name: "writer", type: "text" }, { name: "author", type: "text" }] } }, { restoring: true }));
    expect(await storedFields(novelId)).toEqual(["writer", "author"]);
    // Now a legacy clash: editing another field of the tag still saves.
    expect((await schemaPatch(novelId, [
      { name: "writer", type: "text" }, { name: "author", type: "text" }, { name: "pages", type: "number" },
    ])).status).toBe(200);
  });

  it("insertTagRow refuses a new tag under a parent that gives one of its fields", async () => {
    const { insertTagRow, buildTagSchema } = await import("../services/tagWrites.js");
    const { FieldNameClashError } = await import("../services/tagFields.js");
    const { withTransaction } = await import("../db.js");
    const title = `短篇D93-${stamp}`;
    const insert = (fields: unknown[]) => withTransaction(() => insertTagRow(WS, {
      title, parentId: bookId, schema: buildTagSchema({ name: title, slug: `short-d93-${stamp}`, fields }),
    }));
    await expect(insert([{ name: "author", type: "text" }])).rejects.toBeInstanceOf(FieldNameClashError);
    expect((await q(`SELECT 1 FROM content_nodes WHERE title = $1`, [title])).rowCount).toBe(0);
    // A field only labelled like the parent's is fine.
    await insert([{ name: "writer", label: "作者", type: "text" }]);
    expect((await q(`SELECT 1 FROM content_nodes WHERE title = $1`, [title])).rowCount).toBe(1);
  });
});
