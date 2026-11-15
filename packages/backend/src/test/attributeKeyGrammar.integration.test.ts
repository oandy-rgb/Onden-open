// D44: one attribute key alphabet for the UI, the API and the text grammars
// (@onden/markdown attributeKey.ts). A new key outside it is refused with a
// 400 at every door that adds one (the attribute route, a note created with
// attributes, a schema field); keys made before the grammar — an existing
// attribute, a schema field such as a CSV column "Due Date" — stay editable.
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

const NATIVE = { origin: "http://localhost" };
function req(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  const headers: Record<string, string> = { ...NATIVE, ...(rest.headers as Record<string, string> | undefined) };
  if (json !== undefined) headers["content-type"] = "application/json";
  return Promise.resolve(app.request(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body }));
}

describe.skipIf(!isTestDb)("attribute key grammar (D44)", () => {
  let spaceId = "";
  let workspaceId = "";
  let nodeId = "";
  let tagId = "";
  const stamp = Date.now();
  const attr = (node: string, key: string) => `/api/nodes/${node}/attributes/${encodeURIComponent(key)}`;
  const keysOf = async (node: string) =>
    (await q<{ key: string }>(`SELECT key FROM node_attributes WHERE node_id = $1 ORDER BY key`, [node])).rows.map((r) => r.key);

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    workspaceId = await getWorkspaceId();
    spaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [workspaceId])).rows[0]!.id;
    // A tag from before the grammar: its field is a CSV-style column name. A
    // pack can no longer bring such a name (D100), so it is stored directly.
    const pack = await req("/api/tags/import", {
      method: "POST",
      json: { name: `keys-${stamp}`, fields: [{ name: "status", type: "text" }] },
    });
    expect(pack.status).toBe(201);
    tagId = ((await pack.json()) as { id: string }).id;
    await seedQ(`UPDATE content_nodes SET tag_schema = jsonb_set(tag_schema, '{fields}', $2::jsonb) WHERE id = $1`,
      [tagId, JSON.stringify([{ name: "Due Date", type: "text" }, { name: "status", type: "text" }])]);
  });

  // A fresh note per test: the first test lists the note's keys exactly.
  beforeEach(async () => {
    const created = await req("/api/nodes", { method: "POST", json: { space_id: spaceId, title: `Keys ${stamp}`, markdown: "x" } });
    expect(created.status).toBe(201);
    nodeId = ((await created.json()) as { id: string }).id;
  });

  it("a new CJK key is accepted; a new key with a space, colon or leading digit is a 400", async () => {
    expect((await req(attr(nodeId, "作者"), { method: "PUT", json: { value: "王" } })).status).toBe(200);
    for (const key of ["due date", "a:b", "2024"]) {
      const res = await req(attr(nodeId, key), { method: "PUT", json: { value: "x" } });
      expect(res.status, key).toBe(400);
      expect(await res.json(), key).toMatchObject({ error: "invalid_key" });
    }
    expect(await keysOf(nodeId)).toEqual(["作者"]);
  });

  it("child: + a key is the copy-down form; child: + anything else is a 400", async () => {
    expect((await req(attr(nodeId, "child:狀態"), { method: "PUT", json: { value: "todo" } })).status).toBe(200);
    expect((await req(attr(nodeId, "child:due date"), { method: "PUT", json: { value: "x" } })).status).toBe(400);
    await seedQ(`DELETE FROM node_attributes WHERE node_id = $1 AND key = 'child:狀態'`, [nodeId]);
  });

  it("an attribute stored before the grammar can still be edited", async () => {
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, source) VALUES ($1, $2, 'old key', 'v1', 'ui')`, [workspaceId, nodeId]);
    expect((await req(attr(nodeId, "old key"), { method: "PUT", json: { value: "v2" } })).status).toBe(200);
    const row = await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = 'old key'`, [nodeId]);
    expect(row.rows[0]!.value).toBe("v2");
  });

  it("a schema field's name is writable on a tagged note even outside the grammar", async () => {
    const created = await req("/api/nodes", { method: "POST", json: { space_id: spaceId, title: `Tagged ${stamp}`, markdown: "", tag_ids: [tagId] } });
    const tagged = ((await created.json()) as { id: string }).id;
    expect((await req(attr(tagged, "Due Date"), { method: "PUT", json: { value: "2026-10-17" } })).status).toBe(200);
    // Without the tag the same name is a new free-form key.
    expect((await req(attr(nodeId, "Due Date"), { method: "PUT", json: { value: "2026-10-17" } })).status).toBe(400);
  });

  it("a note created with an invalid attribute key is refused whole", async () => {
    const title = `Refused ${stamp}`;
    const res = await req("/api/nodes", {
      method: "POST",
      json: { space_id: spaceId, title, markdown: "", attributes: [{ key: "作者", value: "王" }, { key: "due date", value: "x" }] },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_key" });
    expect((await q(`SELECT 1 FROM content_nodes WHERE title = $1`, [title])).rowCount).toBe(0);
  });

  it("a schema keeps its old field names; a field added to it follows the grammar", async () => {
    const fields = [{ name: "Due Date", type: "text" }, { name: "status", type: "text" }];
    const refused = await req(`/api/tags/${tagId}/schema`, { method: "PATCH", json: { fields: [...fields, { name: "new field", type: "text" }] } });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_key" });
    const saved = await req(`/api/tags/${tagId}/schema`, { method: "PATCH", json: { fields: [...fields, { name: "備註", type: "text" }] } });
    expect(saved.status).toBe(200);
  });

  it("a key notes already store values under can be promoted to a field (generalize to tag)", async () => {
    // "old key" was stored before the grammar; the rail's
    // "generalize to tag" appends it to the tag's schema.
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, source) VALUES ($1, $2, 'old key', 'v1', 'ui')`, [workspaceId, nodeId]);
    const current = (await q<{ fields: unknown[] }>(`SELECT tag_schema->'fields' AS fields FROM content_nodes WHERE id = $1`, [tagId])).rows[0]!.fields;
    const res = await req(`/api/tags/${tagId}/schema`, { method: "PATCH", json: { fields: [...current, { name: "old key", type: "text" }] } });
    expect(res.status).toBe(200);
  });
});
