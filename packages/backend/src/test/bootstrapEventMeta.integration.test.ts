// F4.x event metadata in /api/bootstrap (last_actor / last_modified_at /
// recent_actors) was refactored from three correlated subqueries PER NODE
// against domain_events into a single set-based grouped aggregate LEFT JOINed
// once. This pins the SHAPE + CORRECTNESS the frontend Bases evaluator depends
// on so the rewrite provably preserves behavior:
//   • last_actor / last_modified_at come from the latest event (created_at DESC)
//   • last_actor + last_modified_at are taken from the SAME latest row
//   • recent_actors = distinct actors within the 30-day window (older excluded)
//   • a node with no events keeps last_actor/last_modified_at NULL and
//     recent_actors an empty array (not null)
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { randomUUID } from "node:crypto";
import { nativeOwnerActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

// A workspace of its own: the full-body /api/bootstrap caps at 5000 notes,
// oldest first, so in a shared workspace holding other tests' notes this
// file's notes could fall past the cap.
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));

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

type BootNode = {
  id: string;
  last_actor: string | null;
  last_modified_at: string | null;
  recent_actors: string[];
};

describe.skipIf(!isTestDb)("bootstrap event metadata (set-based aggregate)", () => {
  let wsId = "";
  let withEventsId = "";
  let noEventsId = "";

  beforeAll(async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Test', $1) RETURNING id::text`, [`boot-meta-${randomUUID()}`])).rows[0]!.id;
    // Native requests act as the workspace's System actor (index.ts).
    await nativeOwnerActor(ownWorkspace);
    wsId = await getWorkspaceId();

    // Insert the probe nodes DIRECTLY (not via POST /api/nodes): the create path
    // emits a real NODE_CREATED event (target_type 'node', "now"), which — now
    // that the evt_meta query correctly matches 'node' — would outrank the seeded
    // timeline below. domain_events is append-only so we can't scrub it; a direct
    // insert simply emits no events, leaving the seeded timeline authoritative.
    const stamp = Date.now();
    const mk = async (title: string, slug: string) =>
      ((await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
         VALUES ($1,'manual','content',$2,$3,'body') RETURNING id`,
        [wsId, title, slug],
      )).rows[0]!.id);
    withEventsId = await mk("Event meta probe", `evt-probe-${stamp}`);
    noEventsId = await mk("No-events probe", `noevt-probe-${stamp}`);

    // Timeline for withEventsId (oldest → newest):
    //   100 days ago   actor-old   (outside 30d window → NOT in recent_actors)
    //   10 days ago    actor-mid   (inside window)
    //   1 day ago      actor-new   (inside window, NEWEST → last_actor)
    const seed = async (actor: string, ago: string) =>
      q(
        // Real node events use target_type 'node' (the bootstrap evt_meta query
        // filters on it); the old 'content_node' seed matched the old broken query.
        `INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, created_at)
         VALUES ($1, 'user', $2, 'NODE_UPDATED', 'node', $3, now() - $4::interval)`,
        [wsId, actor, withEventsId, ago],
      );
    await seed("actor-old", "100 days");
    await seed("actor-mid", "10 days");
    await seed("actor-new", "1 day");
  });

  it("derives last_actor + last_modified_at from the newest event, recent_actors from the 30d window", async () => {
    const res = await req("/api/bootstrap");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { nodes: BootNode[] };

    const node = data.nodes.find((n) => n.id === withEventsId)!;
    expect(node).toBeTruthy();

    // newest event wins for both, and they come from the SAME row
    expect(node.last_actor).toBe("actor-new");
    expect(node.last_modified_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    // 30-day window: mid + new in, old out; order-insensitive
    expect([...node.recent_actors].sort()).toEqual(["actor-mid", "actor-new"]);
    expect(node.recent_actors).not.toContain("actor-old");
  });

  it("a node with no events keeps NULL last_actor/last_modified_at and an empty recent_actors array", async () => {
    const res = await req("/api/bootstrap");
    const data = (await res.json()) as { nodes: BootNode[] };
    const node = data.nodes.find((n) => n.id === noEventsId)!;
    expect(node).toBeTruthy();
    expect(node.last_actor).toBeNull();
    expect(node.last_modified_at).toBeNull();
    expect(node.recent_actors).toEqual([]);
  });

  it("the single-node fetch and sync/nodes ship the same event metadata as bootstrap", async () => {
    // These rows replace the bootstrap row in the client store, so a missing
    // field there erased it from the node after the next sync.
    const single = (await (await req(`/api/nodes/${withEventsId}`)).json()) as BootNode;
    const synced = (await (await req("/api/sync/nodes", { method: "POST", json: { ids: [withEventsId, noEventsId] } })).json()) as { nodes: BootNode[] };
    for (const node of [single, synced.nodes.find((n) => n.id === withEventsId)!]) {
      expect(node.last_actor).toBe("actor-new");
      expect(node.last_modified_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect([...node.recent_actors].sort()).toEqual(["actor-mid", "actor-new"]);
    }
    expect(synced.nodes.find((n) => n.id === noEventsId)!.recent_actors).toEqual([]);
  });
});
