// Permission matrix — the read-policy iron law generalized to the WHOLE GET
// surface, as a sweep over the real assembled app (src/index.ts).
//
// The endpoint inventory is INTROSPECTED from the Hono router (app.routes),
// so a newly mounted GET route is automatically swept; if it carries a path
// param this file doesn't know how to substitute, the suite FAILS — that is
// the completeness gate (extend PARAM_FILL deliberately, never silently).
//
// For every mounted GET endpoint:
//   (a) anonymous            → 401, except the explicitly public surface
//                              (/health, /api/site, GET /api/media/*)
//   (b) viewer session       → any clean status, and the response body must
//                              NEVER contain the restricted node's title,
//                              body marker, slug, or id
//   (c) bearer token whose  → 403 token_scope outside /api/mcp/* (tokens are
//       agent is in no space       MCP credentials), public paths still public,
//                              and never any restricted content
//
// One node in an admin-only space (the viewer is not a member) is seeded; its identifying strings
// are globally unique so a single byte-level scan of every response (JSON,
// HTML, SVG, zip — entry names are plaintext) catches a leak anywhere.
//
// Bug this matrix found (fixed in this change set): GET /api/export returned
// EVERY non-hidden node (title+slug+full markdown, zip) to any authenticated
// role — no readableNodeIdSet bound. Same for the GET /api/export-static
// no-snapshot fallback. Both now filter (routes/publish.ts).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { createToken } from "../services/agentTokens.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import { mountedRoutes } from "./helpers/appRoutes.js";
import { startFakeRenderer } from "./helpers/fakeRenderer.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

// ── Controllable session (better-auth mocked; identity resolved from the
//    REAL actors table via external_id, so the role chain stays genuine) ─────
let sessionExternalId: string | null = null;
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: {
      getSession: vi.fn(async () =>
        sessionExternalId
          ? { user: { id: sessionExternalId, name: "Matrix Viewer", email: "viewer@matrix.test" } }
          : null),
    },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

const { app } = await import("../app.js");

const STAMP = Date.now();
const SECRET_TITLE = `PMTOPSECRET${STAMP}`;
const SECRET_BODY = `PMSECRETBODY${STAMP}`;
const SECRET_SLUG = `pmtopsecret-${STAMP}`;

// Endpoints that hit node_tasks, which a CONCURRENT change set is migrating
// to tasks-as-nodes (table already dropped in the shared test DB, code not
// yet landed). An admin-side control probe decides at runtime whether they
// are environmental 500s; anything 500ing OUTSIDE this allowlist fails.
const MID_MIGRATION_OK = new Set(["/api/bootstrap", "/api/day/:date/lens", "/api/sync"]);

// A 503 with one of these codes is an optional integration this environment
// doesn't configure (the test env sets no AI provider), answered on purpose
// with a stable code — not a broken endpoint. Matched by CODE, not by path,
// so a real 500 on the same route still fails.
const UNCONFIGURED_CODES = new Set(["ai_not_configured"]);
async function isUnconfigured(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;
  const body = await res.clone().json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" && UNCONFIGURED_CODES.has(body.error);
}

// Skipped entirely (not part of the testable GET surface):
//   /api/auth/*       — better-auth is mocked here
//   /api/events/stream — SSE; holds the connection open (anonymous leg still
//                        covers it: the middleware 401s before the handler)
//   /api/tasks/*      — concurrent agent owns the tasks subsystem
const SKIP_AUTHED = (p: string) => p.startsWith("/api/auth") || p === "/api/events/stream" || p.startsWith("/api/tasks");
const SKIP_ALL = (p: string) => p.startsWith("/api/auth") || p.startsWith("/api/tasks");

// Mirrors index.ts isPublicRead: /health, GET /api/site, GET /api/media/* and the
// live site's search index GET /api/site/search.idx/*.
const PUBLIC = (p: string) =>
  p === "/health" || p === "/api/site" || p.startsWith("/api/media/") || p.startsWith("/api/site/search.idx/");

describe.skipIf(!isTestDb)("permission matrix (real app, DB)", () => {
  let WS = "";
  let renderer: Awaited<ReturnType<typeof startFakeRenderer>> | null = null;
  afterAll(async () => { await renderer?.close(); });
  let openNodeId = "";
  let labelTagId = "";
  let restrictedId = "";
  let bearer = "";
  let viewerExternalId = "";
  let inventory: string[] = [];
  let adminBroken = new Set<string>();

  // Concrete value for each known path param. UNKNOWN params throw — the
  // completeness gate for newly mounted parameterized routes.
  function fill(path: string): string {
    return path.replace(/:([A-Za-z_]+)/g, (_m, name: string) => {
      switch (name) {
        case "id":
          return path.startsWith("/api/tags") ? labelTagId : openNodeId;
        case "tagId": return labelTagId;
        case "date": return "2026-06-11";
        case "event_id": return "999999999999"; // nonexistent → clean 404 path
        case "blockId": return "nosuchblock";
        case "hash": return "deadbeef";
        case "filename": return "nosuchfile.png";
        case "viewId": return "00000000-0000-0000-0000-000000000000";
        // /api/tags/:sourceId/merge-preview (tag merge, a06384c). The benign
        // label tag is a real source; with no ?target= the handler 400s after
        // requireActor — exactly the clean authed-but-incomplete path the
        // matrix wants (401 anonymous / <500 viewer / 403 bearer still hold).
        case "sourceId": return labelTagId;
        // GET /api/review/:nodeId/state (review module) — the open note.
        case "nodeId": return openNodeId;
        // GET /api/backup/restore/jobs/:job (backup restore, #442) — a
        // nonexistent job → clean 404 for the person, 403 for a bearer.
        case "job": return "00000000-0000-0000-0000-000000000000";
        // GET /api/me/prefs/:key (#467) — an unknown key → clean 404 for
        // the person, 401 anonymous.
        case "key": return "nosuchpref";
        // GET /api/nodes/:id/block-home/:ref ([[A#^id]] fallback) — no note holds it → { home: null }.
        case "ref": return "nosuchref";
        default:
          throw new Error(
            `permissionMatrix: no substitution for :${name} in ${path} — a new parameterized GET route appeared; extend fill() deliberately`,
          );
      }
    });
  }

  type Leg = { headers?: Record<string, string>; session?: string | null };
  async function request(path: string, leg: Leg): Promise<Response> {
    sessionExternalId = leg.session ?? null;
    try {
      return await app.request(path, { headers: leg.headers ?? {} });
    } finally {
      sessionExternalId = null;
    }
  }

  async function bodyBytes(res: Response): Promise<Buffer> {
    return Buffer.from(await res.arrayBuffer());
  }

  function expectNoSecret(path: string, bytes: Buffer): void {
    for (const needle of [SECRET_TITLE, SECRET_BODY, SECRET_SLUG, restrictedId]) {
      expect(bytes.includes(Buffer.from(needle)), `${path} leaked "${needle}"`).toBe(false);
    }
  }

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    // The zip export asks the frontend for each page; a stand-in answers.
    renderer = await startFakeRenderer(() => WS);
    await q(
      `INSERT INTO actors (workspace_id, name, type, external_id)
       SELECT $1, 'System', 'agent', 'system'
       WHERE NOT EXISTS (SELECT 1 FROM actors WHERE workspace_id = $1 AND external_id = 'system')`,
      [WS],
    );

    // (b) the viewer — resolved through the real actors table by external_id
    viewerExternalId = `pm-viewer-${STAMP}`;
    await q(
      `INSERT INTO actors (workspace_id, name, type, external_id)
       VALUES ($1, 'Matrix Viewer', 'human', $2)`,
      [WS, viewerExternalId],
    );

    // (c) an agent actor in no space + a bearer token for it (reaches nothing)
    const agent = await q<{ id: string }>(
      `INSERT INTO actors (workspace_id, name, type, external_id)
       VALUES ($1, 'Matrix Agent', 'agent', $2) RETURNING id`,
      [WS, `pm-agent-${STAMP}`],
    );
    const tok = await createToken(agent.rows[0]!.id, { name: "pm-empty-scope", access: "read" });
    bearer = tok.plaintext;

    // open node — also the substitution target for every :id
    openNodeId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$3,'open body') RETURNING id`,
      [WS, `pm-open-${STAMP}`, `pm-open-${STAMP}`],
    )).rows[0]!.id;

    // benign label tag — substitution target for :tagId / tags' :id
    labelTagId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug)
       VALUES ($1,'manual','class_tag',$2,$3) RETURNING id`,
      [WS, `pm-label-${STAMP}`, `pm-label-tag-${STAMP}`],
    )).rows[0]!.id;

    // restricted node: in a space only the System admin belongs to
    const systemId = (await q<{ id: string }>(
      `SELECT id::text FROM actors WHERE workspace_id = $1 AND external_id = 'system'`, [WS],
    )).rows[0]!.id;
    const secretSpace = await adminOnlySpace(WS, `pm-secret-${STAMP}`, [systemId]);
    restrictedId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$3,$4) RETURNING id`,
      [WS, SECRET_TITLE, SECRET_SLUG, SECRET_BODY],
    )).rows[0]!.id;
    await putInSpace(restrictedId, secretSpace);
    await seedQ(
      `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source)
       VALUES ($1,$2,'pmsecretattr',$3,'text',false,'explicit')`,
      [WS, restrictedId, SECRET_BODY],
    );

    // Introspected inventory: every mounted GET route.
    inventory = mountedRoutes(app, (method) => method === "GET").map((r) => r.path);

    // Admin control probe (native-origin bypass → System admin): which
    // endpoints are broken for EVERYONE right now (mid-migration), so the
    // viewer/token legs don't blame permissions for environmental 500s.
    for (const path of inventory) {
      if (SKIP_AUTHED(path)) continue;
      const res = await request(fill(path), { headers: { origin: "http://localhost" } });
      if (res.status >= 500 && !(await isUnconfigured(res))) adminBroken.add(path);
    }
  });

  it("introspection found a plausible inventory (completeness gate)", () => {
    expect(inventory.length).toBeGreaterThanOrEqual(45);
    // sentinels — if these disappear, the introspection itself broke
    for (const sentinel of [
      "/health", "/api/site", "/api/bootstrap", "/api/events",
      "/api/nodes/:id/attributes", "/api/tags", "/api/export/markdown.zip", "/api/sync",
    ]) {
      expect(inventory, `sentinel ${sentinel} missing from inventory`).toContain(sentinel);
    }
    // every parameterized path must be fillable — throws on unknown params
    for (const path of inventory) {
      if (!SKIP_ALL(path)) fill(path);
    }
  });

  it("environmental 500s are confined to the known mid-migration set", () => {
    for (const path of adminBroken) {
      expect(MID_MIGRATION_OK.has(path), `${path} 500s for an ADMIN — not a permissions issue, a broken endpoint`).toBe(true);
    }
  });

  it("(a) anonymous → 401 everywhere except the explicitly public surface", async () => {
    for (const path of inventory) {
      if (SKIP_ALL(path)) continue;
      const res = await request(fill(path), {});
      if (PUBLIC(path)) {
        expect(res.status, `${path} should be public, not 401`).not.toBe(401);
        expect(res.status, `${path} (public) must not 500`).toBeLessThan(500);
      } else {
        expect(res.status, `${path} must 401 for anonymous`).toBe(401);
      }
    }
  });

  it("(b) viewer outside the restricted node's space: clean statuses, restricted content ABSENT everywhere", async () => {
    for (const path of inventory) {
      if (SKIP_AUTHED(path)) continue;
      const res = await request(fill(path), { session: viewerExternalId });
      if (!adminBroken.has(path)) {
        expect(res.status, `${path} 500s for a viewer`).toBeLessThan(500);
      }
      expectNoSecret(path, await bodyBytes(res));
    }
  });

  it("(c) bearer token with empty space scope: confined to /api/mcp/*, restricted content ABSENT everywhere", async () => {
    for (const path of inventory) {
      if (SKIP_AUTHED(path)) continue;
      const res = await request(fill(path), { headers: { authorization: `Bearer ${bearer}` } });
      if (PUBLIC(path)) {
        expect(res.status, `${path} is public — token must not be rejected`).not.toBe(401);
        expect(res.status, `${path} (public) must not 500`).toBeLessThan(500);
      } else if (path.startsWith("/api/mcp")) {
        if (!adminBroken.has(path)) {
          expect(res.status, `${path} 500s for a scoped token`).toBeLessThan(500);
        }
      } else {
        // tokens are MCP credentials — the REST surface is closed to them
        expect(res.status, `${path} must be 403 token_scope for a bearer token`).toBe(403);
      }
      expectNoSecret(path, await bodyBytes(res));
    }
  });

  it("sanity: the restricted node IS served to an admin (the gate is space membership, not the seed)", async () => {
    const res = await request(`/api/nodes/${restrictedId}/versions`, { headers: { origin: "http://localhost" } });
    expect(res.status).toBe(200);
    const viewerRes = await request(`/api/nodes/${restrictedId}/versions`, { session: viewerExternalId });
    expect([403, 404]).toContain(viewerRes.status);
  });
});
