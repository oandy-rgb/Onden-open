// The field-name grammar (D44) is a rule of the schema writers (depth audit
// D100, tagWrites FieldNameRule), not of two routes: every door that adds a
// field — the schema PATCH, a tag-pack install, an
// agent's pack proposal — refuses a new name outside the attribute key
// grammar (400 invalid_key), because an export leaves such a key out and its
// values would not come back. Exceptions: a name notes already store values
// under, a name the schema already stores, and a database import (its column
// names are its values' keys).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { q, getWorkspaceId, withTransaction } from "../db.js";
import { buildTagSchema, insertTagRow } from "../services/tagWrites.js";
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

describe.skipIf(!isTestDb)("field names are judged where the schema is written (D100)", () => {
  const stamp = Date.now();
  let WS = "";
  const inUseKey = `in use ${stamp}`;
  const storedNames = async (id: string) => ((await q<{ fields: Array<{ name: string }> | null }>(
    `SELECT tag_schema->'fields' AS fields FROM content_nodes WHERE id = $1`, [id])).rows[0]!.fields ?? []).map((f) => f.name);
  const expectInvalidKey = async (res: Response, name: string) => {
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail?: string };
    expect(body.error).toBe("invalid_key");
    expect(body.detail).toContain(JSON.stringify(name));
  };

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    // A note already storing a value under an off-grammar key (a CSV column).
    const space = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [WS])).rows[0]!.id;
    const note = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, space_id, source_type, node_type, title, slug, markdown)
       VALUES ($1, $2, 'manual', 'content', $3, $4, '') RETURNING id::text`, [WS, space, `fn ${stamp}`, `fn-${stamp}`])).rows[0]!.id;
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value) VALUES ($1, $2, $3, 'x')`, [WS, note, inUseKey]);
  });

  it("a tag pack with an off-grammar field name is refused and installs nothing", async () => {
    const res = await req("/api/tags/import", { method: "POST", json: { name: `pack-${stamp}`, fields: [{ name: "due date", type: "date" }] } });
    await expectInvalidKey(res, "due date");
    expect((await q(`SELECT 1 FROM content_nodes WHERE title = $1 AND node_type = 'class_tag'`, [`pack-${stamp}`])).rowCount).toBe(0);
    // Under the grammar (CJK letters included) it installs.
    expect((await req("/api/tags/import", { method: "POST", json: { name: `pack-${stamp}`, fields: [{ name: "到期日", type: "date" }] } })).status).toBe(201);
  });

  it("a pack field named after a key notes already use installs", async () => {
    const res = await req("/api/tags/import", { method: "POST", json: { name: `pack-used-${stamp}`, fields: [{ name: inUseKey, type: "text" }] } });
    expect(res.status).toBe(201);
    expect(await storedNames(((await res.json()) as { id: string }).id)).toEqual([inUseKey]);
  });

  it("the tag schema PATCH: a new name is refused, a used or stored one is kept", async () => {
    const tag = ((await (await req("/api/tags/import", { method: "POST", json: { name: `schema-${stamp}`, fields: [] } })).json()) as { id: string }).id;
    const patch = (fields: unknown[]) => req(`/api/tags/${tag}/schema`, { method: "PATCH", json: { fields } });
    await expectInvalidKey(await patch([{ name: "due date", type: "date" }]), "due date");
    expect(await storedNames(tag)).toEqual([]);
    expect((await patch([{ name: inUseKey, type: "text" }])).status).toBe(200);
    // A name stored before the rule stays saveable with the rest of the schema.
    await seedQ(`UPDATE content_nodes SET tag_schema = jsonb_set(tag_schema, '{fields}', $2::jsonb) WHERE id = $1`,
      [tag, JSON.stringify([{ name: "Due Date", type: "date" }])]);
    expect((await patch([{ name: "Due Date", type: "date" }, { name: "pages", type: "number" }])).status).toBe(200);
    expect(await storedNames(tag)).toEqual(["Due Date", "pages"]);
  });

  it("a database import keeps its column names as they are", async () => {
    const { id } = await withTransaction(() => insertTagRow(WS, {
      title: `notion-${stamp}`, color: null, fieldNames: "import",
      schema: buildTagSchema({ name: `notion-${stamp}`, slug: `notion-${stamp}`, fields: [{ name: "Due Date", type: "date" }] }),
    }));
    expect(await storedNames(id)).toEqual(["Due Date"]);
  });

  it("an agent's pack proposal is refused at the tool, before it is queued", async () => {
    const agent = await (await req("/api/actors", { method: "POST", json: { name: `fn bot ${stamp}`, type: "agent", role: "editor" } })).json() as { id: string };
    const token = (await (await req(`/api/actors/${agent.id}/tokens`, { method: "POST", json: { template: "researcher" } })).json() as { token: string }).token;
    const res = await req("/api/mcp/tools/proposeTagPack", {
      method: "POST", headers: { authorization: `Bearer ${token}` },
      json: { args: { name: `proposal-${stamp}`, fields: [{ name: "due date", type: "date" }] } },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_key");
    expect((await q(`SELECT 1 FROM outbox WHERE payload->'pack'->>'name' = $1`, [`proposal-${stamp}`])).rowCount).toBe(0);
  });
});
