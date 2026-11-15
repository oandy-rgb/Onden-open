// Restoring a body edit that landed inside an emoji (D60): event restore built
// its own inverse patch without bodyPatch.ts's surrogate-split fallback, so
// Event history › Undo 500'd. Both the restore and the undo of the restore
// must go through.
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

describe.skipIf(!isTestDb)("restoring an emoji body edit (D60)", () => {
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
    await joinDefaultSpace(workspaceId, systemId, "admin");
    defaultSpaceId = (await q<{ id: string }>(
      `SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [workspaceId])).rows[0]!.id;
  });

  // 😀→😁 share the high surrogate, so a char diff splits the pair and
  // patch_toText throws "URI malformed" (diff-match-patch #69). The save
  // already fell back to a full-replacement patch; the restore made its own
  // inverse without the fallback and threw inside the transaction → 500.
  it("restores an edit inside an emoji, and the restore itself can be undone", async () => {
    const id = ((await (await req("/api/nodes", { method: "POST", json: { space_id: defaultSpaceId, title: `d60 ${stamp}`, markdown: "Mood 😀 ok" } })).json()) as { id: string }).id;
    expect((await req(`/api/nodes/${id}`, { method: "PATCH", json: { markdown: "Mood 😁 ok" } })).status).toBe(200);
    const body = async () => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id=$1`, [id])).rows[0]!.markdown;
    const latest = async () => (await q<{ id: string }>(
      `SELECT id::text AS id FROM domain_events WHERE event_type='NODE_UPDATED' AND target_id=$1 ORDER BY domain_events.id DESC LIMIT 1`,
      [id],
    )).rows[0]!.id;

    const edit = await latest();
    const restored = await req(`/api/events/${edit}/restore`, { method: "POST", json: {} });
    expect(restored.status).toBe(200);
    expect(await body()).toBe("Mood 😀 ok");

    // The restore event carries an inverse too: undoing it brings the edit back.
    const restore = await latest();
    expect(restore).not.toBe(edit);
    const undone = await req(`/api/events/${restore}/restore`, { method: "POST", json: {} });
    expect(undone.status).toBe(200);
    expect(await body()).toBe("Mood 😁 ok");
  });
});
