// Two editors save the same line from the same base (F03: two tabs of one
// account; F04: two accounts). Typing at the same place keeps both texts. When
// both rewrote the same words the later save is kept, and the body it
// overrode stays a version of its own in the history list — even when both
// saves are by one actor (the list otherwise folds a same-actor burst into
// one row carrying only the final body).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const { app } = await import("../app.js");

function req(path: string, json?: unknown, method = json === undefined ? "GET" : "POST"): Promise<Response> {
  return Promise.resolve(app.request(path, {
    method,
    headers: { origin: "http://localhost", ...(json === undefined ? {} : { "content-type": "application/json" }) },
    body: json === undefined ? undefined : JSON.stringify(json),
  }));
}

describe.skipIf(!isTestDb)("concurrent saves of one line", () => {
  const base = "# 標題\n\n第二段 beta\n";
  let nodeId = "";
  const save = (markdown: string) =>
    req(`/api/nodes/${nodeId}`, { markdown, base_markdown: base }, "PATCH");
  const body = async () => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [nodeId])).rows[0]!.markdown;
  const conflicts = async () => (await q(`SELECT 1 FROM domain_events WHERE target_id = $1 AND event_type = 'BODY_CONFLICT'`, [nodeId])).rows.length;

  beforeEach(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    const wsId = await getWorkspaceId();
    const space = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [wsId])).rows[0]!.id;
    const created = await req("/api/nodes", { space_id: space, title: `SameLine ${Date.now()}`, markdown: base });
    nodeId = ((await created.json()) as { id: string }).id;
  });

  it("typing at the same place in the line keeps both texts and records no conflict", async () => {
    expect((await save("# 標題\n\n第二段 beta [A同段]\n")).status).toBe(200);
    expect((await save("# 標題\n\n第二段 beta [B同段]\n")).status).toBe(200);
    expect(await body()).toBe("# 標題\n\n第二段 beta [A同段] [B同段]\n");
    expect(await conflicts()).toBe(0);
  });

  it("rewriting the same words keeps the later save, and the overridden body is its own version", async () => {
    await save("# 標題\n\n第二段 alpha\n");
    await save("# 標題\n\n第二段 gamma\n");
    expect(await body()).toBe("# 標題\n\n第二段 gamma\n");
    expect(await conflicts()).toBe(1);
    const versions = (await (await req(`/api/nodes/${nodeId}/versions`)).json()) as Array<{ markdown: string }>;
    expect(versions.map((v) => v.markdown)).toContain("# 標題\n\n第二段 alpha\n");
    expect(versions[0]!.markdown).toBe("# 標題\n\n第二段 gamma\n");
  });
});
