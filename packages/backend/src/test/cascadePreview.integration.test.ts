// P1 governance: GET /api/events/:id/cascade-preview — the blast radius a
// reject would restore, walked from the spine's triggered_by provenance.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
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

describe.skipIf(!isTestDb)("cascade preview (P1 governance)", () => {
  let rootEventId = "";
  let nodeId = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    const wsId = await getWorkspaceId();
    defaultSpaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [wsId])).rows[0]!.id;
    // Deterministic triggered_by tree: a tagpack with template_children —
    // applying the tag expands the template, every child NODE_CREATED points
    // triggered_by at the TAG_APPLIED root.
    const stamp = Date.now();
    const pack = await req("/api/tags/import", {
      method: "POST",
      json: {
        name: `cascade-tpl-${stamp}`,
        fields: [],
        template_children: [{ title: "Summary", body: "" }, { title: "Notes", body: "" }],
      },
    });
    expect(pack.status).toBe(201);
    const tagId = ((await pack.json()) as { id: string }).id;
    const created = await req("/api/nodes", {
      method: "POST",
      json: { space_id: defaultSpaceId, title: `Cascade probe ${stamp}`, markdown: "body" },
    });
    expect(created.status).toBe(201);
    nodeId = ((await created.json()) as { id: string }).id;
    const applied = await req(`/api/nodes/${nodeId}/tags/${tagId}`, { method: "PUT", json: {} });
    expect(applied.status).toBe(200);
    const root = await q<{ id: string }>(
      `SELECT id::text FROM domain_events WHERE event_type = 'TAG_APPLIED' AND target_id = $1 ORDER BY domain_events.id DESC LIMIT 1`,
      [nodeId],
    );
    expect(root.rows[0], "TAG_APPLIED event exists").toBeTruthy();
    rootEventId = root.rows[0]!.id;
  });

  it("lists the triggered_by descendants with titles", async () => {
    const res = await req(`/api/events/${rootEventId}/cascade-preview`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; total: number; events: Array<{ event_type: string; title: string | null }> };
    expect(body.count).toBeGreaterThanOrEqual(2); // Summary + Notes template children
    expect(body.total).toBeGreaterThanOrEqual(body.count); // whole chain, not just the listed page
    const types = body.events.map((e) => e.event_type);
    expect(types).toContain("NODE_CREATED");
    const titles = body.events.map((e) => e.title ?? "");
    expect(titles).toContain("Summary");
    expect(titles).toContain("Notes");
  });

  it("a cascade-free event previews as empty (the quiet common case)", async () => {
    const created = await req("/api/nodes", { method: "POST", json: { space_id: defaultSpaceId, title: `No cascade ${Date.now()}`, markdown: "plain" } });
    const plainId = ((await created.json()) as { id: string }).id;
    const root = await q<{ id: string }>(
      `SELECT id::text FROM domain_events WHERE event_type = 'NODE_CREATED' AND target_id = $1 ORDER BY domain_events.id DESC LIMIT 1`,
      [plainId],
    );
    const res = await req(`/api/events/${root.rows[0]!.id}/cascade-preview`);
    const body = (await res.json()) as { count: number; total: number };
    expect(body.count).toBe(0);
    expect(body.total).toBe(0);
  });

  it("non-numeric id is a 400, never a cast 500", async () => {
    expect((await req("/api/events/abc/cascade-preview")).status).toBe(400);
  });
});
