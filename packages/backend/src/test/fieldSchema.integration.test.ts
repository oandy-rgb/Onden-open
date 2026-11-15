// D48: one schema field shape (services/fieldSchema.ts) at every door that
// writes a schema — the tag schema PATCH, the pack import and the agent's
// proposeTagPack. A
// rating field (with its max) round-trips through all of them; a field typed
// "dat" is a 400 at each; a schema stored before the check, with a legacy
// field, still saves.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { fieldShapeProblems } from "../services/fieldSchema.js";
import { turnModuleOn } from "./helpers/setModulesOn.js";
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

const storedFields = async (tagId: string) =>
  (await q<{ fields: Array<Record<string, unknown>> }>(`SELECT tag_schema->'fields' AS fields FROM content_nodes WHERE id = $1`, [tagId])).rows[0]!.fields;

const RATING = { name: "stars", label: "Stars", type: "rating", max: 7 };
// Every documented property, so a door that drops one is caught.
const RICH = [
  { name: "status", label: "Status", type: "select", options: ["todo", "done"], default: "todo", required: true },
  { name: "tags_list", type: "text", cardinality: "many" },
  { name: "total", type: "number", rollup: { op: "sum", tag: "item", attr: "price" } },
  { name: "owner", type: "relation", relation_supertag: "person" },
  RATING,
];
const BAD = { name: "due", type: "dat" };

describe("fieldShapeProblems", () => {
  it("accepts every field type and documented property; names the field and the problem", () => {
    expect(fieldShapeProblems(RICH, [])).toEqual([]);
    expect(fieldShapeProblems(undefined, [])).toEqual([]);
    expect(fieldShapeProblems({}, [])).toEqual(["fields must be a list"]);
    const problems = fieldShapeProblems([RATING, BAD, { name: "", type: "text" }, { ...RATING, max: 0 }, "x"], []);
    expect(problems).toHaveLength(4);
    expect(problems[0]).toMatch(/^field 1 "due": type: /);
    expect(problems[1]).toMatch(/^field 2 "": name: /);
    expect(problems[2]).toMatch(/^field 3 "stars": max: /);
    expect(problems[3]).toMatch(/^field 4: /);
  });

  it("does not judge a field the stored schema holds exactly", () => {
    const legacy = { name: "Link", type: "url", width: 3 };
    expect(fieldShapeProblems([legacy, RATING], [legacy])).toEqual([]);
    expect(fieldShapeProblems([{ ...legacy, label: "Link" }], [legacy])).toHaveLength(1);
  });
});

describe.skipIf(!isTestDb)("one schema field shape (D48)", () => {
  const stamp = Date.now();
  let researcherToken = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    await getWorkspaceId();
    await turnModuleOn(await getWorkspaceId(), "ai"); // the agent tools belong to the AI module
    const actor = await (await req("/api/actors", { method: "POST", json: { name: `field bot ${stamp}`, type: "agent", role: "editor" } })).json() as { id: string };
    researcherToken = ((await (await req(`/api/actors/${actor.id}/tokens`, { method: "POST", json: { template: "researcher" } })).json()) as { token: string }).token;
  });

  it("the tag schema PATCH round-trips a rating field with its max", async () => {
    const pack = await req("/api/tags/import", { method: "POST", json: { name: `rate-${stamp}`, fields: [RATING] } });
    expect(pack.status).toBe(201);
    const { id } = (await pack.json()) as { id: string };
    expect(await storedFields(id)).toEqual([RATING]);
    const res = await req(`/api/tags/${id}/schema`, { method: "PATCH", json: { fields: [{ ...RATING, max: 3 }] } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { fields: unknown }).fields).toEqual([{ ...RATING, max: 3 }]);
  });

  it("a field typed \"dat\" is refused at every door", async () => {
    const made = await req("/api/tags/import", { method: "POST", json: { name: `Good ${stamp}`, fields: [] } });
    const { id } = (await made.json()) as { id: string };

    const schema = await req(`/api/tags/${id}/schema`, { method: "PATCH", json: { fields: [BAD] } });
    expect(schema.status).toBe(400);
    const body = (await schema.json()) as { error: string; problems: string[] };
    expect(body.error).toBe("invalid_field");
    expect(body.problems[0]).toMatch(/^field 0 "due": type: /);
    expect(await storedFields(id)).toEqual([]);

    const imported = await req("/api/tags/import", { method: "POST", json: { name: `badpack-${stamp}`, fields: [BAD] } });
    expect(imported.status).toBe(400);
    expect(((await imported.json()) as { error: string }).error).toMatch(/^invalid fields: field 0 "due"/);
    expect((await req("/api/tags/import", { method: "POST", json: { name: `badpack2-${stamp}`, fields: { due: "date" } } })).status).toBe(400);

    const proposed = await req("/api/mcp/tools/proposeTagPack", {
      method: "POST",
      headers: { authorization: `Bearer ${researcherToken}` },
      json: { args: { name: `badprop${stamp}`, fields: [BAD] } },
    });
    expect(proposed.status).toBe(400);
    expect(await proposed.json()).toMatchObject({ error: "invalid_args" });
  });

  it("a schema stored before the check still saves with its legacy field", async () => {
    const pack = await req("/api/tags/import", { method: "POST", json: { name: `legacy-${stamp}`, fields: [] } });
    const { id } = (await pack.json()) as { id: string };
    // Written before D48: a type no field shape knows, an unknown key, and a
    // `required` an older writer added.
    const legacy = { name: "Link", type: "url", width: 3, required: false };
    await seedQ(`UPDATE content_nodes SET tag_schema = jsonb_set(tag_schema, '{fields}', $2::jsonb) WHERE id = $1`, [id, JSON.stringify([legacy])]);

    // The editor sends the whole list back with a new field, and again with another scale.
    const viaTags = await req(`/api/tags/${id}/schema`, { method: "PATCH", json: { fields: [legacy, RATING] } });
    expect(viaTags.status).toBe(200);
    const again = await req(`/api/tags/${id}/schema`, { method: "PATCH", json: { fields: [legacy, { ...RATING, max: 4 }], views: {} } });
    expect(again.status).toBe(200);
    // Nothing of the legacy field is dropped on the way.
    expect(await storedFields(id)).toEqual([legacy, { ...RATING, max: 4 }]);

    // Changing the legacy field makes it a new field: it then needs the shape.
    const edited = await req(`/api/tags/${id}/schema`, { method: "PATCH", json: { fields: [{ ...legacy, label: "Link" }] } });
    expect(edited.status).toBe(400);
    const fixed = await req(`/api/tags/${id}/schema`, { method: "PATCH", json: { fields: [{ ...legacy, type: "text", label: "Link" }] } });
    expect(fixed.status).toBe(200);
  });

  it("proposeTagPack takes the full field shape (rating with max) and it installs", async () => {
    const name = `ratedprop${stamp}`;
    const res = await req("/api/mcp/tools/proposeTagPack", {
      method: "POST",
      headers: { authorization: `Bearer ${researcherToken}` },
      json: { args: { name, fields: [RATING, { name: "notes" }] } },
    });
    expect(res.status).toBeLessThan(300);
    const approvals = (await (await req("/api/inbox/approvals")).json()) as { approvals: Array<{ id: string; effect_kind: string; payload: { pack?: { name?: string; fields?: unknown } } }> };
    const held = approvals.approvals.find((a) => a.effect_kind === "tag_pack" && a.payload.pack?.name === name)!;
    expect(held.payload.pack?.fields).toEqual([RATING, { name: "notes", type: "text" }]);
    expect((await req(`/api/inbox/approvals/${held.id}/approve`, { method: "POST", json: {} })).status).toBeLessThan(300);
    let fields: unknown = null;
    for (let i = 0; i < 40 && !fields; i++) {
      fields = (await q<{ fields: unknown }>(
        `SELECT tag_schema->'fields' AS fields FROM content_nodes WHERE title = $1 AND node_type = 'class_tag' AND deleted_at IS NULL`, [name],
      )).rows[0]?.fields ?? null;
      if (!fields) await new Promise((r) => setTimeout(r, 100));
    }
    expect(fields).toEqual([RATING, { name: "notes", type: "text" }]);
  });
});
