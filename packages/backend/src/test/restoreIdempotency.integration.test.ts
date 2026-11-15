// Restoring a NODE_UPDATED is idempotent: re-restoring an already-restored event
// must NOT re-apply the inverse patch against the already-reverted body (a
// double-revert that force=true would corrupt) — it returns already_in_state (M3).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { joinDefaultSpace } from "./helpers/spaceFixtures.js";

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

describe.skipIf(!isTestDb)("NODE_UPDATED restore is idempotent (M3)", () => {
  const stamp = Date.now();
  // System has no personal space and may sit in several shared ones: a
  // top-level note must name its space.
  let defaultSpaceId = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    const workspaceId = await getWorkspaceId();
    // Native-origin authentication uses the persisted System principal. Keep
    // this suite runnable independently of migration seed/earlier fixtures.
    await q(`INSERT INTO actors(workspace_id,name,type,external_id)
      VALUES($1,'System','agent','system')
      ON CONFLICT(workspace_id,external_id) DO NOTHING`, [workspaceId]);
    const systemId = (await q<{ id: string }>(
      `SELECT id::text FROM actors WHERE workspace_id = $1 AND external_id = 'system'`, [workspaceId])).rows[0]!.id;
    await joinDefaultSpace(workspaceId, systemId, "editor");
    defaultSpaceId = (await q<{ id: string }>(
      `SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [workspaceId])).rows[0]!.id;
  });

  it("re-restoring an already-restored body edit is a no-op, not a double-revert", async () => {
    const id = ((await (await req("/api/nodes", { method: "POST", json: { space_id: defaultSpaceId, title: `m3 ${stamp}`, markdown: "line one\nv1 body\n" } })).json()) as { id: string }).id;
    expect((await req(`/api/nodes/${id}`, { method: "PATCH", json: { markdown: "line one\nv2 body\n" } })).status).toBe(200);

    const ev = ((await q<{ id: string }>(
      `SELECT id::text AS id FROM domain_events WHERE event_type='NODE_UPDATED' AND target_id=$1 ORDER BY domain_events.id DESC LIMIT 1`,
      [id],
    )).rows[0]!).id;

    // First restore: the inverse patch reverts v2 → v1.
    expect((await req(`/api/events/${ev}/restore`, { method: "POST", json: {} })).status).toBeLessThan(300);
    const afterFirst = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id=$1`, [id])).rows[0]!.markdown;
    expect(afterFirst).toContain("v1 body");
    expect(afterFirst).not.toContain("v2 body");

    // Second restore WITH force: must refuse (already restored), not re-apply the
    // inverse patch against the now-v1 body and corrupt it.
    const second = await req(`/api/events/${ev}/restore`, { method: "POST", json: { force: true } });
    expect(second.status).toBe(409); // already_in_state
    const afterSecond = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id=$1`, [id])).rows[0]!.markdown;
    expect(afterSecond, "body unchanged by the refused re-restore").toBe(afterFirst);
  });
});
