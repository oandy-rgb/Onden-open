import { describe, it, expect, vi, beforeEach } from "vitest";

// ── HTTP integration tests ───────────────────────────────────────────────────
//
// Drives the real assembled Hono app via app.request(). The DB layer is
// mocked the same way as the dispatcher unit tests so we don't need a live
// Postgres in the test loop. The goal here is to catch dead-route / wrong-
// table / signature-drift bugs that pure unit tests can't see — for example,
// the role-acl routes that queried a dropped table (caught manually by the
// user; this harness would have flagged it on every PR).

// ── DB mock ──────────────────────────────────────────────────────────────────
// Shared state captures what was queried so tests can prime per-call responses.
type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number };
const queries: Array<{ sql: string; params: unknown[] }> = [];
// Sentinel row for the System actor — looked up by the native-origin auth
// fallback. We always return it so write tests can hit handlers without
// session fixtures.
const SYSTEM_ACTOR = { id: "actor-system", name: "System", type: "agent" };
// Whether the mocked owner check (spine/authority.ts isWorkspaceOwner) says the
// native System actor is the owner; a test flips it to exercise the deny path.
const mock = { systemIsOwner: true };

// Scripted query results, consumed in call order. Replaces per-call
// mockResolvedValueOnce so the base impl can (a) keep recognising the
// native-origin actor lookup and (b) SKIP spine root-mutate bookkeeping (the C1
// event-append advisory lock; idempotency claim) without either consuming a
// scripted slot — otherwise each real query shifts onto the wrong result.
const scripted: QueryResult[] = [];
const poolQuery = vi.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>(
  async (sql, params = []) => {
    queries.push({ sql, params });
    // The owner check (spine/authority.ts isWorkspaceOwner): the native System
    // actor is the owner (mock.systemIsOwner). Not a scripted slot.
    if (sql.includes("owner_actor_id") && sql.includes("FROM actors a JOIN workspaces w")) {
      return mock.systemIsOwner ? { rows: [{ owner: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    // Recognise the native-origin actor lookup and return the System sentinel.
    if (/external_id\s*=\s*'system'/i.test(sql)) {
      return { rows: [SYSTEM_ACTOR], rowCount: 1 };
    }
    // resolveCurrentActor: the native System actor, or — with a token id (a
    // bearer request, services/agentTokens.ts resolveBearerActor) — the
    // scripted token actor.
    if (sql.includes("FROM actors a") && sql.includes("t.access")) {
      if (params[2] != null) return scripted.shift() ?? { rows: [], rowCount: 0 };
      return { rows: [{ ...SYSTEM_ACTOR, token_id: null }], rowCount: 1 };
    }
    if (/pg_advisory_xact_lock|lock_timeout|idempotency_keys/.test(sql)) return { rows: [], rowCount: 0 };
    // Spine bookkeeping: mutate() pins the actor's personal space for the
    // transaction (set_config onden.actor_space) — not a scripted slot.
    if (sql.includes("onden.actor_space")) return { rows: [], rowCount: 0 };
    // Module bookkeeping: a library module's node hooks ask whether the
    // workspace imported it (modules/index.ts hooksWhenImported) — the write
    // gate before an attribute is stored among them (D114). Answered as a
    // workspace where every module is on and the confirm-once ones got their
    // yes; not a scripted slot.
    if (sql.includes("SELECT modules_off, modules_confirmed FROM workspaces")) {
      return { rows: [{ modules_off: [], modules_confirmed: ["rss", "semantic", "website"] }], rowCount: 1 };
    }
    // Authority bookkeeping: the reserved workspace-config lookup (reservedNodes.ts)
    // answers "not a config node" without consuming a scripted slot.
    if (sql.includes("reserved_key = 'workspace-config'")) return { rows: [], rowCount: 0 };
    // MB3: uniqueTagSlug's existence probe (SELECT id … WHERE slug = $2) is
    // slug bookkeeping, not part of the scripted SQL shape — empty = "free".
    if (/SELECT id FROM content_nodes WHERE workspace_id = \$1 AND slug = \$2/.test(sql)) return { rows: [], rowCount: 0 };
    // Default empty result — tests script specific shapes via scripted.push().
    return scripted.shift() ?? { rows: [], rowCount: 0 };
  },
);

// withTransaction must actually invoke the callback — otherwise transactional
// routes never run their bodies.
const withTransactionImpl = vi.fn(async <T>(fn: () => Promise<T>) => fn());

// Write stamps (spine/stamps.ts) need the real node table; this file stands in for the database.
vi.mock("../spine/stamps.js", () => ({ stampTransaction: async () => {}, countWritesWithoutStamp: async () => 0, currentStampWall: async () => null }));
vi.mock("../db.js", () => ({
  pool: { query: poolQuery, connect: async () => ({ query: poolQuery, release: () => {} }) },
  q: poolQuery,
  withReadSnapshot: async <T>(fn: () => Promise<T>) => fn(),
  // ER3: event() now returns the inserted id (string). The mock returns a fake id.
  event: vi.fn(async () => "1"),
  migrate: vi.fn(async () => {}),
  pruneEvents: vi.fn(async () => {}),
  getWorkspaceId: vi.fn(async () => "ws-1"),
  withTransaction: withTransactionImpl,
  withSavepoint: withTransactionImpl,
  // The spine's mutate() asks whether a tx is already open; in tests it isn't,
  // so it routes through withTransaction (which runs the callback inline above).
  inTransaction: () => false,
  requireTransaction: () => {},
}));

// Better-auth and git boot routines shouldn't run in tests — they touch FS /
// external state. Stub them out before the app is imported.
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));
vi.mock("../git.js", () => ({
  STORE: "/tmp/onden-test-store",
  initGit: vi.fn(async () => {}),
  writeAndCommit: vi.fn(async () => {}),
  getDiff: vi.fn(async () => ""),
}));
// Companion remote-push backup — same mock posture (no real Octokit calls
// during tests). Returns null = "no remote configured" which is what the
// real implementation does when env vars are unset.
vi.mock("../services/githubBackup.js", () => ({
  pushNoteToBackup: vi.fn(async () => null),
}));

// siteConfig walks its own queries (workspace-config tag + node lookup) and
// crashes without a primed mock. Stub the read paths so /bootstrap returns
// a sane shape under test.
vi.mock("../services/siteConfig.js", () => ({
  getSiteConfig: vi.fn(async () => ({ brand: "Test", accent: "#000" })),
  findConfigNodeId: vi.fn(async () => "config-node"),
  siteConfigAt: vi.fn(async () => ({ brand: "Test", accent: "#000" })),
  chromeBlocksAt: vi.fn(async () => null),
  patchSiteConfig: vi.fn(async () => ({})),
  getChromeBlocks: vi.fn(async () => null),
  setChromeBlocks: vi.fn(async () => {}),
}));

// Now import the app. NODE_ENV is set to "test" by vitest by default, which
// gates the serve() bootstrap.
const { app } = await import("../app.js");
const { auth } = await import("../auth.js");

beforeEach(() => {
  poolQuery.mockClear();
  queries.length = 0;
  scripted.length = 0;
  vi.mocked(auth.api.getSession).mockReset().mockResolvedValue(null);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

// Hono's built-in app.request() accepts a URL+init or a Request and returns a
// Response. We adopt the same shape as fetch. The return type is Response |
// Promise<Response>; we always await, so coerce to Promise<Response>.
async function req(path: string, init?: RequestInit): Promise<Response> {
  return await app.request(path, init);
}

// Native-origin request lets us bypass session auth via the native-app actor
// fallback. Most write tests use this so we don't need a Better Auth fixture.
async function nativeReq(path: string, init: RequestInit = {}): Promise<Response> {
  return await app.request(path, {
    ...init,
    headers: { ...(init.headers ?? {}), Origin: "http://localhost" },
  });
}

// ── Dead-route detection ─────────────────────────────────────────────────────
// These would have caught the role-acl bug (querying dropped table). Even though
// the routes now return 404 by design, leaving these tests in place pins the
// shape so a future regression that "helpfully" re-adds them is immediately flagged.

describe("dead routes stay 404 (audit guards)", () => {
  it("GET /api/role-acl is 404 (substrate replaced by tag-policy)", async () => {
    // Auth via native origin: the global gate runs before routing, so an
    // anonymous GET would 401 before we can observe the route is dead. With an
    // actor present, a true dead route 404s.
    const res = await nativeReq("/api/role-acl");
    expect(res.status).toBe(404);
  });

  // Write methods require auth — we pass it via native origin so a "still
  // alive" route would actually hit its handler and reveal itself. With auth
  // bypassed, a true dead route 404s; an alive one would 200/403/4xx-with-body.
  it("POST /api/role-acl is 404 (auth bypassed via native origin)", async () => {
    const res = await nativeReq("/api/role-acl", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  it("POST /api/nodes/:id/approve is 404 (approvals flow through /api/versions/:id/merge)", async () => {
    const res = await nativeReq("/api/nodes/some-id/approve", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// ── Auth gating ──────────────────────────────────────────────────────────────

describe("auth middleware", () => {
  it.each(["GET", "PATCH"])("rejects an old account expectation before %s reaches actor lookup or the route", async method => {
    vi.mocked(auth.api.getSession).mockResolvedValue({ user: { id: "user-b" } } as never);
    const res = await req("/api/nodes/abc", { method, headers: { "X-Onden-Expected-User": "user-a" } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "account_changed" });
    expect(queries).toEqual([]);
  });

  it("an expected account cannot turn native bypass into a substitute for a missing cookie", async () => {
    const res = await nativeReq("/api/nodes/abc", { method: "PATCH", headers: { "X-Onden-Expected-User": "user-a" } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "account_changed" });
    expect(queries).toEqual([]);
  });

  it("a matching cookie resolves its actual actor, without accepting an actor chosen by the header", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue({ user: { id: "user-a", name: "A" } } as never);
    scripted.push({ rows: [{ id: "actor-a", name: "A", type: "human", scoped_tag_ids: null }], rowCount: 1 });
    const res = await req("/api/not-an-onden-route", { headers: { "X-Onden-Expected-User": "user-a" } });
    expect(res.status).toBe(404); // passed auth; no route or mutation exists
    expect(queries[0].params).toEqual(["ws-1", "user-a"]);
  });

  it("write methods without a session or native origin → 401", async () => {
    const res = await req("/api/nodes/abc", {
      method: "PATCH",
      body: JSON.stringify({ title: "x" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });

  it("anonymous GET is gated → 401 (the Critical-leak fix)", async () => {
    // Phase A closed the anonymous-read leak: every GET outside the public
    // allowlist (/health, /api/site, /api/media/*) now requires an actor.
    const res = await req("/api/bootstrap");
    expect(res.status).toBe(401);
  });

  it("authed GET passes through", async () => {
    // The first read is the event cursor and the server's time; the rest stays as scripted.
    scripted.push({ rows: [{ id: "ws-1", name: "Default", slug: "default", home_node_id: null, last_event_id: "0", server_time: new Date("2026-10-24T00:00:00Z") }], rowCount: 1 });
    const res = await nativeReq("/api/bootstrap");
    expect(res.status).toBe(200);
  });

  // A bearer token is an MCP agent credential, confined to /api/mcp/* — NOT a
  // general API key. (Only bMcpSmoke exercised this live; pin it in CI here.)
  // resolveBearerActor finds the token by hash, then loads the actor and its
  // scope through resolveCurrentActor: prime both results.
  const tokenRow = { rows: [{ id: "tk1", actor_id: "a1" }], rowCount: 1 };
  const tokenActor = {
    rows: [{ id: "a1", name: "Bot", type: "agent", token_id: "tk1", allowed_tools: null, access: "write", allowed_tag_ids: null, expires_at: null }],
    rowCount: 1,
  };
  it("a human account expectation cannot be satisfied by a bearer actor", async () => {
    scripted.push(tokenRow, tokenActor);
    const response = await req("/api/mcp/tools", { headers: { Authorization: "Bearer ondt_test", "X-Onden-Expected-User": "user-a" } });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "account_changed" });
  });
  it("a bearer token is confined to the MCP surface (403 elsewhere)", async () => {
    scripted.push(tokenRow, tokenActor); // resolveBearerActor lookup
    const off = await req("/api/bootstrap", { headers: { Authorization: "Bearer ondt_test" } });
    expect(off.status).toBe(403);
  });

  it("the same bearer token still works on /api/mcp/*", async () => {
    scripted.push(tokenRow, tokenActor); // resolveBearerActor lookup
    const onMcp = await req("/api/mcp/tools", { headers: { Authorization: "Bearer ondt_test" } });
    expect(onMcp.status).toBe(200); // confinement passes → GET /api/mcp/tools serves the registry
  });
});

// GET /api/actors/:id/{tokens,stats} expose permission-administration data —
// token metadata is an escalation-target list; the stats endpoint is the
// governance meter. They must gate on notPrincipalAdmin (denies tokenScope AND
// non-admins) like the actor/token MUTATIONS, not a bare role-rank check that a
// delegated admin-role BEARER token would pass. Runtime coverage to complement
// actorsAuthzGate.test.ts (which source-pins the gate identifier).
describe("GET /api/actors/:id/{tokens,stats} — permission-data read gate", () => {
  const ID = "00000000-0000-0000-0000-0000000000aa";
  const READS = [`/api/actors/${ID}/tokens`, `/api/actors/${ID}/stats`];
  // A delegated ADMIN-role agent credential — the exact actor the bare role-rank
  // check used to let through. resolveBearerActor's two lookups (token by hash,
  // then the actor) are each request's first queries; prime them per call.
  const bearerAdmin = {
    rows: [{ id: "ba1", name: "AdminBot", type: "agent", token_id: "tk-admin", allowed_tools: null, access: "write", allowed_tag_ids: null, expires_at: null }],
    rowCount: 1,
  };

  it("denies a non-admin actor with owner_only 403 (route gate fires)", async () => {
    mock.systemIsOwner = false;
    try {
      for (const path of READS) {
        const res = await nativeReq(path);
        expect(res.status, path).toBe(403);
        expect((await res.json()).error, path).toBe("owner_only");
      }
    } finally {
      mock.systemIsOwner = true;
    }
  });

  it("denies a delegated admin-role bearer token (MCP credential, 403)", async () => {
    for (const path of READS) {
      scripted.push({ rows: [{ id: "tk-admin", actor_id: "ba1" }], rowCount: 1 }, bearerAdmin); // resolveBearerActor lookups
      const res = await req(path, { headers: { Authorization: "Bearer ondt_admin" } });
      expect(res.status, path).toBe(403);
    }
  });

  it("lets the workspace owner (admin) PAST the gate", async () => {
    // SYSTEM_ACTOR.role is admin by default → notPrincipalAdmin passes → the
    // handler proceeds to the actor-exists lookup (empty mock → 404), proving
    // the gate did NOT block the owner (not a trivial "everything 403s").
    for (const path of READS) {
      const res = await nativeReq(path);
      expect(res.status, path).not.toBe(403);
      expect(res.status, path).toBe(404);
    }
  });
});

// ── /health smoke ────────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns ok when the DB responds", async () => {
    const res = await req("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });
});

// ── /api/events shape ────────────────────────────────────────────────────────

describe("GET /api/events", () => {
  it("returns the documented {events, count} shape", async () => {
    scripted.push({
      rows: [
        { id: 1, actor_type: "user", actor_id: "u1", event_type: "NODE_CREATED",
          target_type: "node", target_id: "n1", payload: {}, created_at: new Date().toISOString() },
      ],
      rowCount: 1,
    });
    const res = await nativeReq("/api/events");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("events");
    expect(body).toHaveProperty("count");
    expect(Array.isArray(body.events)).toBe(true);
  });

  it("rejects bad limit with 400", async () => {
    const res = await nativeReq("/api/events?limit=abc");
    expect(res.status).toBe(400);
  });

  it("rejects bad actor_type with 400", async () => {
    const res = await nativeReq("/api/events?actor_type=robot");
    expect(res.status).toBe(400);
  });
});

// ── /api/tags shape (the new admin substrate) ───────────────────────────────

describe("GET /api/tags", () => {
  it("returns array of tags joined with schema", async () => {
    scripted.push({
      rows: [{
        id: "t1", name: "task", color: "#3b82f6", schema_id: "s1",
        schema_fields: [], schema_views: {}, schema_behaviour: {},
        schema_slug: "task",
        usage_count: 0,
      }],
      rowCount: 1,
    });
    // The tag list is now read-gated as a node list: after the list query it
    // calls visibleNodeIdsForActor (the space read rule) and keeps only visible
    // tag ids. Script that visibility query to include t1.
    scripted.push({ rows: [{ id: "t1" }], rowCount: 1 });
    const res = await nativeReq("/api/tags");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body[0]).toMatchObject({ name: "task", schema_id: "s1" });
  });

  it("PATCH /api/tags/:id/schema requires admin (no session → 401)", async () => {
    const res = await req("/api/tags/t1/schema", {
      method: "PATCH",
      body: JSON.stringify({ fields: [] }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });
});

// ── /api/sync delta shape ────────────────────────────────────────────────────

describe("GET /api/sync", () => {
  it("empty event log returns all-empty deltas including attributes", async () => {
    // First call: visibleNodeIdsForActor (readableNodeIdSet, audit #1) → none;
    // then SELECT events → empty; then membership_epoch. No later MAX cursor.
    scripted.push({ rows: [], rowCount: 0 });
    scripted.push({ rows: [], rowCount: 0 });
    scripted.push({ rows: [{ membership_epoch: 0 }], rowCount: 1 });
    const res = await nativeReq("/api/sync?since=0");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      last_event_id: 0,
      nodes: { upsert: [], delete: [] },
      edges: { upsert: [], delete: [] },
      tasks: { upsert: [], delete: [] },
      attributes: { upsert: [], delete: [] },
    });
  });

  it("ATTRIBUTE_SET event resolves into attributes.upsert row", async () => {
    // Only the parallel queries with size>0 actually hit pool.query — the
    // others return a literal `{rows: []}` and consume no mock. For
    // ATTRIBUTE_SET that's: visible-ids (readableNodeIdSet, audit #1),
    // events, membership_epoch (P3.5), attributes. Four calls.
    scripted.push({ rows: [{ id: "node-1" }], rowCount: 1 });
    scripted.push({
      rows: [{
        id: 5, event_type: "ATTRIBUTE_SET", target_type: "node",
        target_id: "node-1", payload: { key: "status", value: "done" },
      }],
      rowCount: 1,
    });
    scripted.push({ rows: [{ membership_epoch: 0 }], rowCount: 1 });
    scripted.push({
      rows: [{
        node_id: "node-1", key: "status", value: "done",
        value_type: "text", is_inheritable: false, source: "explicit",
      }],
      rowCount: 1,
    });
    const res = await nativeReq("/api/sync?since=0");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attributes.upsert).toEqual([{
      node_id: "node-1", key: "status", value: "done",
      value_type: "text", is_inheritable: false, source: "explicit",
    }]);
  });

  it("NODE_HIDDEN_CHANGED event triggers a node-row refresh (dispatcher propagation gap fix)", async () => {
    scripted.push({ rows: [{ id: "node-7" }], rowCount: 1 }); // visible ids (audit #1)
    scripted.push({
      rows: [{
        id: 7, event_type: "NODE_HIDDEN_CHANGED", target_type: "node",
        target_id: "node-7", payload: { hidden: true },
      }],
      rowCount: 1,
    });
    scripted.push({ rows: [{ membership_epoch: 0 }], rowCount: 1 }); // P3.5 epoch query
    scripted.push({ rows: [], rowCount: 0 }); // target is content, not a tag needing catalog/member refresh
    scripted.push({
      rows: [{ id: "node-7", title: "x", hidden: true }],
      rowCount: 1,
    });
    const res = await nativeReq("/api/sync?since=0");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes.upsert).toEqual([{ id: "node-7", title: "x", hidden: true }]);
  });
});

// ── Attribute conflict detection (Day 4 local-first) ────────────────────────

describe("PUT /api/nodes/:id/attributes/:key — conflict detection", () => {
  it("a missing target is denied without writing an attribute or success event", async () => {
    const eventMod = await import("../db.js");
    const beforeEvents = (eventMod.event as ReturnType<typeof vi.fn>).mock.calls.length;
    scripted.push({ rows: [], rowCount: 0 }); // no previous attribute
    scripted.push({ rows: [], rowCount: 0 }); // fieldForKey (after the row lock): no schema field
    scripted.push({ rows: [], rowCount: 0 }); // space write check: target absent
    const response = await nativeReq("/api/nodes/missing/attributes/status", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "changed", value_type: "text" }),
    });
    expect(response.status).toBe(403);
    expect(queries.some(({ sql }) => /INSERT INTO node_attributes/.test(sql))).toBe(false);
    expect((eventMod.event as ReturnType<typeof vi.fn>).mock.calls.length).toBe(beforeEvents);
  });

  it("client_updated_at older than server updated_at → ATTRIBUTE_CONFLICT emitted", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    // Spy on the event() mock to capture what got emitted during the chain.
    // The vi.mock at the top exposes a plain stub; reinstall a capturing one.
    const eventMod = await import("../db.js");
    (eventMod.event as ReturnType<typeof vi.fn>).mockImplementation(
      async (_ws: string, type: string, _tt: string, _ti: string, payload: Record<string, unknown>) => {
        events.push({ type, payload });
      },
    );

    // Sequence the route hits (post-spine-migration order):
    //   1. SELECT existing row's (value, updated_at) — read up-front, before
    //      mutate(), because the event's revert txMeta + conflict are derived
    //      from it.
    //   2. authority: spaceCanWrite → the actor edits the node's space
    //   3. inside the mutation: INSERT ... ON CONFLICT UPDATE
    //      then (event ATTRIBUTE_SET — mocked), (event ATTRIBUTE_CONFLICT — mocked)
    //   4. dispatchAttributeChange → tags lookup (empty, no behaviour fires)
    // The stored value was written a minute ago; the edit is dated by its age (below), not by the client's clock.
    scripted.push({
      rows: [{ value: "old-server", updated_at: new Date(Date.now() - 60_000).toISOString() }],
      rowCount: 1,
    }); // existing-row snapshot (now read first)
    scripted.push({ rows: [], rowCount: 0 }); // P2 fieldForKey (after the row lock): no schema field matches → free-form
    scripted.push({ rows: [{ "?column?": 1 }], rowCount: 1 }); // space write check: editor of the node's space
    scripted.push({ rows: [], rowCount: 1 }); // INSERT/UPDATE
    scripted.push({ rows: [], rowCount: 0 }); // dispatcher tag lookup (empty)

    const res = await nativeReq("/api/nodes/abc/attributes/status", {
      method: "PUT",
      body: JSON.stringify({
        value: "client-wins",
        value_type: "text",
        is_inheritable: false,
        // The edit was made 1 hour before the request (both readings are the device's own clock)
        client_updated_at: "2026-06-02T09:00:00Z",
      }),
      headers: { "Content-Type": "application/json", "X-Onden-Client-Now": String(Date.parse("2026-06-02T10:00:00Z")) },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conflict).toMatchObject({
      previous_value: "old-server",
      client_updated_at: "2026-06-02T09:00:00Z",
    });
    const conflictEvent = events.find((e) => e.type === "ATTRIBUTE_CONFLICT");
    expect(conflictEvent).toBeDefined();
    expect(conflictEvent?.payload).toMatchObject({
      key: "status",
      incoming_value: "client-wins",
      overridden_value: "old-server",
    });
  });

  it("client_updated_at >= server updated_at → no conflict", async () => {
    const events: Array<{ type: string }> = [];
    const eventMod = await import("../db.js");
    (eventMod.event as ReturnType<typeof vi.fn>).mockImplementation(
      async (_ws: string, type: string) => { events.push({ type }); },
    );

    scripted.push({
      rows: [{ value: "older", updated_at: "2026-06-02T09:00:00Z" }],
      rowCount: 1,
    });
    scripted.push({ rows: [], rowCount: 0 }); // fieldForKey (after the row lock): free-form
    scripted.push({ rows: [{ "?column?": 1 }], rowCount: 1 }); // space write check: editor of the node's space
    scripted.push({ rows: [], rowCount: 1 }); // INSERT/UPDATE
    scripted.push({ rows: [], rowCount: 0 }); // dispatcher tag lookup

    const res = await nativeReq("/api/nodes/abc/attributes/status", {
      method: "PUT",
      body: JSON.stringify({
        value: "new",
        value_type: "text",
        is_inheritable: false,
        client_updated_at: "2026-06-02T10:00:00Z", // made just before the request
      }),
      headers: { "Content-Type": "application/json", "X-Onden-Client-Now": String(Date.parse("2026-06-02T10:00:00Z")) },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conflict).toBeUndefined();
    expect(events.find((e) => e.type === "ATTRIBUTE_CONFLICT")).toBeUndefined();
  });

  it("no client_updated_at supplied → conflict detection skipped", async () => {
    const events: Array<{ type: string }> = [];
    const eventMod = await import("../db.js");
    (eventMod.event as ReturnType<typeof vi.fn>).mockImplementation(
      async (_ws: string, type: string) => { events.push({ type }); },
    );
    scripted.push({
      rows: [{ value: "old", updated_at: "2026-06-02T10:00:00Z" }],
      rowCount: 1,
    });
    scripted.push({ rows: [], rowCount: 0 }); // fieldForKey (after the row lock): free-form
    scripted.push({ rows: [{ "?column?": 1 }], rowCount: 1 }); // space write check: editor of the node's space
    scripted.push({ rows: [], rowCount: 1 });
    scripted.push({ rows: [], rowCount: 0 });
    const res = await nativeReq("/api/nodes/abc/attributes/status", {
      method: "PUT",
      body: JSON.stringify({ value: "x", value_type: "text", is_inheritable: false }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conflict).toBeUndefined();
    expect(events.find((e) => e.type === "ATTRIBUTE_CONFLICT")).toBeUndefined();
  });

  it("explicit PUT upgrades a previously 'derived' row's source", async () => {
    // Regression for dogfood finding #1: a tag default set status=wishlist with
    // source='derived'; user PUT'd status=reading; DB kept source='derived'
    // because the ON CONFLICT UPDATE clause omitted `source = EXCLUDED.source`.
    // The fix is invisible at the route response (always reports 'explicit'),
    // so we inspect the SQL the route ran.
    scripted.push({ rows: [{ value: "wishlist", updated_at: "2026-06-02T09:00:00Z" }], rowCount: 1 });
    scripted.push({ rows: [], rowCount: 0 }); // fieldForKey (after the row lock): free-form
    scripted.push({ rows: [{ "?column?": 1 }], rowCount: 1 }); // space write check: editor of the node's space
    scripted.push({ rows: [], rowCount: 1 }); // INSERT/UPDATE

    const res = await nativeReq("/api/nodes/abc/attributes/status", {
      method: "PUT",
      body: JSON.stringify({ value: "reading", value_type: "text", is_inheritable: false }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);

    // mockResolvedValueOnce bypasses the default impl that pushes to `queries`,
    // so we inspect the raw mock call log instead.
    const upsertCall = poolQuery.mock.calls.find(([sql]) =>
      /INSERT INTO node_attributes/.test(sql as string) && /ON CONFLICT/.test(sql as string),
    );
    expect(upsertCall, "expected to find the upsert SQL in poolQuery.mock.calls").toBeDefined();
    expect(upsertCall![0] as string).toMatch(/source\s*=\s*EXCLUDED\.source/);
  });
});

// ── TagPack import — owner-only authoring gate ──────────────────────────────
// (Packs no longer carry an access policy — tags carry no permission under
// spaces — so there is no install-time policy check left to test.)

describe("POST /api/tags/import — owner-only gate", () => {
  it("rejects a pack with 403 when actor isn't admin", async () => {
    // Default native-origin actor is the System sentinel, the owner per the
    // mock. To exercise the deny path we temporarily say it is not, for the
    // duration of this one test.
    mock.systemIsOwner = false;
    try {
      const res = await nativeReq("/api/tags/import", {
        method: "POST",
        body: JSON.stringify({
          name: "salary-data",
          fields: [],
          behaviour: {},
        }),
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      // Audit #2: importing a pack AUTHORS schema/behaviour, so the
      // owner-only gate (same bar as PATCH /:id/schema) applies. The refusal
      // is the principal_admin AuthorityError, answered by httpError.ts.
      expect(body.error).toContain("reserved to the workspace owner");
    } finally {
      mock.systemIsOwner = true;
    }
  });

  it("accepts a pack from the owner + emits TAG_IMPORTED", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const eventMod = await import("../db.js");
    (eventMod.event as ReturnType<typeof vi.fn>).mockImplementation(
      async (_ws: string, type: string, _tt: string, _ti: string, payload: Record<string, unknown>) => {
        events.push({ type, payload });
      },
    );
    // collision check returns empty (no existing tag)
    scripted.push({ rows: [], rowCount: 0 });
    // dependency lookup skipped since pack.dependencies is empty
    // P4.1 CONTRACT: import now does a single class_tag node INSERT (schema folded
    // onto the node's tag_schema) — no separate collection_schemas INSERT.
    scripted.push({ rows: [{ id: "tag-1", title: "pubpost", color: "#10b981" }], rowCount: 1 });

    const res = await nativeReq("/api/tags/import", {
      method: "POST",
      body: JSON.stringify({
        name: "pubpost",
        color: "#10b981",
        description: "A published blog post",
        version: "0.1.0",
        fields: [{ name: "title", type: "text", required: true }],
        behaviour: {},
        _format: "onden.tagpack/v1",
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ id: "tag-1", name: "pubpost", missing_dependencies: [] });
    expect(events.find((e) => e.type === "TAG_IMPORTED")).toBeDefined();
  });

  it("rejects empty / malformed pack with 400", async () => {
    const res = await nativeReq("/api/tags/import", {
      method: "POST",
      body: JSON.stringify({ /* no name */ }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects unauthorized requests (no native origin) with 401", async () => {
    const res = await req("/api/tags/import", {
      method: "POST",
      body: JSON.stringify({ name: "x" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });
});
