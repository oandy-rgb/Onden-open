// GET /api/nodes/:id/attributes?keys=a,b answers only those keys (D83): an
// ink surface reads ink_data / pdf_url without downloading the note's other
// attributes. Without ?keys= it answers every attribute, the same set the
// agent tool getNode gives, except drawing data (ink_data, board_ink, note_ink, pdf_annotations): megabytes of strokes
// that getNode leaves out on purpose (services/agentTools/getNode.ts).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { callTool } from "../services/agentTools/index.js";
import type { ActorCtx } from "../types.js";
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
  return Promise.resolve(app.request(path, {
    ...rest, headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  }));
}

type AttrRow = { key: string; value: string };

describe.skipIf(!isTestDb)("reading a note's attributes (DB)", () => {
  let nodeId = "";
  let workspaceId = "";
  const INK = JSON.stringify({ version: 1, strokes: [], erased: {}, page: { width: 1000 } });

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    workspaceId = await getWorkspaceId();
    await turnModuleOn(await getWorkspaceId(), "ai"); // the agent tools belong to the AI module
    const space = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [workspaceId])).rows[0]!.id;
    const created = await req("/api/nodes", { method: "POST", json: { space_id: space, title: "Drawing", markdown: "" } });
    expect(created.status).toBe(201);
    nodeId = ((await created.json()) as { id: string }).id;
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value) VALUES
      ($1, $2, 'ink_data', $3), ($1, $2, 'pdf_url', 'https://example.com/a.pdf'), ($1, $2, 'status', 'reading'), ($1, $2, '_rss_url', 'https://example.com/feed')`,
    [workspaceId, nodeId, INK]);
  });

  const keysOf = (rows: AttrRow[]) => rows.map((r) => r.key).sort();

  it("without ?keys= answers every attribute", async () => {
    const res = await req(`/api/nodes/${nodeId}/attributes`);
    expect(res.status).toBe(200);
    expect(keysOf((await res.json()) as AttrRow[])).toEqual(["_rss_url", "ink_data", "pdf_url", "status"]);
  });

  it("?keys= answers only those keys; an unknown key is simply absent", async () => {
    const res = await req(`/api/nodes/${nodeId}/attributes?keys=ink_data,pdf_url,nope`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as AttrRow[];
    expect(keysOf(rows)).toEqual(["ink_data", "pdf_url"]);
    expect(rows.find((r) => r.key === "ink_data")?.value).toBe(INK);
  });

  it("an empty ?keys= answers nothing", async () => {
    const res = await req(`/api/nodes/${nodeId}/attributes?keys=`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("the agent tool getNode gives the same attributes as the route, minus drawing data", async () => {
    const system = (await q<ActorCtx>(
      `SELECT id::text, name, type FROM actors WHERE workspace_id = $1 AND external_id = 'system'`, [workspaceId],
    )).rows[0]!;
    const node = await callTool("getNode", { id: nodeId }, { actor: system, workspaceId, dryRun: false }) as { attributes: AttrRow[] } | null;
    const route = (await (await req(`/api/nodes/${nodeId}/attributes`)).json()) as AttrRow[];
    const drawing = new Set(["ink_data", "board_ink", "note_ink", "pdf_annotations"]);
    expect(keysOf(node!.attributes)).toEqual(keysOf(route.filter((a) => !drawing.has(a.key))));
  });
});
