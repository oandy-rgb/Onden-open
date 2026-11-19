// A temporary session never makes this server fetch from the network (spine/authority.ts assertMayReachOut), and every request that reaches out
// checks its authority BEFORE the fetch, for everyone (PR #1856 review round 3, point 6).
//
// The routes that make a request leave this server, from the call chains of services/safeFetch.ts (the one outbound gate for the app's own
// fetches) — `grep -rn "safeFetch\|fetchPageMeta\|fetchAndParseFeed\|fetchPageHtml" src`:
//   POST /api/bookmark/preview, POST /api/bookmark (services/pageMeta.ts), POST /api/rss/subscribe (fetchAndParseFeed),
//   POST /api/rss/items/:id/fulltext (fetchPageHtml): refused to a session before the fetch (this file);
//   POST /api/rss/opml, POST /api/rss/sources/:id/refresh: the feeds are fetched by the outbox after mutatePersonal / changeSource, which refuse a
//   session (this file: no fetch);
//   POST /api/external-calendars, PATCH /api/external-calendars/:id, POST /api/external-calendars/:id/refresh: person() and assertMayReachOut first;
//   GET /api/rss/items/:id/link (fetchPageHtml for an article not held yet, links.ts): assertMayReachOut before the fetch (round 4: it was missed);
//   the AI key and role routes (routes/aiRuntime.ts): assertMayReachOut first;
//   which routes reach out at all, for any method, is derived from the code: guards/outboundFetch.guard.test.ts;
//   the AI's tools (services/harness/scope.ts) and the AI providers (services/agentRuntime/api): /api/mcp and starting an AI refuse a session
//   (app.ts, aiSessionStart) — not reachable from here.
// The recording stand-in for safeFetch counts every call; a refused request must leave it at zero.
//
// SAFETY: only runs against a *_test database; skips otherwise. Each test makes its own workspace (shared database; tests run shuffled).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { openAs, standardWorld } from "./helpers/sessionWorld.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";
import { turnModuleOn } from "./helpers/setModulesOn.js";

registerShippedModules();
const fetched = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("../services/safeFetch.js", async (original) => {
  const real = await original<typeof import("../services/safeFetch.js")>();
  return { ...real, safeFetch: vi.fn(async (url: string) => { fetched.urls.push(String(url)); throw new real.SafeFetchError("no network in this test", "network"); }) };
});
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
let signedInAs: string | null = null;
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => (signedInAs ? { user: { id: signedInAs, name: "Person", email: `${signedInAs}@fetch.test` } } : null)) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
  configuredSocialProviders: [],
}));
const { app } = await import("../app.js");

afterAll(async () => { await pool.end(); });
beforeEach(() => { fetched.urls = []; });

async function call(path: string, who: { credential: string } | { cookie: string }, method: string, body?: unknown) {
  signedInAs = "cookie" in who ? who.cookie : null;
  try {
    const res = await app.request(path, {
      method,
      headers: { ...("credential" in who ? { authorization: `Bearer ${who.credential}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await res.arrayBuffer();
    return res.status;
  } finally { signedInAs = null; }
}

/** A world with a session on space A, a feed in space A and an article of it with an address. */
async function world(label: string) {
  const w = await standardWorld(label);
  ownWorkspace = w.ws;
  for (const module of ["rss", "external_calendars"]) await turnModuleOn(w.ws, module);
  const opened = await openAs(w.owner, w.ws, { spaces: [{ spaceId: w.spaceA, permission: "edit" }] });
  const source = (await seedQ<{ id: string }>(`INSERT INTO rss_subscriptions (workspace_id, space_id, title, url) VALUES ($1, $2, 'feed', $3) RETURNING id::text`,
    [w.ws, w.spaceA, `https://feed.test/${randomUUID()}.xml`])).rows[0]!.id;
  // two articles under one path, so the source has an article prefix (a link under it is fetched to read in place: GET /items/:id/link)
  const seedArticle = async () => (await seedQ<{ id: string }>(`INSERT INTO rss_staging (workspace_id, subscription_id, guid, title, url) VALUES ($1, $2, $3, 'article', $4) RETURNING id::text`,
    [w.ws, source, `guid-${randomUUID()}`, `https://news.test/articles/${randomUUID()}`])).rows[0]!.id;
  const article = await seedArticle();
  await seedArticle();
  // the owner's calendar, switched off (its address is never read: every request below is refused before)
  const calendar = (await seedQ<{ id: string }>(`INSERT INTO external_calendars (id, workspace_id, actor_id, name, color, url_ciphertext, url_host, enabled)
     VALUES ($1, $2, $3, 'cal', '#112233', '\\x00'::bytea, 'cal.test', false) RETURNING id::text`, [randomUUID(), w.ws, w.owner.id])).rows[0]!.id;
  return { ...w, credential: opened.credential, source, article, calendar };
}

type World = Awaited<ReturnType<typeof world>>;
const REACHING_OUT: Array<[name: string, method: string, path: (w: World) => string, body: (w: World) => unknown]> = [
  ["a bookmark's preview", "POST", () => "/api/bookmark/preview", () => ({ url: "https://example.test/page" })],
  ["a bookmark", "POST", () => "/api/bookmark", (w) => ({ url: "https://example.test/page", space_id: w.spaceA })],
  ["a feed subscription", "POST", () => "/api/rss/subscribe", () => ({ url: "https://feed.test/new.xml" })],
  ["an article's full text", "POST", (w) => `/api/rss/items/${w.article}/fulltext`, () => ({})],
  ["an OPML import", "POST", () => "/api/rss/opml", () => ({ opml: '<?xml version="1.0"?><opml version="2.0"><body><outline text="x" xmlUrl="https://feed.test/opml.xml"/></body></opml>' })],
  ["a feed's refresh", "POST", (w) => `/api/rss/sources/${w.source}/refresh`, () => ({})],
  ["an external calendar", "POST", () => "/api/external-calendars", () => ({ name: "cal", color: "#112233", url: "https://cal.test/a.ics" })],
  ["an external calendar switched back on", "PATCH", (w) => `/api/external-calendars/${w.calendar}`, () => ({ enabled: true })],
  ["an external calendar's refresh", "POST", (w) => `/api/external-calendars/${w.calendar}/refresh`, () => ({})],
  ["a link inside an article (a GET)", "GET", (w) => `/api/rss/items/${w.article}/link?url=${encodeURIComponent("https://news.test/articles/not-held-yet")}`, () => undefined],
  ["an AI key tried against its provider", "POST", () => "/api/ai/credentials/test", () => ({ api_key: "sk-test", base_url: "https://api.provider.test" })],
];

describe.skipIf(!isTestDatabase())("a temporary session makes no request leave this server", () => {
  it.each(REACHING_OUT)("%s: refused to the session (401/403) before anything is fetched", async (_name, method, path, body) => {
    const w = await world(`noFetch${_name.replace(/\W/g, "")}`);
    const status = await call(path(w), { credential: w.credential }, method, body(w));
    expect([401, 403]).toContain(status);
    expect(fetched.urls, "the session's request made the server fetch").toEqual([]);
  });

  it("control: the person's own bookmark preview does fetch (the stand-in records it), so a zero above is a refusal, not a missing fetch", async () => {
    const w = await world("noFetchControl");
    await call("/api/bookmark/preview", { cookie: w.owner.ext }, "POST", { url: "https://example.test/page" });
    expect(fetched.urls).toEqual(["https://example.test/page"]);
  });

  it("the order, for everyone: a person who may not write in the space asks for a bookmark there, and nothing is fetched", async () => {
    const w = await world("noFetchOrder");
    // the member is not in space B
    expect(await call("/api/bookmark", { cookie: w.member.ext }, "POST", { url: "https://example.test/page", space_id: w.spaceB })).toBe(403);
    expect(fetched.urls, "bookmark").toEqual([]);
    // (a feed has no such case for a person: a source space they may not write is not used, the feed goes to their own space —
    // modules/rss/sourceSpace.ts sourceSpaceFor — so only a session is refused before the feed is fetched, by own_personal: above)
  });

  it("control: the person's article link fetches (the GET reaches out; the session's is refused above)", async () => {
    const w = await world("noFetchLinkControl");
    await call(`/api/rss/items/${w.article}/link?url=${encodeURIComponent("https://news.test/articles/not-held-yet")}`, { cookie: w.owner.ext }, "GET");
    expect(fetched.urls).toEqual(["https://news.test/articles/not-held-yet"]);
  });
});
