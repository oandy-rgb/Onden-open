// Write-route sweep with VALID requests — can the owner of an unrelated workspace change anything of workspace A?
//
// crossWorkspaceReadSweep sends one generic body to every write route; many answer 400 at body validation, before
// the code that looks the object up and judges access ever runs. Here every mounted write route has a request that
// passes its own validation (helpers/sweepWriteBodies.ts: the table is complete or this file fails), so the answer
// really comes from the lookup/permission code. Three passes per route, all through the assembled Hono app:
//
//   positive  workspace D's owner, D's own objects → 2xx (proves the request is valid, not just refused)
//   cross     workspace C's owner, path and body all A's objects → no 5xx, not 2xx, nothing of A in the answer,
//             A's rows unchanged, nothing of C points at A
//   mixed     C's owner, path C's own but every object the body points at is A's (move my note under A's note, apply
//             A's tag to my note, link to A's note …) → the same assertions
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { q } from "../db.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import { getRestoreJob } from "../services/backupRestoreJobs.js";
import { freshWorkspace } from "./helpers/roundTripWorld.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { workspaceSwitch } from "./helpers/workspaceSwitch.js";
import { mountedRoutes, type MountedRoute } from "./helpers/appRoutes.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { snapshot, diffSnapshots, tablesMentioning } from "./helpers/workspaceSnapshot.js";
import { SWEEP_SECRET_KEY, buildSweepObjects, fieldsUsed, needlesOf, type SweepObjects, type SweepSide } from "./helpers/sweepWriteWorld.js";
import { startFakeMessagesService } from "./helpers/fakeMessagesService.js";
import { WRITE_CONTENT, NETWORK_502, NO_POSITIVE, NO_CONTENT_YET, type SweepRequest } from "./helpers/sweepWriteBodies.js";

registerShippedModules();

let sessionExternalId: string | null = null;
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: {
      getSession: vi.fn(async () =>
        sessionExternalId ? { user: { id: sessionExternalId, name: "Sweep", email: `${sessionExternalId}@sweep.test` } } : null),
    },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));
vi.mock("../db.js", async (original) => {
  const { workspaceSwitch } = await import("./helpers/workspaceSwitch.js");
  return { ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceSwitch.ws };
});
vi.mock("../services/workspaceId.js", async (original) => {
  const { workspaceSwitch } = await import("./helpers/workspaceSwitch.js");
  return { ...await original<typeof import("../services/workspaceId.js")>(), getWorkspaceId: async () => workspaceSwitch.ws };
});

const { app } = await import("../app.js");
const enabled = isTestDatabase();
const STAMP = `${Date.now()}`;

// /api/auth/* is better-auth's own (mocked here); the event stream is SSE.
const SKIP = (path: string) => path.startsWith("/api/auth");
const keyOf = (r: MountedRoute) => `${r.method} ${r.path}`;

async function sideOf(label: string): Promise<SweepSide> {
  const w = await freshWorkspace(label);
  await setModulesOn(w.ws, null);
  const ext = `sweepw-${label}-${STAMP}`;
  await q(`UPDATE actors SET external_id = $2 WHERE id = $1`, [w.actor.id, ext]);
  return { ws: w.ws, owner: w.actor, ownerExternalId: ext };
}

function fillPath(route: string, params: Record<string, string> = {}): string {
  return route.replace(/:([A-Za-z_]+)(?:\{[^}]*\})?/g, (_m, name: string) => {
    const v = params[name];
    if (v === undefined) throw new Error(`no value for :${name} in ${route}`);
    return encodeURIComponent(v);
  });
}

async function send(who: SweepSide, method: string, route: string, req: SweepRequest): Promise<{ res: Response; path: string }> {
  // A publish names the preview it publishes (modules/website/routes.ts refuses one without the hash): ask for that
  // preview first, as the same caller with the same body, the way the app does.
  if (method === "POST" && route === "/api/publish" && req.json && typeof req.json === "object" && !("preview_hash" in req.json)) {
    const preview = await send(who, "POST", "/api/publish/preview", { json: req.json });
    const hash = preview.res.ok ? ((await preview.res.json()) as { hash?: string }).hash : undefined;
    if (hash) req = { ...req, json: { ...req.json, preview_hash: hash } };
  }
  workspaceSwitch.ws = who.ws;
  sessionExternalId = who.ownerExternalId;
  const qs = req.query ? `?${new URLSearchParams(req.query).toString()}` : "";
  const path = fillPath(route, req.params) + qs;
  const headers: Record<string, string> = { ...req.headers };
  let body: BodyInit | undefined;
  if (req.raw) { headers["content-type"] = req.raw.contentType; body = req.raw.bytes as unknown as BodyInit; }
  else if (req.json !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(req.json); }
  try {
    const res = await Promise.race([
      app.request(path, { method, headers, body }),
      new Promise<Response>((_, reject) => setTimeout(() => reject(new Error(`${method} ${path} did not answer within 15s`)), 15_000)),
    ]);
    return { res, path };
  } finally {
    sessionExternalId = null;
  }
}

/** The answer as text; for an error, with what the request itself said removed (a 404 repeating the id asked about
 *  leaks nothing). A 2xx is scrubbed only of what the request body carried. */
async function answerOf(res: Response, echoed: string[]): Promise<string> {
  let text = Buffer.from(await res.arrayBuffer()).toString("latin1");
  for (const e of echoed) text = text.split(e).join("");
  return text;
}

/** Routes that may answer 2xx to C's owner in the cross / mixed passes, and why that is not a way in. Each one still
 *  has A's rows compared before and after, and C's rows checked for references to A. */
// ratchet:list sweepWrite2xxOk
const OK_2XX: Array<{ route: string; reason: string }> = [
  { route: "DELETE /api/canvases/:id", reason: "deleting a canvas that does not exist in the caller's workspace is a no-op (A's canvas is untouched: the A snapshot is unchanged)" },
  { route: "POST /api/canvases", reason: "creates a canvas in the caller's own workspace; the request names nothing of A" },
  { route: "POST /api/spaces", reason: "creates a space in the caller's own workspace; the request names nothing of A" },
  { route: "POST /api/tags/resolve-path", reason: "creates a tag path in the caller's own workspace; the request names nothing of A" },
  { route: "POST /api/capture/inbox", reason: "makes the caller's own inbox tag; the request names nothing" },
  { route: "PUT /api/me/prefs/:key", reason: "the caller's own preference; the request names nothing of A" },
  { route: "POST /api/query", reason: "a read: answers only what the caller may read, and A's tag matches nothing in C (no A text in the answer is asserted below)" },
  { route: "POST /api/sync", reason: "a read: ids A names are not C's, the answer holds none of A's data (asserted below)" },
  { route: "POST /api/sync/bodies", reason: "a read: same as /api/sync" },
  { route: "POST /api/sync/drawings", reason: "a read: same as /api/sync" },
  { route: "POST /api/sync/nodes", reason: "a read: same as /api/sync" },
  { route: "PATCH /api/workspace/config", reason: "the caller's own workspace settings; the request names nothing of A" },
  { route: "PATCH /api/workspace/modules", reason: "switches a module in the caller's own workspace; names nothing of A" },
  { route: "PATCH /api/workspace/time", reason: "the caller's own calendar clock; names nothing of A" },
  { route: "POST /api/actors", reason: "creates an agent in the caller's own workspace; the request names nothing of A" },
  { route: "DELETE /api/actors/:id", reason: "removing a person who is not in the caller's workspace is a no-op (services/actors.removeActor: absent -> ok); A's member is untouched (snapshot unchanged)" },
  { route: "POST /api/invites/claim", reason: "answers the caller's own identity; reads and writes nothing" },
  { route: "POST /api/media", reason: "stores a file in the caller's own workspace; the request names nothing of A" },
  { route: "POST /api/history/deleted/purge", reason: "answers 200 with one result per item; the item naming A's note is a refusal inside it (purgeDeletedEach), and A's rows are unchanged (snapshot)" },
  { route: "POST /api/ai/credentials", reason: "keeps an API key for the caller's own workspace; the request names nothing of A" },
  { route: "POST /api/ai/credentials/test", reason: "asks the posted key's own service and saves nothing; the request names nothing of A" },
  { route: "POST /api/history/rewind", reason: "answers 200 with a skipped (stale/unwritable) entry for each id the caller cannot reach (services/history/rewind.ts); A's rows are unchanged (snapshot)" },
  { route: "POST /api/bookmark/preview", reason: "answers a preview of the posted URL; the request names nothing of A" },
  { route: "POST /api/bookmark", reason: "saves a bookmark note in the caller's own workspace; the request names nothing of A" },
  { route: "POST /api/backup/restore/upload", reason: "stages the posted zip for the caller's own later restore (the upload is keyed by the caller); the request names nothing of A" },
  { route: "POST /api/external-calendars", reason: "adds a subscription of the caller's own (calendars belong to the person); the request names nothing of A" },
  { route: "POST /api/import/obsidian", reason: "creates notes in the caller's own workspace from the posted files; the request names nothing of A" },
  { route: "POST /api/tags/import", reason: "installs a tag pack in the caller's own workspace; the request names nothing of A" },
  { route: "POST /api/rss/opml", reason: "adds feeds to the caller's own workspace; the request names nothing of A" },
  { route: "POST /api/preview", reason: "the caller's own workspace's preview event; the request names nothing" },
  { route: "POST /api/publish/preview", reason: "previews the caller's OWN site: a home_node_id that is not one of the caller's published pages is ignored (publishing/siteHome.ts), and nothing of A is in the answer (asserted below)" },
  { route: "POST /api/publish", reason: "publishes the caller's OWN site: a home_node_id that is not one of the caller's published pages is ignored (publishing/siteHome.ts); nothing of A is in the answer or stored" },
  { route: "POST /api/publish/include", reason: "answers 200 with a refusal per note in `failed` (the write is the note's own attribute write, which A's note refuses); A's rows are unchanged (snapshot)" },
  { route: "POST /api/inbox/batch", reason: "answers 200 with one result per event; an id that is not an unreviewed agent event of the caller's workspace is `skipped` (eventReview.ts not_found), and A's rows are unchanged (snapshot)" },
  { route: "POST /api/inbox/failed-effects/kinds/:kind/:action{retry|dismiss}", reason: "acts on the caller's OWN workspace's failed deliveries of that kind (none: 0 requeued / 0 dismissed); a kind is a category, not an object of A; A's failed delivery is unchanged (snapshot)" },
  { route: "POST /api/history/rewinds/:rewindId/undo", reason: "mixed only: the caller's own rewind, a node id of A's that is not in it is `skipped` (history/rewind.ts undoRewind); C's rows are checked for A's ids and A's rows are unchanged (snapshot)" },
  { route: "POST /api/history/agent-runs/:runId/undo", reason: "mixed only: the caller's own run, a node id of A's that is not in it is `skipped` (history/agentRunUndo.ts); A's rows are unchanged (snapshot)" },
  { route: "POST /api/history/agent-runs/:runId/redo", reason: "mixed only: as the undo of an agent run: a node of A's that is not in the caller's run is `skipped`" },
  { route: "PATCH /api/boards/:id", reason: "mixed only: cards whose note the caller cannot read are dropped (boardWrites.applyBoardChanges), 200 for the rest; C's rows are checked for A's ids" },
];
/** A refused agent tool call is logged in the CALLER's workspace with the id it asked for (an audit trail of the
 *  caller's own request, not a reference that reads or changes A). */
const EXCEPT_DIAGNOSTICS = { domain_events: "t.event_type = 'AGENT_TOOL_FAILED'" };
const ANSWERS_2XX: Record<string, string> = Object.fromEntries(OK_2XX.map((e) => [e.route, e.reason]));

const asList = <T,>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);
const isId = (s: string) => /^[0-9a-f-]{36}$/.test(s);

describe.skipIf(!enabled)("cross-workspace write sweep with valid requests (real app, DB)", { timeout: 240_000 }, () => {
  let writes: MountedRoute[] = [];
  let A: SweepSide; let C: SweepSide; let D: SweepSide;
  let aObjects: SweepObjects;
  let aNeedles: string[];

  let aiService: Awaited<ReturnType<typeof startFakeMessagesService>> | undefined;
  beforeAll(async () => {
    process.env.ONDEN_SECRET_KEY = SWEEP_SECRET_KEY; // the AI key routes refuse without it
    aiService = await startFakeMessagesService(); // "test this key" and "set up an AI" ask the key's service for its models
    process.env.ONDEN_AI_BASE_URL_OVERRIDE = aiService.url;
    [A, C, D] = [await sideOf("swA"), await sideOf("swC"), await sideOf("swD")];
    aObjects = await buildSweepObjects(A, "A");
    aNeedles = needlesOf(aObjects);
    writes = mountedRoutes(app, (m) => ["POST", "PUT", "PATCH", "DELETE"].includes(m)).filter((r) => !SKIP(r.path));
  }, 120_000);

  afterAll(async () => {
    workspaceSwitch.ws = ""; delete process.env.ONDEN_SECRET_KEY; delete process.env.ONDEN_AI_BASE_URL_OVERRIDE;
    await aiService?.close();
  });

  it("every mounted write route has a request, and no request is left without a route", () => {
    const mounted = new Set(writes.map(keyOf));
    const missing = [...mounted].filter((k) => !(k in WRITE_CONTENT) && !NO_CONTENT_YET.includes(k));
    const dead = [...Object.keys(WRITE_CONTENT), ...NO_CONTENT_YET, ...NO_POSITIVE.map((e) => e.route), ...NETWORK_502.map((e) => e.route)].filter((k) => !mounted.has(k));
    const both = NO_CONTENT_YET.filter((k) => k in WRITE_CONTENT);
    expect(missing, `write routes without a request in sweepWriteBodies.ts:\n${missing.join("\n")}`).toEqual([]);
    expect(dead, `entries that match no mounted route:\n${dead.join("\n")}`).toEqual([]);
    expect(both, `routes listed as both having a request and not having one:\n${both.join("\n")}`).toEqual([]);
  });

  it("positive: each request, aimed at the caller's own objects, is accepted (2xx)", async () => {
    const failures: string[] = [];
    // The owner transfer goes last: after it D's caller is no longer the owner.
    for (const r of [...writes].sort((a, b) => Number(keyOf(a).includes("owner-transfer")) - Number(keyOf(b).includes("owner-transfer")))) {
      const content = WRITE_CONTENT[keyOf(r)];
      if (!content || NO_POSITIVE.some((e) => e.route === keyOf(r))) continue;
      const own = await buildSweepObjects(D, "D", fieldsUsed(content));
      for (const req of asList(content(own, own))) {
        const { res, path } = await send(D, r.method, r.path, req);
        if (res.status < 200 || res.status >= 300) failures.push(`${keyOf(r)} -> ${res.status} ${(await res.text()).slice(0, 200)} (${path})`);
        else if (res.status === 202) await waitForRestoreJob(D, await res.json() as { job?: { id: string } });
        await awaitAllDispatchers();
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  /** A restore runs as a job after the request has answered 202; it must end before the sweep moves to another workspace. */
  async function waitForRestoreJob(who: SweepSide, answer: { job?: { id: string } }): Promise<void> {
    if (!answer.job) return;
    for (let waited = 0; waited < 60_000; waited += 50) {
      const job = await getRestoreJob(who.owner.id, answer.job.id);
      if (!job || job.status !== "running") return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("the restore job did not finish within 60s");
  }

  /** Aim `req(own, ref)` as C's owner and check the invariants. `ownFor` builds the path's objects. */
  async function attack(mode: "cross" | "mixed"): Promise<string[]> {
    const failures: string[] = [];
    const before = await snapshot(A.ws);
    const aIds = aNeedles.filter((n) => isId(n) && n !== A.ws);
    // What an earlier test of this file left in C is not this pass's doing (the tests run in shuffled order).
    const alreadyPointing = new Set(await tablesMentioning(C.ws, aIds, EXCEPT_DIAGNOSTICS));
    for (const r of writes) {
      const content = WRITE_CONTENT[keyOf(r)];
      if (!content) continue;
      const own = mode === "cross" ? aObjects : await buildSweepObjects(C, "C", fieldsUsed(content));
      for (const req of asList(content(own, aObjects))) {
      const { res, path } = await send(C, r.method, r.path, req);
      const echoed = [...aNeedles.filter((n) => path.includes(n) || JSON.stringify(req.json ?? "").includes(n))];
      const text = await answerOf(res, echoed);
      const k = keyOf(r) + (req.params?.toolName ? ` [${req.params.toolName}]` : "");
      if (res.status >= 500 && !(res.status === 502 && NETWORK_502.some((e) => e.route === keyOf(r)))) failures.push(`${k}: ${res.status} ${text.slice(0, 160)}`);
      // In the mixed pass most routes legitimately act on the caller's OWN objects; only a request that names one of
      // A's ids and still succeeds is suspect.
      const namesA = aIds.some((id) => JSON.stringify(req).includes(id));
      if (res.status >= 200 && res.status < 300 && (mode === "cross" || namesA) && !(keyOf(r) in ANSWERS_2XX)) {
        failures.push(`${k}: C's owner got ${res.status} for a ${mode} request ${JSON.stringify(req).slice(0, 200)}`);
      }
      const hit = aNeedles.filter((n) => text.includes(n));
      if (hit.length) failures.push(`${k}: answer holds A's ${hit.slice(0, 3).join(", ")}`);
      await awaitAllDispatchers();
      const changed = diffSnapshots(before, await snapshot(A.ws));
      if (changed.length) {
        failures.push(`${k}: ${mode} request changed A's ${changed.join(", ")} (status ${res.status})`);
        before.clear(); for (const [t, v] of await snapshot(A.ws)) before.set(t, v);
      }
      // Only what THIS request added: a table that already pointed at A before it is reported once, at its first request.
      const pointing = (await tablesMentioning(C.ws, aIds, EXCEPT_DIAGNOSTICS)).filter((t) => !alreadyPointing.has(t));
      for (const t of pointing) alreadyPointing.add(t);
      if (pointing.length) failures.push(`${k}: after the ${mode} request C's rows in ${pointing.join(", ")} reference A's objects`);
      }
    }
    return failures;
  }

  it("cross: C's owner, every id A's → refused, nothing of A changes or leaks", async () => {
    const failures = await attack("cross");
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("mixed: C's own path, body pointing at A's objects → refused, nothing of A changes or leaks", async () => {
    const failures = await attack("mixed");
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("routes without a request yet: the generic body at A's ids does not 5xx or change A", async () => {
    const failures: string[] = [];
    const before = await snapshot(A.ws);
    for (const k of NO_CONTENT_YET) {
      const [method, route] = k.split(" ") as [string, string];
      const params: Record<string, string> = {};
      for (const m of route.matchAll(/:([A-Za-z_]+)/g)) params[m[1]!] = m[1] === "key" ? aObjects.attrKey : randomUUID();
      const { res, path } = await send(C, method, route, { params, json: { name: "x", title: "x", node_id: aObjects.note, tag_id: aObjects.tag } });
      if (res.status >= 500) failures.push(`${k}: ${res.status} (${path})`);
      await awaitAllDispatchers();
      if (diffSnapshots(before, await snapshot(A.ws)).length) failures.push(`${k}: changed A`);
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
