// Boundary-value sweep (the third-quadrant hunt) against the REAL assembled
// Hono app (src/index.ts) and a real Postgres: hostile-but-wellformed inputs
// must produce a clean 4xx (never 500) and leave no damaged state behind.
//
// Drives the production middleware chain (auth resolution, global onError) via
// the native-origin admin bypass (NODE_ENV=test enables it), so what's
// asserted here is what a real client would see.
//
// Bugs this sweep found (fixed in the same change set):
//   • bare schema.parse(...) / c.req.json() turned malformed input into 500s
//     on nodes create/patch, query, workspace config →  global onError now
//     maps ZodError/SyntaxError to 400 (src/index.ts)
//   • GET /api/events?since=<20 digits> passed the \d+ check and 500'd on the
//     ::bigint cast → bounded in buildEventQuery (routes/events.ts)
//   • GET /api/day/0000-01-01/lens passed the JS calendar check (JS has year
//     0000, Postgres does not) and 500'd on the ::date cast → routes/day.ts
//   • POST /api/nodes with {id: X, parent_id: X} inserted a self-parent cycle
//     (single-row FK satisfies itself) → create now nulls self-parent like
//     PATCH does (routes/nodes.ts)
//   • PATCH /api/nodes/:id editing emoji (😀→😁) threw "URI malformed" inside
//     makeInversePatch (diff-match-patch surrogate split) → full-replacement
//     fallback in services/eventLog/bodyPatch.ts
//
// Findings FLAGGED but not fixed here (other agents own the module):
//   • POST /api/rss/subscribe accepts data:/file:/javascript: URLs at the
//     schema layer (zod .url() is protocol-agnostic). javascript:/file: die
//     at fetch (422, no state). data: feeds FETCH AND SUBSCRIBE successfully
//     → a protocol allowlist (http/https) belongs in subscribeSchema.
//   • One feed document carrying the same guid twice creates duplicate
//     articles (dedup set only contains DB guids, not in-batch ones) —
//     modules/rss/fetch.ts.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { q, pool, getWorkspaceId } from "../db.js";
import { drainOutbox } from "../services/outbox.js";
import { NODE_TITLE_MAX } from "../utils.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { startFakeRenderer } from "./helpers/fakeRenderer.js";
import { seedQ } from "./helpers/seedQ.js";
import { publishWithPreview } from "./helpers/publishWithPreview.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

// ── Real-app harness ─────────────────────────────────────────────────────────
// auth.js is mocked (no better-auth bootstrapping in tests); identity comes
// from the native-origin bypass → the migration-seeded System actor (admin).
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const { app } = await import("../app.js");

const NATIVE = { origin: "http://localhost" };

// The System actor has no personal space and may sit in several spaces, so a
// new note names its space (services/spaces.ts newNoteSpace).
let DEFAULT_SPACE = "";

function req(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json: rawJson, ...rest } = init;
  const json = path === "/api/nodes" && rest.method === "POST" && rawJson && typeof rawJson === "object"
    && !("space_id" in rawJson) ? { ...rawJson, space_id: DEFAULT_SPACE } : rawJson;
  const headers: Record<string, string> = {
    ...NATIVE,
    ...(rest.headers as Record<string, string> | undefined),
  };
  if (json !== undefined) headers["content-type"] = "application/json";
  return Promise.resolve(app.request(path, {
    ...rest,
    headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  }));
}

const anon = (path: string, init: RequestInit = {}) => Promise.resolve(app.request(path, init));

async function nodeCount(title: string, workspaceId: string): Promise<number> {
  const r = await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM content_nodes WHERE title = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
    [title, workspaceId],
  );
  return Number(r.rows[0]!.n);
}

const realFetch = globalThis.fetch;

describe.skipIf(!isTestDb)("boundary-value sweep (real app, DB)", () => {
  let WS = "";
  let bootstrapHealthy = false;
  let renderer: Awaited<ReturnType<typeof startFakeRenderer>> | null = null;

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    // RSS is a confirm-once module (#634): subscribing is refused with 409 until
    // the owner has agreed. Another file leaves the shared workspace agreed, so
    // without this E4a/E4b/E5 passed in the full suite and failed alone.
    await setModulesOn(WS, null);
    // The zip export asks the frontend for each page; a stand-in answers.
    renderer = await startFakeRenderer(() => WS);
    DEFAULT_SPACE = (await q<{ id: string }>(
      `SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [WS])).rows[0]!.id;
    // The native bypass resolves actors.external_id='system'; migrations seed
    // it, but be defensive about a hand-built test DB.
    await q(
      `INSERT INTO actors (workspace_id, name, type, external_id)
       SELECT $1, 'System', 'agent', 'system'
       WHERE NOT EXISTS (SELECT 1 FROM actors WHERE workspace_id = $1 AND external_id = 'system')`,
      [WS],
    );
    // Control probe (see A8): is /api/bootstrap healthy ON THIS SCHEMA before
    // we create anything hostile?
    bootstrapHealthy = (await req("/api/bootstrap")).status === 200;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // Local fixture server for feed bodies — safeFetch (node:http + connect-time
  // address validation) can't be intercepted by patching globalThis.fetch.
  const fixtureServers: import("node:http").Server[] = [];
  afterAll(async () => { for (const srv of fixtureServers) srv.close(); await renderer?.close(); });
  async function serveFixture(body: string): Promise<string> {
    const { createServer } = await import("node:http");
    const srv = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/rss+xml" });
      res.end(body);
    });
    fixtureServers.push(srv);
    srv.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => srv.once("listening", resolve));
    return `http://127.0.0.1:${(srv.address() as { port: number }).port}/feed.xml`;
  }

  // ── A. node create / patch ────────────────────────────────────────────────

  it("A1. empty title → clean 400, nothing created (was 500 pre-onError)", async () => {
    // Compare before/after in this workspace: other tests may leave untitled notes behind.
    const before = await nodeCount("", WS);
    const res = await req("/api/nodes", { method: "POST", json: { title: "" } });
    expect(res.status).toBe(400);
    expect(await nodeCount("", WS)).toBe(before);
  });

  it("A2. malformed JSON body → clean 400 (was 500)", async () => {
    const res = await req("/api/nodes", {
      method: "POST",
      body: '{"title": "trunc',
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("A3. a title at the 500-char cap round-trips; a 10k-char title is refused (W35)", async () => {
    const refused = await req("/api/nodes", { method: "POST", json: { title: "T".repeat(10_000), markdown: "x" } });
    expect(refused.status).toBe(400);
    const title = "T".repeat(NODE_TITLE_MAX);
    const res = await req("/api/nodes", { method: "POST", json: { title, markdown: "x" } });
    expect(res.status).toBe(201);
    const node = await res.json();
    expect(node.title.length).toBe(NODE_TITLE_MAX);
    expect(typeof node.slug).toBe("string");
    expect(node.slug.length).toBeGreaterThan(0);
  });

  it("A4. title of only emoji / zero-width chars slugs to the fallback, not an empty slug", async () => {
    const res = await req("/api/nodes", { method: "POST", json: { title: "😀​‍😁" } });
    expect(res.status).toBe(201);
    const node = await res.json();
    expect(node.slug.length).toBeGreaterThan(0);
    expect(node.slug).not.toMatch(/^\s*$/);
    const back = await req(`/api/nodes/${node.id}/versions`);
    expect(back.status).toBe(200);
  });

  it("A5. 1MB markdown body round-trips intact", async () => {
    const md = "0123456789abcdef".repeat(65536); // 1 MiB
    const res = await req("/api/nodes", { method: "POST", json: { title: `big-${Date.now()}`, markdown: md } });
    expect(res.status).toBe(201);
    const node = await res.json();
    const row = await q<{ len: string }>(`SELECT length(markdown)::text AS len FROM content_nodes WHERE id = $1`, [node.id]);
    expect(Number(row.rows[0]!.len)).toBe(md.length);
  });

  it("A6. unicode-normalization slug lookalikes don't collide or 500", async () => {
    const t = Date.now();
    const nfc = await req("/api/nodes", { method: "POST", json: { title: `café-${t}` } });           // é = U+00E9
    const nfd = await req("/api/nodes", { method: "POST", json: { title: `café-${t}` } });     // e + U+0301
    expect(nfc.status).toBe(201);
    expect(nfd.status).toBe(201);
    const a = await nfc.json();
    const b = await nfd.json();
    expect(a.slug).not.toBe(b.slug); // uniqueSlug must disambiguate, not overwrite
  });

  it("A7. create with parent_id === own id does NOT persist a self-cycle (fixed)", async () => {
    const id = crypto.randomUUID();
    const res = await req("/api/nodes", { method: "POST", json: { id, parent_id: id, title: `self-${id.slice(0, 8)}` } });
    expect(res.status).toBe(201);
    const row = await q<{ parent_id: string | null }>(`SELECT parent_id FROM content_nodes WHERE id = $1`, [id]);
    expect(row.rows[0]!.parent_id).toBeNull();
  });

  it("A8. PATCH refuses to close a parent cycle (M4); a cycle forced directly into the DB still survives every read path (depth-capped)", async () => {
    const mk = async (title: string) =>
      (await (await req("/api/nodes", { method: "POST", json: { title } })).json()).id as string;
    const t = Date.now();
    const a = await mk(`cyc-a-${t}`);
    const b = await mk(`cyc-b-${t}`);
    // WRITE side (M4): A under B is fine; B under A would close a cycle → rejected.
    expect((await req(`/api/nodes/${a}`, { method: "PATCH", json: { parent_id: b } })).status).toBe(200);
    expect((await req(`/api/nodes/${b}`, { method: "PATCH", json: { parent_id: a } })).status).toBe(400);
    // READ side (defense in depth): a cycle can still arise from legacy data or a
    // direct write, so force one PAST the route guard and assert every recursive
    // read path is depth-capped and survives (a regression to an uncapped walk
    // would hang here). a→b already; set b→a to close the loop.
    await seedQ(`UPDATE content_nodes SET parent_id = $2 WHERE id = $1`, [b, a]);
    expect((await req(`/api/nodes/${a}/inherited-attributes`)).status).toBe(200);
    expect((await req(`/api/nodes/${a}/rollup-attributes`)).status).toBe(200);
    expect((await req(`/api/nodes/${a}/versions`)).status).toBe(200);
    expect((await req("/api/events?limit=5")).status).toBe(200);
    // /api/bootstrap also reads node_tasks, which is mid-flight in the
    // tasks-as-nodes migration (a concurrent change set owns it). Only require
    // it to survive the cycle when it works for a cycle-free workspace too —
    // the property under test is "the CYCLE doesn't break reads", not "the
    // tasks migration is finished".
    if (bootstrapHealthy) {
      expect((await req("/api/bootstrap")).status).toBe(200);
    }
  });

  it("A9. a deeply nested parent chain (12 levels) creates and reads cleanly", async () => {
    const t = Date.now();
    let parent: string | null = null;
    let leaf = "";
    for (let i = 0; i < 12; i++) {
      const res = await req("/api/nodes", {
        method: "POST",
        json: { title: `chain-${t}-${i}`, ...(parent ? { parent_id: parent } : {}) },
      });
      expect(res.status).toBe(201);
      leaf = (await res.json()).id;
      parent = leaf;
    }
    expect((await req(`/api/nodes/${leaf}/inherited-attributes`)).status).toBe(200);
  });

  it("A10. PATCH with wrong-typed fields → clean 400, node untouched (was 500)", async () => {
    const res0 = await req("/api/nodes", { method: "POST", json: { title: `patchme-${Date.now()}` } });
    const node = await res0.json();
    const res = await req(`/api/nodes/${node.id}`, { method: "PATCH", json: { markdown: 123, hidden: "yes" } });
    expect(res.status).toBe(400);
    const row = await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [node.id]);
    expect(row.rows[0]!.markdown).toBe("");
  });

  it("A11. emoji body edit (surrogate split) saves cleanly (was 500: URI malformed)", async () => {
    const res0 = await req("/api/nodes", { method: "POST", json: { title: `emoji-${Date.now()}`, markdown: "mood: 😀" } });
    const node = await res0.json();
    const res = await req(`/api/nodes/${node.id}`, { method: "PATCH", json: { markdown: "mood: 😁" } });
    expect(res.status).toBe(200);
    const row = await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [node.id]);
    expect(row.rows[0]!.markdown).toBe("mood: 😁");
  });

  // ── B. attributes ────────────────────────────────────────────────────────

  let attrNode = "";
  async function ensureAttrNode(): Promise<string> {
    if (attrNode) return attrNode;
    const res = await req("/api/nodes", { method: "POST", json: { title: `attr-host-${Date.now()}` } });
    attrNode = (await res.json()).id;
    return attrNode;
  }

  it("B1. reserved `_`-prefixed key is blocked from the user route", async () => {
    const id = await ensureAttrNode();
    const res = await req(`/api/nodes/${id}/attributes/_reserved`, { method: "PUT", json: { value: "x" } });
    expect(res.status).toBe(400);
    const row = await q(`SELECT 1 FROM node_attributes WHERE node_id = $1 AND key = '_reserved'`, [id]);
    expect(row.rows.length).toBe(0);
  });

  it("B2. empty key has no route (trailing slash) → 404, nothing stored", async () => {
    const id = await ensureAttrNode();
    const res = await req(`/api/nodes/${id}/attributes/`, { method: "PUT", json: { value: "x" } });
    expect(res.status).toBe(404);
    const row = await q(`SELECT 1 FROM node_attributes WHERE node_id = $1 AND key = ''`, [id]);
    expect(row.rows.length).toBe(0);
  });

  it("B3. 100-element multi-value (JSON array string) stores and round-trips byte-exact", async () => {
    const id = await ensureAttrNode();
    const value = JSON.stringify(Array.from({ length: 100 }, (_, i) => `v${i}`));
    const res = await req(`/api/nodes/${id}/attributes/multi`, { method: "PUT", json: { value } });
    expect(res.status).toBe(200);
    const list = await req(`/api/nodes/${id}/attributes`);
    const attrs = await list.json() as Array<{ key: string; value: string }>;
    expect(attrs.find((a) => a.key === "multi")?.value).toBe(value);
  });

  it("B4. JSON-looking string values stay strings (no implicit parsing)", async () => {
    const id = await ensureAttrNode();
    const value = '{"role":"admin"}';
    const res = await req(`/api/nodes/${id}/attributes/jsonish`, { method: "PUT", json: { value } });
    expect(res.status).toBe(200);
    const attrs = await (await req(`/api/nodes/${id}/attributes`)).json() as Array<{ key: string; value: string }>;
    expect(attrs.find((a) => a.key === "jsonish")?.value).toBe(value);
  });

  it("B5. invalid value_type → clean 400 (was 500)", async () => {
    const id = await ensureAttrNode();
    const res = await req(`/api/nodes/${id}/attributes/typed`, { method: "PUT", json: { value: "x", value_type: "blob" } });
    expect(res.status).toBe(400);
  });

  // ── C. day lens / events boundaries ──────────────────────────────────────

  it("C1. day lens date extremes: year 0 → 400 (was 500), 9999-12-31 → 200, 2026-02-31 → 400, garbage → 400", async () => {
    expect((await req("/api/day/0000-01-01/lens")).status).toBe(400);
    expect((await req("/api/day/2026-02-31/lens")).status).toBe(400);
    expect((await req("/api/day/not-a-date/lens")).status).toBe(400);
    expect((await req("/api/day/2026-1-1/lens")).status).toBe(400);
    // The valid-date path reads node_tasks (mid-flight tasks-as-nodes
    // migration owned by a concurrent change set). Boundary dates must behave
    // EXACTLY like a mundane control date — if the control works, the extreme
    // must too; if the control is migration-broken, the extreme may not be
    // blamed on the boundary value.
    const control = (await req("/api/day/2026-06-11/lens")).status;
    const extreme = (await req("/api/day/9999-12-31/lens")).status;
    if (control === 200) expect(extreme).toBe(200);
    else expect(extreme).toBe(control);
  });

  it("C2. events since: 0 ok; negative/garbage 400; bigint overflow 400 (was 500)", async () => {
    expect((await req("/api/events?since=0")).status).toBe(200);
    expect((await req("/api/events?since=-1")).status).toBe(400);
    expect((await req(`/api/events?since=${encodeURIComponent("1;DELETE FROM domain_events")}`)).status).toBe(400);
    expect((await req("/api/events?since=99999999999999999999")).status).toBe(400);
    expect((await req("/api/events?since=9223372036854775807")).status).toBe(200); // max int8 exactly
  });

  it("C2b. event ids in paths and the inbox: bigint overflow 400 (was 500 on the ::bigint cast)", async () => {
    const huge = "99999999999999999999";
    for (const path of [
      `/api/events/${huge}/preview`,
      `/api/events/${huge}/cascade-preview`,
      `/api/inbox/approvals/${huge}/approve`,
      `/api/inbox/failed-effects/${huge}/retry`,
      `/api/inbox/groups/${huge}/approve`,
    ]) {
      const method = path.includes("preview") ? "GET" : "POST";
      expect((await req(path, { method })).status, path).toBe(400);
    }
    expect((await req(`/api/events/${huge}/restore`, { method: "POST", json: {} })).status).toBe(400);
    expect((await req(`/api/inbox/${huge}/approve`, { method: "POST" })).status).toBe(400);
    expect((await req("/api/inbox/batch", { method: "POST", json: { decision: "approve", event_ids: [huge] } })).status).toBe(400);
  });

  it("C3. events limit: 0/-1 → 400; 10^9 → 200 capped at 500", async () => {
    expect((await req("/api/events?limit=0")).status).toBe(400);
    expect((await req("/api/events?limit=-1")).status).toBe(400);
    const big = await req("/api/events?limit=1000000000");
    expect(big.status).toBe(200);
    const body = await big.json();
    expect(body.events.length).toBeLessThanOrEqual(500);
  });

  // ── D. query endpoint ─────────────────────────────────────────────────────

  it("D1. query limit 0 / -1 / 10^9 → clean 400 (was 500)", async () => {
    for (const limit of [0, -1, 1_000_000_000]) {
      const res = await req("/api/query", { method: "POST", json: { limit } });
      expect(res.status, `limit=${limit}`).toBe(400);
    }
  });

  it("D2. query where-clause with unknown keys returns cleanly (no 500, no rows invented)", async () => {
    const res = await req("/api/query", {
      method: "POST",
      json: { where: { definitely_not_a_key_xyz: "1' OR '1'='1" } },
    });
    expect(res.status).toBeLessThan(500);
    if (res.status === 200) {
      const body = await res.json();
      expect(Array.isArray(body.rows)).toBe(true);
      expect(body.rows.length).toBe(0);
    }
  });

  it("D3. query reserved `_`-prefixed where keys are ignored, not an error", async () => {
    const res = await req("/api/query", { method: "POST", json: { where: { _internal: "x" }, limit: 5 } });
    expect(res.status).toBe(200);
  });

  // ── E. rss subscribe ─────────────────────────────────────────────────────

  async function sourceCountFor(url: string): Promise<number> {
    const r = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM rss_subscriptions WHERE url = $1`,
      [url],
    );
    return Number(r.rows[0]!.n);
  }

  it("E1. javascript: URL → clean 4xx, no source created", async () => {
    const res = await req("/api/rss/subscribe", { method: "POST", json: { url: "javascript:alert(1)" } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await sourceCountFor("javascript:alert(1)")).toBe(0);
  });

  it("E2. file: URL → clean 4xx, no source created", async () => {
    const res = await req("/api/rss/subscribe", { method: "POST", json: { url: "file:///etc/passwd" } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await sourceCountFor("file:///etc/passwd")).toBe(0);
  });

  it("E3. data: URL is refused at the subscribe boundary (http/https allowlist)", async () => {
    const url = `data:application/rss+xml,${encodeURIComponent(
      `<rss version="2.0"><channel><title>inline</title></channel></rss>`,
    )}`;
    const res = await req("/api/rss/subscribe", { method: "POST", json: { url } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // Feeds that carry every article in full pass 5 MB in the wild, so the cap
  // is 25 MB (fetch.ts FEED_MAX_BYTES). Serve from a local fixture server
  // (SAFE_FETCH_ALLOW_PRIVATE=1 is the NODE_ENV=test-only loopback escape).
  const bigFeed = (count: number) => {
    const items = Array.from({ length: count }, (_, i) =>
      `<item><title>big item ${i}</title><guid>big-${count}-${i}</guid><description>${"x".repeat(170_000)}</description></item>`,
    ).join("");
    return `<?xml version="1.0"?><rss version="2.0"><channel><title>Big</title>${items}</channel></rss>`;
  };

  it("E4a. a 10MB full-text feed subscribes (it used to hit the old 5MB cap)", async () => {
    const xml = bigFeed(60);
    expect(xml.length).toBeGreaterThan(10_000_000);
    const url = await serveFixture(xml);
    process.env.SAFE_FETCH_ALLOW_PRIVATE = "1";
    try {
      const res = await req("/api/rss/subscribe", { method: "POST", json: { url } });
      expect(res.status).toBe(201);
      expect(await sourceCountFor(url)).toBe(1);
    } finally {
      delete process.env.SAFE_FETCH_ALLOW_PRIVATE;
    }
  }, 60_000);

  it("E4b. a feed over the 25MB cap is refused — feed_too_large, no source, never a 500", async () => {
    const xml = bigFeed(160);
    expect(xml.length).toBeGreaterThan(26_500_000);
    const url = await serveFixture(xml);
    process.env.SAFE_FETCH_ALLOW_PRIVATE = "1";
    try {
      const res = await req("/api/rss/subscribe", { method: "POST", json: { url } });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: "feed_too_large" });
      expect(await sourceCountFor(url)).toBe(0);
    } finally {
      delete process.env.SAFE_FETCH_ALLOW_PRIVATE;
    }
  }, 60_000);

  it("E5. duplicate guids within ONE document collapse to a single article (in-batch dedup)", async () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Dup</title>
      <item><title>same</title><guid>dup-guid-1</guid></item>
      <item><title>same</title><guid>dup-guid-1</guid></item>
      <item><title>same</title><guid>dup-guid-1</guid></item>
    </channel></rss>`;
    const url = await serveFixture(xml);
    process.env.SAFE_FETCH_ALLOW_PRIVATE = "1";
    let id = "";
    try {
      const res = await req("/api/rss/subscribe", { method: "POST", json: { url } });
      expect(res.status).toBe(201);
      ({ id } = await res.json());
      await drainFetchFor(id);
    } finally {
      delete process.env.SAFE_FETCH_ALLOW_PRIVATE;
    }
    const n = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM rss_staging
        WHERE subscription_id = $1 AND guid = 'dup-guid-1'`,
      [id],
    );
    // audit #9 fixed: first occurrence wins inside one document
    expect(Number(n.rows[0]!.n)).toBe(1);
    expect(Number(n.rows[0]!.n)).toBeLessThanOrEqual(3);
  }, 30_000);

  async function drainFetchFor(sourceId: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const r = await q<{ id: string; status: string }>(
        `SELECT id::text, status FROM outbox WHERE dedup_key = $1 ORDER BY outbox.id DESC LIMIT 1`,
        [`rss_fetch:${sourceId}`],
      );
      const row = r.rows[0];
      if (!row) throw new Error(`no rss_fetch intent for ${sourceId}`);
      if (row.status === "done") return;
      if (row.status !== "pending") throw new Error(`rss_fetch ended ${row.status}`);
      await drainOutbox({ id: row.id });
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error("rss_fetch never drained");
  }

  // ── F. publish payload ────────────────────────────────────────────────────

  it("F1. blocks with unknown types + circular bindings publish and render without a 500", async () => {
    // a published node so the static build has at least one page
    const created = await req("/api/nodes", { method: "POST", json: { title: `pub-${Date.now()}`, markdown: "hello" } });
    const node = await created.json();
    await req(`/api/nodes/${node.id}/attributes/_published`, { method: "PUT", json: { value: "true" } });

    const blocks = [
      { id: "b1", type: "totally_unknown_block_type", props: { body: "x" } },
      { id: "b2", type: '<script>alert(1)</script>', props: {} },
      // "circular" bindings: each block binds the page that hosts the other
      { id: "b3", type: "page_link", binding: { node_id: node.id }, props: { label: "loop-a" } },
      { id: "b4", type: "markdown_body", binding: { node_id: node.id } },
      { id: "b5", type: "page_link", binding: { node_id: "00000000-0000-0000-0000-000000000000" }, props: {} },
    ];
    const res = await publishWithPreview(
      (p, b) => req(p, { method: "POST", json: b }),
      { title: "Sweep Site", presentation: { blocks, layouts: { [node.id]: ["b3", "b4", "b3"] } } },
    );
    expect(res.status).toBe(201);

    // the live serve-time payload still works
    expect((await req("/api/site")).status).toBe(200);

    // and the static renderer walks the hostile blocks without throwing
    const staticRes = await req("/api/export-static");
    expect(staticRes.status).toBe(200);
    const zip = Buffer.from(await staticRes.arrayBuffer());
    expect(zip.length).toBeGreaterThan(0);
    // escaped, not executed: the raw script tag must not appear verbatim in
    // any rendered HTML (zip entry contents are DEFLATE'd, but small unique
    // literals survive; the strong check is "no crash + 200s" above)
  }, 30_000);

  it("F2. publish with malformed presentation (non-object) → not a 500", async () => {
    const res = await req("/api/publish", { method: "POST", json: { title: "x", presentation: "not-an-object", preview_hash: "0".repeat(64) } });
    expect(res.status).toBe(400); // zod: record expected
  });

  // ── G. canvases: typed input + uuid params ──────────────────────────────
  // canvases.ts used to trust raw c.req.json() (no schema) and pass :id
  // straight into a uuid column — wrong-typed cards / non-uuid ids 500'd.

  it("G1. canvas :id that isn't a uuid → 400 everywhere, never a Postgres cast 500", async () => {
    expect((await req("/api/canvases/not-a-uuid")).status).toBe(400);
    expect((await req("/api/canvases/not-a-uuid", { method: "PATCH", json: { title: "x" } })).status).toBe(400);
    expect((await req("/api/canvases/not-a-uuid", { method: "DELETE" })).status).toBe(400);
    expect((await req("/api/boards/not-a-uuid")).status).toBe(400);
    expect((await req("/api/edges/not-a-uuid", { method: "DELETE" })).status).toBe(400);
    expect((await req("/api/pointers/not-a-uuid", { method: "DELETE" })).status).toBe(400);
    expect((await req("/api/tags/not-a-uuid")).status).toBe(400);
  });

  it("G2. canvas create with non-string title → 400; empty body still defaults", async () => {
    expect((await req("/api/canvases", { method: "POST", json: { title: 123 } })).status).toBe(400);
    const ok = await req("/api/canvases", { method: "POST", json: {} });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { title: string }).title).toBe("Untitled Canvas");
  });

  it("G2b. canvas create with a truncated body → 400, not a default canvas", async () => {
    const res = await req("/api/canvases", { method: "POST", body: '{"title": "trunc', headers: { "content-type": "application/json" } });
    expect(res.status).toBe(400);
  });

  it("G3. board patch with wrong-typed cards/sections → 400; a whole-document canvas save → 410", async () => {
    const created = await req("/api/canvases", { method: "POST", json: { title: "Sweep Canvas" } });
    const canvas = (await created.json()) as { id: string };

    // string x on a card (would have been a numeric-column cast error mid-apply)
    const badCard = await req(`/api/boards/${canvas.id}`, {
      method: "PATCH",
      json: { cards: { upsert: [{ nodeId: "00000000-0000-0000-0000-000000000001", x: "12", y: 0 }] } },
    });
    expect(badCard.status).toBe(400);

    // sections must be an object of changes
    const badSections = await req(`/api/boards/${canvas.id}`, {
      method: "PATCH",
      json: { sections: "nope" },
    });
    expect(badSections.status).toBe(400);

    // The layout is never taken as a whole document on /api/canvases (W23).
    const wholeDocument = await req(`/api/canvases/${canvas.id}`, {
      method: "PATCH",
      json: { data: { nodes: [] } },
    });
    expect(wholeDocument.status).toBe(410);

    // null title (would UPDATE a NOT NULL column)
    const badTitle = await req(`/api/canvases/${canvas.id}`, {
      method: "PATCH",
      json: { title: null },
    });
    expect(badTitle.status).toBe(400);

    // the canvas itself is unharmed and still patchable
    const good = await req(`/api/canvases/${canvas.id}`, { method: "PATCH", json: { title: "Still fine" } });
    expect(good.status).toBe(200);
  });
});
