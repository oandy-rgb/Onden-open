// Session-coalesced version history (user feedback 「還原的體驗完全是錯的」):
// storage stays per-save (053: every body = event + blob, nothing lost); the
// LIST groups same-actor saves within a 5-minute gap into one session row
// carrying the FINAL body. ?raw=1 keeps the ungrouped feed.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { joinDefaultSpace } from "./helpers/spaceFixtures.js";
import { turnModuleOn } from "./helpers/setModulesOn.js";

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

type V = { id: string; markdown: string; saves: number };

describe.skipIf(!isTestDb)("version sessions (coalesced history)", () => {
  let nodeId = "";

  // Per test: its own note with the same history (create, my three saves, the
  // agent's save), so the restore test's extra session is never seen by another.
  beforeEach(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    const wsId = await getWorkspaceId();
    await turnModuleOn(await getWorkspaceId(), "ai"); // the agent tools belong to the AI module
    defaultSpaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [wsId])).rows[0]!.id;
    const created = await req("/api/nodes", { method: "POST", json: { space_id: defaultSpaceId, title: `Sessions ${Date.now()}`, markdown: "v0" } });
    nodeId = ((await created.json()) as { id: string }).id;
    // three rapid saves = one editing session; the CREATE stays its own
    // version (the baseline must never coalesce away — pinned in nodesSpine)
    await req(`/api/nodes/${nodeId}`, { method: "PATCH", json: { markdown: "v1" } });
    await req(`/api/nodes/${nodeId}`, { method: "PATCH", json: { markdown: "v2" } });
    await req(`/api/nodes/${nodeId}`, { method: "PATCH", json: { markdown: "v3" } });
    // a DIFFERENT actor's save = its own session (boundary on actor change —
    // the same mechanism that keeps agent edits visually separate from yours)
    const actor = await (await req("/api/actors", { method: "POST", json: { name: `vs bot ${Date.now()}`, type: "agent" } })).json();
    // a new agent suggests by default (ai-collaboration); this test is about an agent's direct save
    await q(`UPDATE actors SET write_mode = 'apply' WHERE id = $1`, [actor.id]);
    // a new agent joins no space by itself (097) — add it to 共用 explicitly
    await joinDefaultSpace(wsId, actor.id);
    const tok = await (await req(`/api/actors/${actor.id}/tokens`, { method: "POST", json: { access: "write" } })).json();
    const agentSave = await req("/api/mcp/tools/updateNode", {
      method: "POST",
      headers: { authorization: `Bearer ${tok.token}` },
      json: { args: { id: nodeId, markdown: "v4-agent", base_markdown: "v3" } },
    });
    expect(agentSave.status).toBeLessThan(300);
  });

  it("rapid same-actor saves collapse into one session carrying the FINAL body; an agent's save is its own row", async () => {
    const res = await req(`/api/nodes/${nodeId}/versions`);
    expect(res.status).toBe(200);
    const versions = (await res.json()) as V[];
    // three sessions: the create baseline, my burst (v1..v3), the agent's save
    expect(versions.length).toBe(3);
    expect(versions[0]!.markdown).toBe("v4-agent"); // newest first
    expect(versions[0]!.saves).toBe(1);
    expect(versions[1]!.markdown).toBe("v3");       // MY session's FINAL body — not v1, not noise
    expect(versions[1]!.saves).toBe(3);             // three rapid saves absorbed
    expect(versions[2]!.markdown).toBe("v0");       // create baseline survives as its own version
    expect(versions[2]!.saves).toBe(1);
  });

  it("?raw=1 keeps the ungrouped per-save feed (storage lost nothing)", async () => {
    const raw = (await (await req(`/api/nodes/${nodeId}/versions?raw=1`)).json()) as V[];
    expect(raw.length).toBe(5); // create + 3 updates + agent update
    expect(raw[0]!.markdown).toBe("v4-agent");
  });

  it("a session row's id is a real event id — restore works and starts its own session", async () => {
    const versions = (await (await req(`/api/nodes/${nodeId}/versions`)).json()) as V[];
    const mine = versions[1]!; // v3
    const res = await req(`/api/nodes/${nodeId}/versions/${mine.id}/restore`, { method: "POST", json: {} });
    expect(res.status).toBeLessThan(300);
    const node = await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [nodeId]);
    expect(node.rows[0]!.markdown).toBe("v3");
    const after = (await (await req(`/api/nodes/${nodeId}/versions`)).json()) as V[];
    expect(after[0]!.markdown).toBe("v3"); // NODE_RESTORED = its own session row
    expect(after.length).toBe(4);
  });
});
