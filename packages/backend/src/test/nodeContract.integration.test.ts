// The drift guard for @onden/contract's node shape: real responses are parsed
// with `.strict()`, so a column or projection field the server adds (or drops)
// without the contract fails here, and the app's ContentNode — derived from the
// contract — can never silently disagree with what the server sends.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CreatedNode, ServerNode, ServerNodeRow } from "@onden/contract";
import { q, getWorkspaceId } from "../db.js";
import { nativeOwnerActor } from "./helpers/persistActor.js";
import { ensureConfigNode } from "./helpers/siteConfigFixture.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";

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

/** Parse every node of a payload; a failure names the path and the offending note's title. */
function expectNodes(nodes: unknown[], schema: z.ZodType, where: string) {
  expect(nodes.length, where).toBeGreaterThan(0);
  for (const node of nodes) {
    const parsed = schema.safeParse(node);
    expect(parsed.success ? "ok" : `${where}: ${parsed.error.message}`, `${where}: ${String((node as { title?: unknown }).title)}`).toBe("ok");
  }
}

describe.skipIf(!isTestDb)("node contract: real responses match @onden/contract", () => {
  let parentId = "";

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Node contract', $1) RETURNING id::text`, [`contract-${randomUUID()}`])).rows[0]!.id;
    await nativeOwnerActor(WS);
    await ensureConfigNode(WS);
    const spaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [WS])).rows[0]!.id;
    const parent = await req("/api/nodes", { method: "POST", json: { space_id: spaceId, title: "Contract parent", markdown: "# body\n\nstatus:: open" } });
    expect(parent.status).toBe(201);
    parentId = ((await parent.json()) as { id: string }).id;
    const child = await req("/api/nodes", { method: "POST", json: { title: "Contract child", parent_id: parentId } });
    expect(child.status).toBe(201);
    await req(`/api/nodes/${parentId}/attributes/score`, { method: "PUT", json: { value: "7", value_type: "number" } });
    await awaitAllDispatchers();
  });

  it("every node of the full bootstrap is a ServerNode", async () => {
    const data = (await (await req("/api/bootstrap")).json()) as { nodes: unknown[] };
    expectNodes(data.nodes, ServerNode.strict(), "bootstrap");
    // The reserved site-config note rides along: system / class_tag rows are covered too.
    expect(data.nodes.some((n) => (n as { node_type: string }).node_type === "class_tag")).toBe(true);
  });

  it("every node of the slim bootstrap (?bodies=none) is a ServerNode with body_len", async () => {
    const data = (await (await req("/api/bootstrap?bodies=none")).json()) as { nodes: Array<{ id: string }> };
    expectNodes(data.nodes, ServerNode.strict(), "bootstrap?bodies=none");
    expect(data.nodes.find((n) => n.id === parentId)).toHaveProperty("body_len");
  });

  it("every node of the lean bootstrap is a ServerNode without attrs", async () => {
    const data = (await (await req("/api/bootstrap?bodies=none", { headers: { "x-onden-bootstrap": "lean" } })).json()) as { nodes: Array<Record<string, unknown>> };
    expectNodes(data.nodes, ServerNode.strict(), "bootstrap lean");
    expect(data.nodes.every((n) => !("attrs" in n))).toBe(true);
  });

  it("GET /api/nodes/:id is a ServerNode", async () => {
    const res = await req(`/api/nodes/${parentId}`);
    expect(res.status).toBe(200);
    const node = ServerNode.strict().parse(await res.json());
    expect(node.attrs).toMatchObject({ score: "7" });
  });

  it("POST, PATCH and a no-op PATCH answer with a ServerNodeRow", async () => {
    const id = randomUUID();
    const created = await req("/api/nodes", { method: "POST", json: { id, title: "Contract create", markdown: "first", parent_id: parentId } });
    expect(created.status).toBe(201);
    expect(CreatedNode.strict().parse(await created.json()).id).toBe(id);

    const patched = await req(`/api/nodes/${id}`, { method: "PATCH", json: { title: "Contract renamed", markdown: "second", order_key: "a3" } });
    expect(patched.status).toBe(200);
    const row = ServerNodeRow.strict().parse(await patched.json());
    expect(row).toMatchObject({ title: "Contract renamed", markdown: "second", order_key: "a3" });

    const same = await req(`/api/nodes/${id}`, { method: "PATCH", json: { title: "Contract renamed" } });
    expect(same.status).toBe(200);
    ServerNodeRow.extend({ noop: z.literal(true) }).strict().parse(await same.json());
  });

  it("DraftNode is what POST and PATCH read: an unknown type is refused", async () => {
    const res = await req("/api/nodes", { method: "POST", json: { title: "x", node_type: "image" } });
    expect(res.status).toBe(400);
  });
});
