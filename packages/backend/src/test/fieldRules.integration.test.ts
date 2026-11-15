// P2 tag-schema upgrade: field defaults + validation, end to end.
//   • applying a schema tag seeds declared defaults as 'derived' attrs,
//     provenance-chained to TAG_APPLIED (cascade-preview sees them)
//   • a declared field's constraints bite on writes (422, not silent garbage)
//   • required fields can't be deleted while the tag is applied
//   • keys outside any schema stay free-form (fields assist, don't imprison)
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";

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

describe.skipIf(!isTestDb)("field defaults + validation (P2)", () => {
  let nodeId = "";
  let tagId = "";
  const attr = (key: string) => `/api/nodes/${nodeId}/attributes/${key}`;

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    const wsId = await getWorkspaceId();
    defaultSpaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [wsId])).rows[0]!.id;
    const stamp = Date.now();
    const pack = await req("/api/tags/import", {
      method: "POST",
      json: {
        name: `fieldrules-${stamp}`,
        fields: [
          { name: "rating", type: "number", default: "3" },
          { name: "status", type: "select", options: ["todo", "doing", "done"], required: true, default: "todo" },
          { name: "started", type: "date" },
        ],
      },
    });
    expect(pack.status).toBe(201);
    tagId = ((await pack.json()) as { id: string }).id;
  });

  // A fresh note per test (tagged as the first test expects), so one test's
  // attribute edits and deletes are not the next test's starting point.
  beforeEach(async () => {
    const created = await req("/api/nodes", { method: "POST", json: { space_id: defaultSpaceId, title: `Field rules ${Date.now()}`, markdown: "x" } });
    nodeId = ((await created.json()) as { id: string }).id;
    // pre-set rating so the default must NOT overwrite it
    expect((await req(attr("rating"), { method: "PUT", json: { value: "5", value_type: "number" } })).status).toBe(200);
    expect((await req(`/api/nodes/${nodeId}/tags/${tagId}`, { method: "PUT", json: {} })).status).toBe(200);
  });

  it("tag apply seeds defaults as derived attrs WITHOUT overwriting user values, provenance-chained", async () => {
    const attrs = await q<{ key: string; value: string; source: string }>(
      `SELECT key, value, source FROM node_attributes WHERE node_id = $1 ORDER BY key`,
      [nodeId],
    );
    const byKey = new Map(attrs.rows.map((r) => [r.key, r]));
    expect(byKey.get("status")).toMatchObject({ value: "todo", source: "derived" }); // seeded
    expect(byKey.get("rating")).toMatchObject({ value: "5" });                       // user value kept
    expect(byKey.has("started")).toBe(false);                                        // no default declared

    // the seed's ATTRIBUTE_SET hangs off the TAG_APPLIED root (cascade-preview material)
    const chain = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM domain_events child
        JOIN domain_events root ON child.triggered_by_event_id = root.id
       WHERE root.event_type = 'TAG_APPLIED' AND root.target_id = $1
         AND child.event_type = 'ATTRIBUTE_SET'`,
      [nodeId],
    );
    expect(Number(chain.rows[0]!.n)).toBeGreaterThanOrEqual(1);
  });

  it("declared constraints bite: number shape, select options — 422 with a readable reason", async () => {
    expect((await req(attr("rating"), { method: "PUT", json: { value: "not-a-number" } })).status).toBe(422);
    expect((await req(attr("rating"), { method: "PUT", json: { value: "4" } })).status).toBe(200);
    const badSelect = await req(attr("status"), { method: "PUT", json: { value: "bogus" } });
    expect(badSelect.status).toBe(422);
    expect(JSON.stringify(await badSelect.json())).toContain("todo, doing, done");
    expect((await req(attr("status"), { method: "PUT", json: { value: "doing" } })).status).toBe(200);
    expect((await req(attr("started"), { method: "PUT", json: { value: "junk" } })).status).toBe(422);
    expect((await req(attr("started"), { method: "PUT", json: { value: "2026-06-12" } })).status).toBe(200);
  });

  it("required fields can't be deleted while the tag is applied; others can", async () => {
    expect((await req(attr("status"), { method: "DELETE" })).status).toBe(422);
    expect((await req(attr("rating"), { method: "DELETE" })).status).toBe(200);
  });

  it("keys outside any schema stay free-form", async () => {
    expect((await req(attr("mood"), { method: "PUT", json: { value: "whatever 🎈" } })).status).toBe(200);
    expect((await req(attr("mood"), { method: "DELETE" })).status).toBe(200);
  });
});
