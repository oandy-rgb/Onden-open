// Scale plane (review #3 fix): the bootstrap cap now binds ONLY the FULL-body
// payload — where each row carries its markdown, so an unbounded set is a real
// heap/payload risk. The SLIM payload (?bodies=none) ships EVERY node skeleton
// UNCAPPED: the skeleton is tiny without bodies, so no node is ever invisible.
// We set a tiny cap via env BEFORE importing the app so a handful of seeded nodes
// already exceeds it, then assert: full ≤ cap; slim returns ALL nodes; and
// dependent rows (edges) stay consistent with whatever set was actually returned.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

// Must be set before importing index.js (the const is read at module load).
process.env.BOOTSTRAP_NODE_LIMIT = "3";

vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

// The file's own workspace (bootstrap resolves it through getWorkspaceId): the
// slim payload ships every node of the workspace, so in the shared default
// workspace its size would follow everyone else's notes.
let workspaceId = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));

const { q } = await import("../db.js");
const { nativeOwnerActor } = await import("./helpers/persistActor.js");
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

type Boot = {
  bodies?: string;
  nodes: Array<{ id: string; markdown: string }>;
  edges: Array<{ source_node_id: string; target_node_id: string }>;
};

const SEEDED = 8; // well above the cap of 3

describe.skipIf(!isTestDb)("bootstrap node set: full capped, slim complete (review #3)", () => {
  let seededIds: string[] = [];

  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Bootstrap cap', $1) RETURNING id::text`, [`cap-${randomUUID()}`])).rows[0]!.id;
    // Native requests act as the workspace's System actor (it manages 共用).
    await nativeOwnerActor(workspaceId);
    const ins = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, sort_order)
       SELECT $1,'manual','content','Cap '||g,'cap-node-'||g,'body '||g, g
       FROM generate_series(1,${SEEDED}) g
       RETURNING id`,
      [workspaceId],
    );
    seededIds = ins.rows.map((r) => r.id);
  });

  it("FULL bootstrap still respects BOOTSTRAP_NODE_LIMIT (bodies are heavy)", async () => {
    const full = (await (await req("/api/bootstrap")).json()) as Boot;
    expect(full.nodes.length).toBeLessThanOrEqual(3);
  });

  it("SLIM bootstrap returns ALL node skeletons — no truncation, none invisible", async () => {
    const slim = (await (await req("/api/bootstrap?bodies=none")).json()) as Boot;
    expect(slim.bodies).toBe("none");
    // The invariant is "no node is ever invisible", so assert EVERY seeded node
    // is present (not an exact total — the app also maintains config singletons
    // like the Site Config node + workspace-config tag, which legitimately ride
    // along). The set ships even though it far exceeds the cap of 3.
    const slimIds = new Set(slim.nodes.map((n) => n.id));
    for (const id of seededIds) expect(slimIds.has(id)).toBe(true);
    expect(slim.nodes.length).toBeGreaterThan(3); // uncapped (cap=3)
    expect(slim.nodes.length).toBeGreaterThanOrEqual(SEEDED);
    // And every skeleton is body-stripped (the slim contract).
    for (const n of slim.nodes) expect(n.markdown).toBe("");
  });

  it("edges only reference nodes present in whatever set was returned (no dangling endpoints)", async () => {
    for (const path of ["/api/bootstrap", "/api/bootstrap?bodies=none"]) {
      const boot = (await (await req(path)).json()) as Boot;
      const present = new Set(boot.nodes.map((n) => n.id));
      for (const e of boot.edges) {
        expect(present.has(e.source_node_id)).toBe(true);
        expect(present.has(e.target_node_id)).toBe(true);
      }
    }
  });
});
