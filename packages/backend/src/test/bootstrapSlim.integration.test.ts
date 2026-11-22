// P0-3 scale plane: ?bodies=none ships node metadata + body_len instead of
// full markdown, and GET /api/nodes/:id is the lazy-body door. Contract
// pinned here so the frontend flip-over (next stage) has a stable target.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { q, getWorkspaceId } from "../db.js";
import { nativeOwnerActor } from "./helpers/persistActor.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import { NODE_COLUMNS_WITHOUT_MARKDOWN } from "../services/nodeRowProjection.js";
import { ensureConfigNode } from "./helpers/siteConfigFixture.js";

// A workspace of its own: the full-body bootstrap caps at 5000 notes, oldest
// first, so in a shared workspace that holds other tests' notes this file's
// newest note could fall past the cap.
let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

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
  return Promise.resolve(app.request(path, {
    ...rest, headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  }));
}

type BootNode = { id: string; title: string; markdown: string; excerpt?: string; body_len?: number; attrs?: Record<string, string>; class_tag_ids?: string[] };

describe.skipIf(!isTestDb)("slim bootstrap + lazy-body door (P0-3)", () => {
  let nodeId = "";
  // Big enough that the slim payload MUST win (the body_len overhead is
  // ~tens of bytes per node; tiny test bodies would make slim look bigger).
  const BODY = "# Slim Probe\n\nSome **rich** prose that is long enough to excerpt sensibly.\n\n" +
    "filler lorem ipsum ".repeat(3000);

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Slim bootstrap', $1) RETURNING id::text`, [`slim-${randomUUID()}`])).rows[0]!.id;
    // Native requests act as the workspace's System actor (index.ts).
    await nativeOwnerActor(WS);
    // An existing workspace already has its site config (and so its config
    // tag); a fresh one makes it lazily, in the background of the first write.
    // Make it now, so no test sees the tag catalog change between two reads.
    await ensureConfigNode(WS);
    const wsId = await getWorkspaceId();
    defaultSpaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [wsId])).rows[0]!.id;
    const created = await req("/api/nodes", { method: "POST", json: { space_id: defaultSpaceId, title: "Slim probe node", markdown: BODY } });
    expect(created.status).toBe(201);
    nodeId = ((await created.json()) as { id: string }).id;
    await awaitAllDispatchers();
  });

  it("default bootstrap still ships full bodies (no behavior change)", async () => {
    const res = await req("/api/bootstrap");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { bodies: string; nodes: BootNode[] };
    expect(data.bodies).toBe("full");
    const node = data.nodes.find((n) => n.id === nodeId)!;
    expect(node.markdown).toBe(BODY);
  });

  it("?bodies=none strips markdown, adds body_len", async () => {
    const res = await req("/api/bootstrap?bodies=none");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { bodies: string; nodes: BootNode[] };
    expect(data.bodies).toBe("none");
    const node = data.nodes.find((n) => n.id === nodeId)!;
    expect(node.markdown).toBe("");
    expect(node.body_len).toBe(BODY.length);
    // No per-node summary: the app never read one (R23).
    expect(node.excerpt).toBeUndefined();
    // and the payload is actually smaller than the full one
    const fullLen = JSON.stringify((await (await req("/api/bootstrap")).json())).length;
    const slimLen = JSON.stringify(data).length;
    expect(slimLen).toBeLessThan(fullLen);
  });

  it("bootstrap ships typed attributes (type, inheritance, source), in both modes", async () => {
    const put = await req(`/api/nodes/${nodeId}/attributes/score`, { method: "PUT", json: { value: "7", value_type: "number", is_inheritable: true } });
    expect(put.status).toBe(200);
    for (const path of ["/api/bootstrap", "/api/bootstrap?bodies=none"]) {
      const data = (await (await req(path)).json()) as { attributes?: Array<Record<string, unknown>> };
      expect(data.attributes?.find((a) => a.node_id === nodeId && a.key === "score"), path)
        .toEqual({ node_id: nodeId, key: "score", value: "7", value_type: "number", is_inheritable: true, source: expect.any(String) });
    }
  });

  it("the slim column list covers every content_nodes column except markdown, the frozen sort_order (migration 200) and written_space_id (218: the sync's bookkeeping, never sent)", async () => {
    const cols = (await q<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'content_nodes' AND column_name NOT IN ('markdown', 'sort_order', 'written_space_id')`,
    )).rows.map((r) => r.column_name);
    expect([...NODE_COLUMNS_WITHOUT_MARKDOWN].sort()).toEqual(cols.sort());
  });

  it("X-Onden-Bootstrap: lean keeps the older lean format (cached shells)", async () => {
    await req(`/api/nodes/${nodeId}/attributes/score`, { method: "PUT", json: { value: "7", value_type: "number", is_inheritable: true } });
    const data = (await (await req("/api/bootstrap?bodies=none", { headers: { "x-onden-bootstrap": "lean" } })).json()) as
      { wire?: number; attrs_omitted?: boolean; nodes: Array<Record<string, unknown>>; attributes: Array<Record<string, unknown>>; workspace: { id: string } };
    expect(data.wire).toBeUndefined();
    expect(data.attrs_omitted).toBe(true);
    const node = data.nodes.find((n) => n.id === nodeId)!;
    expect(node).toMatchObject({ workspace_id: WS, markdown: "", body_len: BODY.length, deleted_at: null });
    expect(node).not.toHaveProperty("attrs");
    expect(data.attributes.find((a) => a.node_id === nodeId && a.key === "score")).toBeTruthy();
  });

  it("X-Onden-Bootstrap: lean2 sends the compact format with the same content", async () => {
    await req(`/api/nodes/${nodeId}/attributes/score`, { method: "PUT", json: { value: "7", value_type: "number", is_inheritable: true } });
    const get = async (v: string) => (await (await req("/api/bootstrap?bodies=none", { headers: { "x-onden-bootstrap": v } })).json()) as Record<string, any>;
    const [old, compact] = [await get("lean"), await get("lean2")];
    expect(compact.wire).toBe(2);
    expect(compact.nodes).toHaveLength(old.nodes.length);
    const idx = compact.nodes.findIndex((n: Record<string, unknown>) => n.id === nodeId);
    expect(compact.nodes[idx]).not.toHaveProperty("workspace_id");
    expect(compact.nodes[idx]).toMatchObject({ markdown: "", body_len: BODY.length });
    const group = (compact.attribute_groups as Array<[number, unknown[][]]>).find(([at]) => at === idx)!;
    const score = group[1].find((r) => compact.dict[r[0] as number] === "score")!;
    expect([score[1], compact.dict[score[2] as number], score[3]]).toEqual(["7", "number", 1]);
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(old).length);
  });

  it("GET /api/nodes/:id returns the bootstrap-shaped row with the full body", async () => {
    const res = await req(`/api/nodes/${nodeId}`);
    expect(res.status).toBe(200);
    const node = (await res.json()) as BootNode;
    expect(node.markdown).toBe(BODY);
    expect(Array.isArray(node.class_tag_ids)).toBe(true);
    expect(typeof node.attrs).toBe("object");
  });

  it("label_tag_ids mirrors schema-less tag membership (bootstrap + single-node)", async () => {
    // find-or-create the label tag, apply it
    const resolved = await req("/api/tags/resolve-path", { method: "POST", json: { path: "toread" } });
    expect(resolved.status).toBeLessThan(300);
    const tagId = ((await resolved.json()) as { leaf_id: string }).leaf_id;
    expect((await req(`/api/nodes/${nodeId}/tags/${tagId}`, { method: "PUT", json: {} })).status).toBe(200);

    const boot = (await (await req("/api/bootstrap")).json()) as { nodes: Array<{ id: string; label_tag_ids?: string[]; class_tag_ids?: string[] }> };
    const node = boot.nodes.find((n) => n.id === nodeId)!;
    expect(node.label_tag_ids).toContain(tagId);
    expect(node.class_tag_ids).not.toContain(tagId); // schema-less stays OUT of class_tag_ids

    const single = (await (await req(`/api/nodes/${nodeId}`)).json()) as { label_tag_ids?: string[] };
    expect(single.label_tag_ids).toContain(tagId);
  });

  it("GET /api/nodes/:id — non-uuid and unknown ids are 404, never a cast 500", async () => {
    expect((await req("/api/nodes/not-a-uuid")).status).toBe(404);
    expect((await req("/api/nodes/00000000-0000-0000-0000-00000000dead")).status).toBe(404);
    // the static routes keep winning over /:id
    expect((await req("/api/nodes/search?q=slim probe")).status).toBe(200);
  });

  // GAP-249: a fresh device must be able to start its event sync where the
  // bootstrap is current, not from since=0 (which replays every body).
  it("bootstrap carries the event cursor it is current to (slim and full)", async () => {
    const maxId = async () => String((await q<{ m: string }>(
      "SELECT COALESCE(MAX(id),0)::text AS m FROM domain_events WHERE workspace_id=$1", [await getWorkspaceId()])).rows[0].m);
    for (const path of ["/api/bootstrap?bodies=none", "/api/bootstrap"]) {
      const before = await maxId();
      const boot = (await (await req(path)).json()) as { last_event_id?: string };
      expect(boot.last_event_id).toBe(before);
    }
    // A change after the bootstrap is still delivered by a sync from its cursor.
    const cursor = ((await (await req("/api/bootstrap?bodies=none")).json()) as { last_event_id: string }).last_event_id;
    expect((await req(`/api/nodes/${nodeId}`, { method: "PATCH", json: { title: "Slim probe renamed" } })).status).toBe(200);
    const delta = (await (await req("/api/sync", { method: "POST", json: { since: Number(cursor), known: [] } })).json()) as { nodes: { upsert: Array<{ id: string; title: string }> } };
    expect(delta.nodes.upsert.find((n) => n.id === nodeId)?.title).toBe("Slim probe renamed");
  });

  // A reopen's refresh (2026-10-19): ?nodes=none carries what the sync delta
  // does not — boards, graph positions, suggestions, events, catalog, site
  // config, chrome, the actor's flags — and none of the per-node channels.
  it("?nodes=none: no per-node channels (marked nodes_omitted), the rest as in a slim payload", async () => {
    const slim = (await (await req("/api/bootstrap?bodies=none")).json()) as Record<string, unknown>;
    const res = await req("/api/bootstrap?nodes=none");
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.nodes_omitted).toBe(true);
    for (const key of ["nodes", "edges", "tasks", "pointers", "attributes"]) expect(meta[key], key).toEqual([]);
    expect(meta).not.toHaveProperty("blocks"); // the channel is gone
    expect(meta.example_seed_eligible).toBeUndefined(); // no node rows to judge by
    for (const key of ["workspace", "tags", "suggestions", "canvas_memberships", "graph_positions", "site_config", "chrome", "actor_role", "actor_is_owner", "can_review", "last_event_id"]) {
      expect(meta[key], key).toEqual(slim[key]);
    }
    expect(JSON.stringify(meta).length).toBeLessThan(JSON.stringify(slim).length);
  });

  // Lean (x-onden-bootstrap: lean): each attribute once, no drawings.
  it("lean: no attrs maps, typed rows without drawings, and the deferred keys named", async () => {
    // Its own typed attribute (the typed-attributes test sets one too, but
    // need not run first).
    expect((await req(`/api/nodes/${nodeId}/attributes/score`, { method: "PUT", json: { value: "7", value_type: "number", is_inheritable: true } })).status).toBe(200);
    expect((await req(`/api/nodes/${nodeId}/attributes/ink_data`, { method: "PUT", json: { value: JSON.stringify({ version: 1, strokes: [] }) } })).status).toBe(200);
    for (const path of ["/api/bootstrap", "/api/bootstrap?bodies=none"]) {
      const lean = (await (await req(path, { headers: { "x-onden-bootstrap": "lean" } })).json()) as { attrs_omitted?: boolean; deferred_attribute_keys?: string[]; nodes: BootNode[]; attributes: Array<{ node_id: string; key: string }> };
      expect(lean.attrs_omitted, path).toBe(true);
      expect(lean.deferred_attribute_keys).toEqual(["ink_data", "board_ink", "note_ink", "pdf_annotations"]);
      expect(lean.nodes.every((n) => n.attrs === undefined), path).toBe(true);
      const own = lean.attributes.filter((a) => a.node_id === nodeId).map((a) => a.key);
      expect(own, path).toContain("score");
      expect(own, path).not.toContain("ink_data");
      // The old shape is unchanged for a client that does not ask.
      const old = (await (await req(path)).json()) as { nodes: BootNode[]; attributes: Array<{ node_id: string; key: string }> };
      expect(old.nodes.find((n) => n.id === nodeId)?.attrs?.ink_data, path).toBeTruthy();
      expect(old.attributes.some((a) => a.node_id === nodeId && a.key === "ink_data"), path).toBe(true);
    }
  });
});
