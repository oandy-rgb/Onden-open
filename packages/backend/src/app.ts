import { clientProtocolGate, serverProtocolHeader } from "./clientGate.js";
import { DEVICE_ID_HEADER, isUuid, SERVER_PROTOCOL_HEADER } from "@onden/markdown";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { buildHeader } from "./buildHeader.js";
import { getWorkspaceId, pool } from "./db.js";
import { mutate, requireActor, withIdempotencyKey, isCommittedIdempotencyKey, UnauthorizedError } from "./spine/mutate.js";
import { apiOnError } from "./httpError.js";
import { readJsonBody } from "./routes/params.js";
import { log } from "./logger.js";
import { config, isProduction, isTest } from "./config.js";
import { nativeBypassEnabled } from "./nativeBypass.js";
import { auth, configuredSocialProviders } from "./auth.js";
// Every restore inverse registered before the first request (eventRestore also
// loads it lazily, so a restore never depends on this line).
import "./services/restoreHandlers.js";
import actorRouter from "./routes/actors.js";
import meRouter from "./routes/me.js";
import invitesRouter from "./routes/invites.js";
import spacesRouter from "./routes/spaces.js";
import mediaRouter from "./routes/media.js";
import nodeRouter from "./routes/nodes.js";
import blockLinkRouter from "./routes/blockLinks.js";
import edgesRouter from "./routes/edges.js";
import syncRouter from "./routes/sync.js";
import bootstrapRouter from "./routes/bootstrap.js";
import workspaceRouter from "./routes/workspace.js";
import manifestsRouter from "./routes/manifests.js";
import versionsRouter from "./routes/versions.js";
import historyRouter from "./routes/history.js";
import eventsRouter from "./routes/events.js";
import inboxRouter from "./routes/inbox.js";
import tagsRouter from "./routes/tags.js";
import exportRouter from "./routes/export.js";
import backupRouter from "./routes/backup.js";
import bookmarkRouter from "./routes/bookmark.js";
import pointerRouter from "./routes/pointers.js";
import queryRouter from "./routes/query.js";
import { mountModules } from "./modules/index.js";
import pushRouter from "./routes/push.js";
import type { ActorCtx, ActorType } from "./types.js";
import { eventActorType } from "./types.js";
import { resolveBearerActor, parseBearer } from "./services/agentTokens.js";
import { actorForSession } from "./services/actors.js";
import { SYSTEM_EXTERNAL_ID_SQL } from "./spine/systemActor.js";
import { withRequestDevice } from "./requestContext.js";
// The assembled Hono instance — pure assembly, no listening port, no migrations,
// no background jobs, no top-level await — so any environment can import it:
// vitest drives it via app.request(), server.ts (Node boot) serves it, and a
// browser/desktop host calls app.fetch. Booting lives in server.ts.
export const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();

// Global error mapping — input-validation 4xx + spine 401/403 + 500 fallback.
// The handler lives in httpError.ts so router-level test harnesses mount the
// exact same boundary; see that file for the full rationale.
app.onError(apiOnError);

const NATIVE_ORIGINS = new Set(["http://localhost", "capacitor://localhost"]);

// Native-origin → admin actor is a development convenience: the Capacitor app
// runs from `capacitor://localhost`, and locally-served Astro dev runs from
// `http://localhost`. Origin headers are normally honoured by the browser but
// can be forged by any non-browser client (curl, any HTTP lib). Without a
// gate, exposing the backend to a routable network address turns this into a
// trivial admin grant.
//
// See nativeBypass.ts: enabled only OUTSIDE production, and there only under
// test or with ALLOW_NATIVE_BYPASS=1. It is FORCE-DISABLED in production
// regardless of the flag, so the flag can never become a remote admin grant.
const ALLOW_NATIVE_BYPASS = nativeBypassEnabled();

if (!isTest()) {
  log.info("auth", `native-origin admin bypass: ${ALLOW_NATIVE_BYPASS ? "ENABLED" : "disabled"}`);
  if (config.is("ALLOW_NATIVE_BYPASS", "1") && isProduction()) {
    log.warn("auth", "ALLOW_NATIVE_BYPASS=1 is IGNORED in production — the native-origin admin bypass is force-disabled there (it would grant admin to any client sending Origin: http://localhost). Use session auth or agent tokens.");
  }
}

// Use origin callback so we always reflect the actual origin (required when credentials:true).
// CORS_ORIGIN="*" allows any origin; otherwise reflect only listed + native origins.
const corsAllowedSet = config.is("CORS_ORIGIN", "*")
  ? null // null = allow all
  : new Set([
      ...(config.str("CORS_ORIGIN")?.split(",").map((s) => s.trim()) ?? ["http://localhost:4321"]),
      "http://localhost",
      "capacitor://localhost",
    ]);

// `Access-Control-Allow-Origin: *` with `Access-Control-Allow-Credentials: true`
// is rejected by every modern browser — the credentialed fetch will fail. But
// configuration drift is real: someone setting `CORS_ORIGIN="*"` to "fix"
// blocked requests has produced a permissive cross-origin posture that only
// browsers refuse to use; a custom client (curl, native, sloppy SDK) will
// still send the cookie or token, leaking session credentials to any origin.
if (!isTest() && corsAllowedSet === null) {
  // In production this is a hard boot failure, not a warning: the official
  // image ships NODE_ENV=production, so a wildcard can only reach a running
  // process on a dev box. A warning is ignorable configuration drift; a
  // refused boot is not.
  if (isProduction()) {
    throw new Error(
      "CORS_ORIGIN=\"*\" is refused in production: combined with credentials:true it hands session credentials to any origin for non-browser clients. Set CORS_ORIGIN to an explicit comma-separated origin list.",
    );
  }
  log.warn("cors", "WARNING: CORS_ORIGIN=\"*\" combined with credentials:true. Browsers reject this pair, but non-browser clients do not — session credentials are at risk if the API is reachable beyond trusted networks. Set CORS_ORIGIN to an explicit list of origins.");
}

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!corsAllowedSet) return origin; // allow all, reflect back
      return corsAllowedSet.has(origin) ? origin : "";
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: ["X-Onden-Build", SERVER_PROTOCOL_HEADER],
    credentials: true,
  }),
);

// Origin guard for cookie-authenticated writes (CSRF) and the MCP endpoint
// (DNS rebinding). CORS above only decides what a browser may READ; it does not
// refuse the request. A browser always sends Origin on a cross-site write, so a
// write (or any /api/mcp/protocol call) whose Origin is neither listed in
// CORS_ORIGIN nor this server's own host is refused. Requests with no Origin
// (curl, native clients) and bearer-token requests are unaffected: a page in a
// victim's browser can set neither a bearer header nor a forged Origin.
// Hono's csrf() would not do: it only looks at form-typed bodies, and this API
// takes JSON, which a cross-site page can also send.
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  if (!origin || parseBearer(c.req.header("authorization"))) return next();
  if (!UNSAFE_METHODS.has(c.req.method) && c.req.path !== "/api/mcp/protocol") return next();
  if (!corsAllowedSet || corsAllowedSet.has(origin)) return next();
  let sameHost = false;
  try { sameHost = new URL(origin).host === c.req.header("host"); } catch { /* an unparsable Origin is not our own */ }
  if (sameHost) return next();
  return c.json({ error: "origin_not_allowed" }, 403);
});

const withBuildHeader = buildHeader(config.str("ONDEN_BUILD_ID"));
if (withBuildHeader) app.use("*", withBuildHeader);
app.use("*", serverProtocolHeader());

// ── Request log ──────────────────────────────────────────────────────────
// One line per completed request — method, path, status, duration — with the
// same bracket prefix the rest of the server logs use ([outbox], [auth], …).
// Enough to answer "what was the server doing when X happened". Routed
// through the shared logger so LOG_LEVEL/LOG_FORMAT apply; the line stays a
// single msg string (not per-part fields) so the default human output is
// byte-identical to what it always was. /health is skipped (a readiness
// probe every few seconds would drown the signal); the suite is skipped too
// (app.request() driving hundreds of requests would bury vitest output).
if (!isTest()) {
  app.use("*", async (c, next) => {
    if (c.req.path === "/health" || c.req.method === "OPTIONS") return next();
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    log.info("http", `${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
  });
}

// ── Better Auth handler ──────────────────────────────────────────────────
// Public list of OAuth providers the deployment has configured (ids only, no
// secrets) so the login UI shows only the buttons that will actually work. A
// self-host without OAuth set up returns `[]` → the UI stays email/password
// only. Registered BEFORE the /api/auth/* wildcard so it wins (Hono matches in
// declaration order); it's an anonymous-OK read (the guard allowlists /api/auth/*).
app.get("/api/auth/providers", (c) => c.json({ providers: configuredSocialProviders }));
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// ── Actor resolution + auth guard ────────────────────────────────────────
// Resolve the current actor, then require one for EVERY request — reads
// included — except a small allowlist of genuinely public paths. Previously
// GET was let through unauthenticated "so routes can read it", which meant an
// anonymous caller could export/sync/read the whole workspace; read access is
// now gated here, not left to each endpoint to remember.
//
// Public (anonymous-OK) surface:
//   - /api/auth/*       — better-auth's own endpoints (login/signup)
//   - /health           — readiness probe
//   - GET /api/site     — the published-site snapshot anonymous visitors render
//   - GET /api/media/*  — image/file assets embedded in published pages
//                         (POST upload still requires auth)
// CORS preflight (OPTIONS) is always allowed.
const PUBLIC_PATHS = new Set(["/health", "/api/site"]);
app.use("*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth/")) return next();
  // Auth resolution order:
  //   1. Authorization: Bearer <token>  →  agent token actor (multi-agent)
  //   2. Better Auth session cookie     →  human actor
  //   3. Native-origin fallback         →  System actor (dev / Capacitor app)
  // A valid bearer token always wins, so an authenticated agent isn't masked
  // by a stale session cookie present on the same request.
  const bearer = parseBearer(c.req.header("authorization"));
  const bearerActor = bearer ? await resolveBearerActor(bearer) : null;
  if (bearerActor && c.req.header("X-Onden-Expected-User")) throw new UnauthorizedError("account_changed");
  // POST /api/invites/claim resolves the session WITH its invite link, so the
  // first sign-in claims the invited member instead of becoming a viewer
  // (services/actors.ts actorForSession). A missing token is "" — refused,
  // never the ordinary first-sign-in path. Hono caches the parsed body, so
  // the route reads it again.
  const inviteToken = !bearerActor && c.req.method === "POST" && c.req.path === "/api/invites/claim"
    ? await readJsonBody(c).then((b) => (typeof (b as { token?: unknown } | null)?.token === "string" ? (b as { token: string }).token : ""), () => "")
    : null;
  const sessionActor = bearerActor ?? await getCurrentActor(c.req.raw, inviteToken);
  const isNative = ALLOW_NATIVE_BYPASS && NATIVE_ORIGINS.has(c.req.header("origin") ?? "");
  const actor: ActorCtx | null = sessionActor
    ?? (isNative ? await getNativeActor() : null);
  c.set("actor", actor);
  if (c.req.method === "OPTIONS") return next(); // CORS preflight
  const isPublicRead =
    (c.req.method === "GET" || c.req.method === "HEAD") &&
    (c.req.path.startsWith("/api/media/") ||
      // The live site's search index.
      c.req.path.startsWith("/api/site/search.idx/"));
  if (!actor && !PUBLIC_PATHS.has(c.req.path) && !isPublicRead) {
    return c.json({ error: "unauthorized" }, 401);
  }
  // Agent capability boundary: a bearer token is an MCP agent credential, NOT a
  // general API key. It is confined to the MCP surface, so the agent's entire
  // capability == the tools it was granted (allowed_tools) — an enumerable list,
  // not "whatever route it can reach". Every agent action therefore rides the
  // single audited + rate-limited callTool chokepoint. (Humans use sessions; the
  // native app uses the System actor — neither has tokenScope, so neither is
  // confined.) principal_admin + per-endpoint token read-scope stay as
  // defense-in-depth behind this. tokenScope is set iff the actor came from a
  // bearer token (resolveBearerActor).
  if (actor?.tokenScope && !c.req.path.startsWith("/api/mcp") && !PUBLIC_PATHS.has(c.req.path) && !isPublicRead) {
    return c.json({ error: "token_scope", detail: "this token is an MCP agent credential, valid only on /api/mcp/*" }, 403);
  }
  return next();
});

// Which device a write came from (X-Onden-Device-Id) rides the request so the event it appends records it (db.ts).
// A missing or malformed value is simply "no device": it never refuses a request.
app.use("*", async (c, next) => {
  const device = c.req.header(DEVICE_ID_HEADER);
  return device && isUuid(device) ? withRequestDevice(device.toLowerCase(), next) : next();
});

// A page that predates block anchors may not write notes (clientGate.ts); the app tells the person to reload.
app.use("*", clientProtocolGate());

// Idempotent replay shield (offline-queue follow-up to audit #4): the
// reconnect drain marks each queued write with a client-minted UUID, so a
// replay (lost response, a second tab/device draining the same queue) is a
// no-op instead of double-applying.
//
// This middleware only VALIDATES the header (UUID shape + write-method filter)
// and makes the key ambient for the spine via withIdempotencyKey. The durable
// claim is NO LONGER made here. The previous version INSERTed the key on the
// pool (auto-committing OUTSIDE the route's transaction): if the handler then
// 5xxed, its write rolled back but the committed key made the retry short-
// circuit to {deduped:true} → silent data loss. The claim now happens via q()
// INSIDE spine mutate()'s transaction (see mutate.ts), so the key persists iff
// the write commits. A genuine replay throws IdempotentReplay there, which the
// error boundary maps to 200 {deduped:true} (httpError.ts).
app.use("*", async (c, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) return next();
  const key = c.req.header("idempotency-key");
  if (!key) return next();
  if (!isUuid(key)) {
    return c.json({ error: "bad_idempotency_key", detail: "must be a UUID" }, 400);
  }
  // A retry of an already committed key is acknowledged here, before any route state check can refuse it
  // (404 note gone, 409 already live): the device applied this write and only lost the reply. Same answer as
  // IdempotentReplay at the error boundary. Needs the authenticated actor; the key is scoped to its workspace.
  if (c.get("actor") && await isCommittedIdempotencyKey(await getWorkspaceId(), key)) {
    return c.json({ deduped: true }, 200);
  }
  return withIdempotencyKey(key, next);
});

// Lookup of the System actor (external_id='system') seeded at migration time.
// Used as the actor context for native-origin dev/test requests without a
// session — yields a real UUID that satisfies FK constraints.
//
// TTL-cached: refreshing once per minute bounds the window during which a
// change to the System actor's row goes unreflected. A module-level forever-cache would survive until restart;
// no cache would hit the DB on every request.
const NATIVE_ACTOR_TTL_MS = 60_000;
let nativeActorCache: ActorCtx | null = null;
let nativeActorCachedAt = 0;
async function getNativeActor(): Promise<ActorCtx | null> {
  if (nativeActorCache && Date.now() - nativeActorCachedAt < NATIVE_ACTOR_TTL_MS) {
    return nativeActorCache;
  }
  // This workspace's System: every workspace has its own, so an unscoped
  // lookup could hand a native request another workspace's actor.
  const res = await pool.query<{ id: string; name: string; type: ActorType }>(
    `SELECT id, name, type FROM actors WHERE workspace_id = $1 AND external_id = ${SYSTEM_EXTERNAL_ID_SQL} LIMIT 1`,
    [await getWorkspaceId()],
  );
  nativeActorCache = res.rows[0] ?? null;
  nativeActorCachedAt = Date.now();
  return nativeActorCache;
}

// ── Session helper: resolve current actor from Better Auth session ────────
async function getCurrentActor(req: Request, inviteToken: string | null = null): Promise<ActorCtx | null> {
  const session = await auth.api.getSession({ headers: req.headers });
  // An older tab may still have work for A after another tab logs in as B.
  // Compare against the authenticated user before actor lookup/creation. The
  // header can only narrow a request, never select or impersonate an actor.
  const expectedUserId = req.headers.get("X-Onden-Expected-User");
  if (expectedUserId && session?.user?.id !== expectedUserId) throw new UnauthorizedError("account_changed");
  if (!session?.user) return null;
  // Lookup, invite claim and first-login creation live with the other member
  // operations (services/actors.ts, audit D110).
  return actorForSession(session.user, await getWorkspaceId(), { inviteToken });
}

app.get("/health", async (c) => {
  await pool.query("SELECT 1");
  return c.json({ ok: true });
});

app.route("/api/bootstrap", bootstrapRouter);
app.route("/api/workspace", workspaceRouter);

app.route("/api/nodes", nodeRouter);
app.route("/api/nodes", blockLinkRouter);
app.route("/api/versions", versionsRouter);
app.route("/api/history", historyRouter);
app.route("/api/sync", syncRouter);
app.route("/api/actors", actorRouter);
app.route("/api/me", meRouter);
app.route("/api/invites", invitesRouter);
app.route("/api/spaces", spacesRouter);
app.route("/api/push", pushRouter);


// /api/role-acl routes removed — role_visible_tags was dropped by migration 003.
// The tag-policy substrate (canActorOnTag / canActorOnAllTags + collection_schemas.policy)
// replaces the old role→visible-tags ACL.

// /api/agent-sessions, /api/ai-suggestions, /api/ai and /api/mcp are mounted by the ai module (src/modules/ai).
// /api/canvases and /api/boards are mounted by the whiteboard module (modules/canvas).
// /api/pages route removed — pages are content_nodes; see /api/nodes
app.route("/api/events", eventsRouter);
app.route("/api/inbox", inboxRouter);
app.route("/api/tags", tagsRouter);
app.route("/api/export", exportRouter);
app.route("/api/backup", backupRouter);
app.route("/api/bookmark", bookmarkRouter);
app.route("/api/pointers", pointerRouter);
app.route("/api/query", queryRouter);

// GET /api/handlers/manifest and /api/edges/manifest (routes/manifests.ts),
// ahead of /api/edges.
app.route("/api", manifestsRouter);

// /api/edges (POST create + DELETE) live in routes/edges.ts — extracted so the
// node-referencing boundary handlers are mountable in the read-authz harness and
// fall under the require-read-gate lint like every other node-referencing route.
app.route("/api/edges", edgesRouter);

// /api/tasks (agenda, create, PATCH, place, unplace) and POST /api/nodes/:id/tasks
// are mounted by the tasks module (src/modules/tasks, mountModules below).

// GET /api/day/:date/lens (the day lens, routes/day.ts) is mounted by the
// daily-notes module (src/modules/daily, mountModules below).

// /api/import lives in src/modules/importers (a built-in module, mounted by mountModules below).
// /api/rss now lives in src/modules/rss (mounted by mountModules below); the
// old import-only RSS route and its rss_sources/rss_items tables were retired
// by migration 061 ([[rss-rebuild]]).

app.route("/api/media", mediaRouter);

// Modules — plugin-shaped capabilities (one directory + one registry entry
// each; see src/modules/README.md). This is the single seam: routes mount
// here, optional agent tools / dispatcher handlers register into the
// existing registries inside mountModules.
mountModules(app);
