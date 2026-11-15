// A note body saved as a patch against the text it was made from
// (`markdown_patch`, docs/architecture/patch-writes.md): the server gives the
// base back (the stored body, else a version kept for THIS note) and runs the
// same three-way merge it runs for `markdown` + `base_markdown`.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { makePatch, hashText } from "@onden/markdown";

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

const line = (i: number) => `第 ${i} 行:這是一段讓筆記夠長的文字,patch test line.`;
const lines = (n: number) => Array.from({ length: n }, (_, i) => line(i));
const BASE = lines(400).join("\n");
const edit = (text: string, at: number, to: string) => text.split("\n").map((l, i) => (i === at ? to : l)).join("\n");

describe.skipIf(!isTestDb)("note body saved as a patch", () => {
  let nodeId = "";
  let spaceId = "";
  const patch = (base: string, next: string, extra: Record<string, unknown> = {}) =>
    req(`/api/nodes/${nodeId}`, { markdown_patch: makePatch(base, next), ...extra }, "PATCH");
  const body = async () => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [nodeId])).rows[0]!.markdown;
  const create = async (markdown: string) => {
    const res = await req("/api/nodes", { space_id: spaceId, title: `Patch ${Date.now()}-${Math.random()}`, markdown });
    return ((await res.json()) as { id: string }).id;
  };

  beforeEach(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    const wsId = await getWorkspaceId();
    spaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [wsId])).rows[0]!.id;
    nodeId = await create(BASE);
  });

  it("saves the text the patch describes", async () => {
    const next = edit(BASE, 10, "第十行改過了");
    const res = await patch(BASE, next);
    expect(res.status).toBe(200);
    expect(await body()).toBe(next);
    expect(((await res.json()) as { markdown: string }).markdown).toBe(next);
  });

  it("an equal text and an empty note work too", async () => {
    expect((await patch(BASE, BASE)).status).toBe(200);
    expect(await body()).toBe(BASE);
    const empty = await create("");
    const res = await req(`/api/nodes/${empty}`, { markdown_patch: makePatch("", "新的內容") }, "PATCH");
    expect(res.status).toBe(200);
  });

  it("a base another device already moved past is still merged: both edits stay", async () => {
    const other = edit(BASE, 5, "另一台裝置改第五行");
    expect((await req(`/api/nodes/${nodeId}`, { markdown: other, base_markdown: BASE }, "PATCH")).status).toBe(200);
    const mine = edit(BASE, 300, "我改第三百行");
    expect((await patch(BASE, mine)).status).toBe(200);
    expect(await body()).toBe(edit(other, 300, "我改第三百行"));
    expect((await q(`SELECT 1 FROM domain_events WHERE target_id = $1 AND event_type = 'BODY_CONFLICT'`, [nodeId])).rows).toHaveLength(0);
  });

  it("lines both devices changed keep the patch writer's text and record the other as a conflict", async () => {
    await req(`/api/nodes/${nodeId}`, { markdown: edit(BASE, 7, "別人的第七行"), base_markdown: BASE }, "PATCH");
    expect((await patch(BASE, edit(BASE, 7, "我的第七行"))).status).toBe(200);
    expect((await body()).split("\n")[7]).toBe("我的第七行");
    expect((await q(`SELECT 1 FROM domain_events WHERE target_id = $1 AND event_type = 'BODY_CONFLICT'`, [nodeId])).rows).toHaveLength(1);
  });

  it("answers 409 patch_base_unknown for a base this server cannot give back", async () => {
    const res = await patch("a text this note never had " .repeat(100), "x");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "patch_base_unknown" });
    expect(await body()).toBe(BASE);
  });

  it("does not hand out another note's text as a base", async () => {
    const secret = "another note's private body\n".repeat(50);
    await create(secret);
    // an empty patch against the other note's hash would otherwise copy its body here
    const res = await req(`/api/nodes/${nodeId}`, { markdown_patch: { base_hash: hashText(secret), hunks: [] } }, "PATCH");
    expect(res.status).toBe(409);
    expect(await body()).toBe(BASE);
  });

  it("refuses a patch that does not fit its base, or that comes with a whole body", async () => {
    const outside = await req(`/api/nodes/${nodeId}`, { markdown_patch: { base_hash: hashText(BASE), hunks: [{ at: BASE.length + 5, del: 0, ins: "x" }] } }, "PATCH");
    expect(outside.status).toBe(400);
    expect(((await outside.json()) as { error: string }).error).toBe("invalid_patch");
    const malformed = await req(`/api/nodes/${nodeId}`, { markdown_patch: { base_hash: "nope", hunks: [] } }, "PATCH");
    expect(malformed.status).toBe(400);
    const both = await patch(BASE, BASE + "x", { markdown: "whole" });
    expect(both.status).toBe(400);
    const nul = await patch(BASE, BASE + "\u0000");
    expect(nul.status).toBe(400);
    expect(await body()).toBe(BASE);
  });

  it("a note of hundreds of KB is saved by a request of a few hundred bytes", async () => {
    const big = lines(8000).join("\n");
    const id = await create(big);
    const request = JSON.stringify({ markdown_patch: makePatch(big, big + "\n新增一行") });
    expect(request.length).toBeLessThan(500);
    expect((await req(`/api/nodes/${id}`, JSON.parse(request), "PATCH")).status).toBe(200);
    expect((await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown).toBe(big + "\n新增一行");
  });

  it("a retry under the same Idempotency-Key does not write twice", async () => {
    const next = edit(BASE, 20, "只寫一次");
    const key = randomUUID();
    const send = () => Promise.resolve(app.request(`/api/nodes/${nodeId}`, {
      method: "PATCH",
      headers: { origin: "http://localhost", "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ markdown_patch: makePatch(BASE, next) }),
    }));
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const events = await q(`SELECT 1 FROM domain_events WHERE target_id = $1 AND event_type = 'NODE_UPDATED'`, [nodeId]);
    expect(events.rows).toHaveLength(1);
  });
});
