// P1 治理 cost stats: GET /api/actors/:id/stats — the audit trail as the
// meter. Real flow: mint a scoped token, drive MCP tool calls (one ok, one
// scope-violation failure), read the rollup as admin.
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

const NATIVE = { origin: "http://localhost" };
function req(path: string, init: RequestInit & { json?: unknown; bearer?: string } = {}): Promise<Response> {
  const { json, bearer, ...rest } = init;
  const headers: Record<string, string> = { ...NATIVE, ...(rest.headers as Record<string, string> | undefined) };
  if (json !== undefined) headers["content-type"] = "application/json";
  if (bearer) headers["authorization"] = `Bearer ${bearer}`;
  return Promise.resolve(app.request(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body }));
}

describe.skipIf(!isTestDb)("actor stats (P1 governance)", () => {
  let actorId = "";
  let bearer = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    await getWorkspaceId();
    const actor = await (await req("/api/actors", { method: "POST", json: { name: `Stats bot ${Date.now()}`, type: "agent" } })).json();
    actorId = actor.id;
    // read-only key: searchNodes allowed, createNode NOT (a scope
    // violation we can count as a failure)
    const tok = await (await req(`/api/actors/${actorId}/tokens`, { method: "POST", json: { access: "read" } })).json();
    bearer = tok.token;

    const ok = await req("/api/mcp/tools/searchNodes", { method: "POST", bearer, json: { args: { query: "anything at all" } } });
    expect(ok.status).toBeLessThan(500);
    const denied = await req("/api/mcp/tools/createNode", { method: "POST", bearer, json: { args: { title: "nope", markdown: "x" } } });
    expect(denied.status).toBeGreaterThanOrEqual(400); // a read-only key does not write
  });

  it("rolls up tool calls, failures, and per-tool breakdown from the audit trail", async () => {
    const res = await req(`/api/actors/${actorId}/stats`);
    expect(res.status).toBe(200);
    const stats = (await res.json()) as {
      tool_calls: number; tool_failures: number; last_active: string | null;
      by_tool: Array<{ tool: string; ok: number; failed: number }>;
    };
    expect(stats.tool_calls).toBeGreaterThanOrEqual(2);
    expect(stats.tool_failures).toBeGreaterThanOrEqual(1); // the denied createNode
    expect(stats.last_active).toBeTruthy();
    const search = stats.by_tool.find((b) => b.tool === "searchNodes");
    expect(search?.ok).toBeGreaterThanOrEqual(1);
    const denied = stats.by_tool.find((b) => b.tool === "createNode");
    expect(denied?.failed).toBeGreaterThanOrEqual(1);
  });

  it("admin-only; days must be 1–365 (else 400); 404 for phantom actors", async () => {
    expect((await req(`/api/actors/${actorId}/stats?days=365`)).status).toBe(200);
    for (const days of ["99999", "0", "1.5", "12abc"]) expect((await req(`/api/actors/${actorId}/stats?days=${days}`)).status, days).toBe(400);
    expect((await req(`/api/actors/00000000-0000-0000-0000-0000000000aa/stats`)).status).toBe(404);
    // bearer tokens are confined to /api/mcp/* — the stats surface 401/403s
    const asAgent = await req(`/api/actors/${actorId}/stats`, { bearer, headers: { origin: "http://example.com" } });
    expect(asAgent.status).toBeGreaterThanOrEqual(401);
  });
});
