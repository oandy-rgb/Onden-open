// @vitest-environment jsdom
//
// Property test: the client's local mirror equals the server, under random
// server histories.
//
// WHAT RUNS. The server side is the real assembled app (index.ts) on a
// `*_test` database, called through its routes: a workspace of its own with an
// owner, a member and four spaces (helpers/mirrorWorld.ts). The client side is
// the REAL frontend code: lib/data/syncEngine (boot, refresh, sync, the
// membership reconcile, the drawing download), lib/api, bootstrapWire's
// decoder, lib/localDb with the real worker (localDbWorker, localDbPersist,
// localMirror) on a real sql.js database in Node, and lib/data/storeOps'
// applySyncDelta on the in-memory store. Only the transport is replaced: the
// worker's postMessage runs in-process, fetch goes to app.request() (with a
// header naming the actor), IndexedDB keeps nothing, and one hold lets a
// bootstrap download finish late.
//
// WHY THIS LAYER. Frontend tests alone would need a hand-written server; a
// backend test alone would not run the mirror. This file lives with the
// backend because only it has the shared test database and the app. Importing
// the frontend needs `slug` and `snippet` aliases in vitest.config.ts and
// jsdom (the engine touches navigator / window).
//
// EACH RUN is one fresh workspace and one fresh client: a setup of server ops,
// a cold boot, then random steps - server ops and client actions (delta sync,
// full bootstrap, slim bootstrap, a bootstrap that lands late after newer
// deltas, resync_required, the drawing download, a >500-event burst so one
// catch-up needs several delta pages). After every client action the mirror
// and the store are compared with what a fresh full bootstrap gives the same
// actor (checkMirror), and the event cursor must not move back.
//
// Run count and seed: PROPS_RUNS (default 8 here: a run takes seconds) and
// PROPS_SEED, as in the other property tests. A failure prints the seed and
// fast-check's shrunk sequence; replay with
//   PROPS_SEED=<seed> PROPS_RUNS=<runs> npx vitest run src/test/properties/mirror.property.test.ts
//
// Problems found by this test are pinned at the bottom, each with the shortest
// sequence and a comment (see Findings); the open one is an `it.fails`.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PROPS_SEED } from "../helpers/propsConfig.js";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { ATTRIBUTE_KEYS, DEFERRED_KEYS, type ServerOp, type World, type Who } from "../helpers/mirrorWorld.js";

// ── Wiring ───────────────────────────────────────────────────────────────────

const frontend = (path: string): string =>
  pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../frontend/src", path)).href;

const h = vi.hoisted(() => ({
  workspaceId: "",
  actor: "",
  slimThreshold: 2000,
  forceResync: false,
  hold: null as null | { started: () => void; gate: Promise<void> },
  failures: [] as string[],
  requests: [] as string[],
  app: null as null | { request(path: string, init?: RequestInit): Response | Promise<Response> },
}));

/** The backend, loaded afresh: the frontend needs a clean module registry for every run
 *  (vi.resetModules), and a reset takes the backend with it. Mixing old and new copies of a backend
 *  module (one lazily imported after the reset) would split db.ts's transaction context and the
 *  dispatcher queue in two, so the whole backend and the world helper are loaded together, per run. */
async function loadBackend() {
  vi.resetModules();
  const { app } = await import("../../app.js");
  const { createWorld } = await import("../helpers/mirrorWorld.js");
  h.app = app;
  return { createWorld };
}

vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => h.workspaceId }));
// Better Auth: the session is the actor a request names in x-test-actor.
vi.mock("../../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async ({ headers }: { headers: Headers }) => {
      const id = headers.get("x-test-actor");
      return id ? { user: { id, email: `${id}@mirror.test`, name: id }, session: { id } } : null;
    }) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));
vi.mock("../../../../frontend/src/lib/indexedDbStorage", () => ({
  // No snapshot survives a run: a save still pending from the previous run's worker
  // must not become the next run's starting copy (another account's).
  idbLoad: async () => null,
  idbSave: async () => {},
  idbIsStale: async () => false,
  idbAdoptLegacy: async () => null,
}));
vi.mock("sql.js", async (original) => { const real = await original<typeof import("sql.js")>(); return { default: () => real.default() }; });
// The slim bootstrap is what refresh() asks for at SLIM_MODE_NODE_THRESHOLD
// notes; a live getter lets one action ask for it with a handful of notes.
vi.mock("../../../../frontend/src/lib/slimMode", async (original) => {
  const real = await original<Record<string, unknown>>();
  return { ...real, get SLIM_MODE_NODE_THRESHOLD() { return h.slimThreshold; } };
});

const isTestDb = isTestDatabase();

type AppState = { data: Bootstrap; online: boolean; membershipGated: boolean };
type Bootstrap = {
  bodies?: string;
  workspace: { name: string; slug: string; home_node_id: string | null };
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  attributes?: Array<Record<string, unknown>>;
  tags?: Array<Record<string, unknown>>;
  canvas_memberships?: Array<{ canvas_id: string; canvas_title: string; node_id: string }>;
  last_event_id?: string;
};
type Engine = {
  boot(): Promise<unknown>;
  refresh(): Promise<void>;
  sync(): Promise<{ ok: boolean; unreachable?: boolean }>;
  downloadDrawingsForOffline(options?: { force?: boolean }): Promise<unknown>;
};
type Client = {
  engine: Engine;
  state: () => AppState;
  exportMirror: () => Promise<Blob>;
  cursor: () => Promise<number>;
  localDb: { removeNode(id: string): Promise<void> };
};

/** A fresh copy of every frontend module over an empty mirror, acting as `who`. */
async function startClient(who: Who, world: World): Promise<Client> {
  h.actor = who === "owner" ? world.owner.externalId : world.member.externalId;
  h.workspaceId = world.workspaceId;
  h.slimThreshold = 2000;
  h.forceResync = false;
  h.hold = null;
  h.failures = [];
  h.requests = [];

  // The worker module talks through `self`; a Worker is the other end of it.
  // (`location`: the bundler's worker URL is resolved against self.location.)
  const scope: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void; location: Location } =
    { onmessage: null, postMessage: () => {}, location: window.location };
  vi.stubGlobal("self", scope);
  await import(/* @vite-ignore */ frontend("lib/localDbWorker.ts"));
  class FakeWorker {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor() { scope.postMessage = (m) => { this.onmessage?.({ data: m }); }; }
    postMessage(request: unknown) { scope.onmessage?.({ data: request }); }
    terminate() {}
  }
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("requestIdleCallback", (cb: () => void) => setTimeout(cb, 0));

  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/, "");
    const headers = new Headers(init?.headers);
    headers.set("origin", "http://localhost");
    headers.set("x-test-actor", h.actor);
    let body = init?.body;
    if (h.forceResync && path === "/api/sync" && init?.method === "POST") {
      // Real clients never send `known`; a held set past the server's cap is what makes it answer resync_required.
      h.forceResync = false;
      body = JSON.stringify({ ...JSON.parse(String(body)), known: Array.from({ length: 50_001 }, () => randomUUID()) });
    }
    h.requests.push(`${init?.method ?? "GET"} ${path}`);
    const response = await h.app!.request(path, { method: init?.method ?? "GET", headers, body: body as BodyInit | undefined });
    if (response.status >= 400) h.failures.push(`${init?.method ?? "GET"} ${path} -> ${response.status} ${(await response.clone().text()).slice(0, 200)}`);
    // The answer is computed now (the server's state at this moment) and handed over when the hold opens.
    if (h.hold && path.split("?")[0] === "/api/bootstrap" && !path.includes("nodes=none")) { h.hold.started(); await h.hold.gate; }
    return response;
  });

  // The page's account: it scopes the local copy and rides on every request (X-Onden-Expected-User).
  const account = await import(/* @vite-ignore */ frontend("lib/accountStorage.ts")) as { bindAccountStorage: (userId: string, serverUrl: string) => boolean };
  account.bindAccountStorage(h.actor, "");
  const engine = await import(/* @vite-ignore */ frontend("lib/data/syncEngine.ts")) as Engine;
  const store = await import(/* @vite-ignore */ frontend("lib/appStore.ts")) as { getAppState: () => AppState };
  const localDb = await import(/* @vite-ignore */ frontend("lib/localDb.ts")) as { exportDatabase: () => Promise<Blob>; getLastEventId: () => Promise<number>; removeNode: (id: string) => Promise<void> };
  return { engine, state: store.getAppState, exportMirror: localDb.exportDatabase, cursor: localDb.getLastEventId, localDb };
}

// ── The mirror, read back as the server's projection ─────────────────────────

type Rows = Array<Record<string, unknown>>;
type MirrorRows = Record<"nodes" | "edges" | "tasks" | "attributes" | "memberships" | "fts" | "positions", Rows> & { tags: Rows; workspace: Record<string, unknown> | null; membershipEpoch: number | null };

async function readMirror(client: Client): Promise<MirrorRows> {
  const initSqlJs = (await import("sql.js")).default as unknown as () => Promise<{ Database: new (data: Uint8Array) => { exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>; close(): void } }>;
  const SQL = await initSqlJs();
  const db = new SQL.Database(new Uint8Array(await (await client.exportMirror()).arrayBuffer()));
  const all = (sql: string): Rows => {
    try {
      const [result] = db.exec(sql);
      return (result?.values ?? []).map((row) => Object.fromEntries(result!.columns.map((c, i) => [c, row[i]])));
    } catch (e) { if (process.env.MIRROR_DEBUG) console.log('readMirror', sql, e); return []; }
  };
  try {
    const state = (key: string) => all(`SELECT value FROM sync_state WHERE key = '${key}'`)[0]?.value as string | undefined;
    return {
      nodes: all("SELECT * FROM nodes"),
      edges: all("SELECT * FROM edges"),
      tasks: all("SELECT * FROM tasks"),
      attributes: all("SELECT * FROM node_attributes"),
      memberships: all("SELECT * FROM canvas_memberships"),
      fts: all("SELECT id FROM nodes_fts"),
      positions: all("SELECT node_id FROM graph_positions"),
      tags: JSON.parse(state("tags_json") ?? "[]") as Rows,
      workspace: all("SELECT * FROM workspace")[0] ?? null,
      membershipEpoch: state("membership_epoch") === undefined ? null : Number(state("membership_epoch")),
    };
  } finally { db.close(); }
}

const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));
const jsonOf = (v: unknown): string => (v === null || v === undefined || v === "" ? "null" : canon(typeof v === "string" ? JSON.parse(v) : v));
const ids = (v: unknown): string => canon([...(typeof v === "string" ? JSON.parse(v) as string[] : (v as string[] | null | undefined) ?? [])].sort());

/** One note as both sides describe it; a body the device has not downloaded is "" with a body_len. */
function noteView(n: Record<string, unknown>) {
  const markdown = String(n.markdown ?? "");
  return {
    title: n.title, slug: n.slug, node_type: n.node_type, source_type: n.source_type,
    parent_id: n.parent_id ?? null, hidden: Boolean(n.hidden), order_key: String(n.order_key ?? ""), order_stamp: String(n.order_stamp ?? ""), space_id: n.space_id ?? null,
    class_tag_ids: ids(n.class_tag_ids), label_tag_ids: ids(n.label_tag_ids),
    presentation: jsonOf(n.presentation), tag_schema: jsonOf(n.tag_schema), updated_at: n.updated_at ?? null,
    markdown, body_len: n.body_len === undefined || n.body_len === null ? null : Number(n.body_len),
  };
}
type NoteView = ReturnType<typeof noteView>;

function diffNotes(side: string, expected: Map<string, Record<string, unknown>>, actual: Map<string, Record<string, unknown>>, out: string[]): void {
  for (const [id, n] of expected) if (!actual.has(id)) out.push(`${side}: missing note "${n.title}" the actor can read`);
  for (const [id, n] of actual) if (!expected.has(id)) out.push(`${side}: holds note "${n.title}" the actor cannot read (or that is gone)`);
  for (const [id, e] of expected) {
    const a = actual.get(id);
    if (!a) continue;
    const [ev, av] = [noteView(e), noteView(a)];
    for (const key of Object.keys(ev) as Array<keyof NoteView>) {
      if (key === "markdown" || key === "body_len") continue;
      if (ev[key] !== av[key]) out.push(`${side}: note "${ev.title}" ${key}: server ${String(ev[key])} / here ${String(av[key])}`);
    }
    // Body: what is here is the server's, or nothing yet (with the length the server has).
    if (av.markdown !== "" && av.markdown !== ev.markdown) out.push(`${side}: note "${ev.title}" holds an out-of-date body`);
    if (av.markdown === "" && ev.markdown !== "" && av.body_len !== ev.markdown.length) out.push(`${side}: note "${ev.title}" has no body and body_len ${String(av.body_len)}, server body is ${ev.markdown.length} long`);
    if (av.markdown !== "" && av.body_len !== null && av.body_len !== ev.markdown.length) out.push(`${side}: note "${ev.title}" body_len ${String(av.body_len)} but the body is ${ev.markdown.length} long`);
  }
}

const attrKey = (a: Record<string, unknown>) => `${String(a.node_id)}\u0000${String(a.key)}`;
const attrView = (a: Record<string, unknown>) => canon([a.value, a.value_type ?? "text", Boolean(a.is_inheritable), a.source ?? "ui"]);
const taskView = (t: Record<string, unknown>) => canon([t.node_id, t.title, t.status, t.due_date ?? null, t.recur ?? null]);
const edgeView = (e: Record<string, unknown>) => canon([e.source_node_id, e.target_node_id, e.edge_type, e.status, e.origin ?? null]);
const tagView = (t: Record<string, unknown>) => canon([t.name, t.parent_id ?? null, t.color ?? null, t.schema_id ?? null, t.reserved_key ?? null, Boolean(t.hidden)]);

function diffById(what: string, expected: Map<string, string>, actual: Map<string, string>, out: string[], label: (id: string) => string = (id) => id): void {
  for (const [id, v] of expected) {
    if (!actual.has(id)) out.push(`mirror: missing ${what} ${label(id)}`);
    else if (actual.get(id) !== v) out.push(`mirror: ${what} ${label(id)} differs: server ${v} / here ${actual.get(id)}`);
  }
  for (const id of actual.keys()) if (!expected.has(id)) out.push(`mirror: holds ${what} ${label(id)} the server no longer has for this actor`);
}

const keyed = <T extends Record<string, unknown>>(rows: T[], key: (r: T) => string, view: (r: T) => string) => new Map(rows.map((r) => [key(r), view(r)]));

/** Differences between the client (mirror and store) and a fresh full bootstrap for the same actor; [] = equal.
 *  `taskAttributes`: also compare the attributes of task nodes. A bootstrap ships none of them (its attribute
 *  list covers the notes only), while a grant's projection does - finding 2 - so by default the
 *  mirror's copies of them are not held against it. */
export async function projectionDiff(world: World, client: Client, { taskAttributes = false } = {}): Promise<string[]> {
  const out: string[] = [];
  const res = await world.request(client.state === undefined ? "owner" : h.actor === world.owner.externalId ? "owner" : "member", "GET", "/api/bootstrap");
  if (res.status !== 200) return [`reference bootstrap failed: ${res.status}`];
  const server = res.body as Bootstrap;
  const mirror = await readMirror(client);
  const store = client.state().data;
  const serverNotes = new Map(server.nodes.map((n) => [String(n.id), n]));
  const title = (id: string) => String(serverNotes.get(id)?.title ?? id.slice(0, 8));

  diffNotes("mirror", serverNotes, new Map(mirror.nodes.map((n) => [String(n.id), n])), out);
  diffNotes("store", serverNotes, new Map(store.nodes.map((n) => [String(n.id), n])), out);

  diffById("edge", keyed(server.edges, (e) => String(e.id), edgeView), keyed(mirror.edges, (e) => String(e.id), edgeView), out);
  diffById("edge (store)", keyed(server.edges, (e) => String(e.id), edgeView), keyed(store.edges, (e) => String(e.id), edgeView), out);
  diffById("task", keyed(server.tasks, (t) => String(t.id), taskView), keyed(mirror.tasks, (t) => String(t.id), taskView), out);
  diffById("task (store)", keyed(server.tasks, (t) => String(t.id), taskView), keyed(store.tasks, (t) => String(t.id), taskView), out);
  diffById("canvas membership", keyed(server.canvas_memberships ?? [], (m) => `${m.canvas_id} ${m.node_id}`, (m) => m.canvas_title),
    keyed(mirror.memberships, (m) => `${m.canvas_id} ${m.node_id}`, (m) => String(m.canvas_title)), out);
  diffById("canvas membership (store)", keyed(server.canvas_memberships ?? [], (m) => `${m.canvas_id} ${m.node_id}`, (m) => m.canvas_title),
    keyed(store.canvas_memberships ?? [], (m) => `${m.canvas_id} ${m.node_id}`, (m) => m.canvas_title), out);
  diffById("tag", keyed(server.tags ?? [], (t) => String(t.id), tagView), keyed(mirror.tags, (t) => String(t.id), tagView), out, title);
  diffById("tag (store)", keyed(server.tags ?? [], (t) => String(t.id), tagView), keyed(store.tags ?? [], (t) => String(t.id), tagView), out, title);

  // Attributes: every key the lean bootstrap carries must match; the keys it leaves out
  // (drawings) are only ever copied in later, so a copy may be missing but not wrong or leaked.
  const serverAttrs = server.attributes ?? [];
  const taskIds = new Set(server.tasks.map((t) => String(t.id)));
  const live = (m: Rows) => m.filter((a) => !DEFERRED_KEYS.has(String(a.key)) && (taskAttributes || !taskIds.has(String(a.node_id))));
  diffById("attribute", keyed(serverAttrs.filter((a) => !DEFERRED_KEYS.has(String(a.key))), attrKey, attrView), keyed(live(mirror.attributes), attrKey, attrView), out,
    (id) => `${title(id.split("\u0000")[0]!)}.${id.split("\u0000")[1]}`);
  const serverDeferred = keyed(serverAttrs.filter((a) => DEFERRED_KEYS.has(String(a.key))), attrKey, (a) => String(a.value));
  for (const a of mirror.attributes.filter((x) => DEFERRED_KEYS.has(String(x.key)))) {
    const expected = serverDeferred.get(attrKey(a));
    if (expected === undefined) out.push(`mirror: keeps ${String(a.key)} of "${title(String(a.node_id))}", which the server no longer has for this actor`);
    else if (expected !== String(a.value)) out.push(`mirror: out-of-date ${String(a.key)} on "${title(String(a.node_id))}"`);
  }
  // The in-memory attrs map of each note (drawings stay out of it).
  for (const n of store.nodes) {
    const expected = Object.fromEntries(serverAttrs.filter((a) => a.node_id === n.id && !DEFERRED_KEYS.has(String(a.key))).map((a) => [String(a.key), String(a.value)]));
    const attrs = Object.fromEntries(Object.entries((n.attrs as Record<string, string> | undefined) ?? {}).filter(([k]) => !DEFERRED_KEYS.has(k)));
    if (serverNotes.has(String(n.id)) && canon(attrs) !== canon(expected)) out.push(`store: note "${String(n.title)}" attrs: server ${canon(expected)} / here ${canon(attrs)}`);
  }

  // Nothing the actor cannot read may survive anywhere else on the device either.
  const mirrorIds = new Set(mirror.nodes.map((n) => String(n.id)));
  for (const row of mirror.fts) if (!serverNotes.has(String(row.id)) && !mirrorIds.has(String(row.id))) out.push(`mirror: search index keeps a note that is gone (${String(row.id).slice(0, 8)})`);
  for (const row of mirror.positions) if (!serverNotes.has(String(row.node_id))) out.push(`mirror: graph position of an unreadable note`);
  if (mirror.workspace && (mirror.workspace.name !== server.workspace.name || mirror.workspace.slug !== server.workspace.slug)) out.push("mirror: workspace row differs");
  return out;
}

// ── Steps ────────────────────────────────────────────────────────────────────

export type Step =
  | { step: "server"; op: ServerOp }
  | { step: "delta" }
  | { step: "bootstrap"; kind: "full" | "slim" }
  | { step: "lateBootstrap"; kind: "full" | "slim"; meanwhile: ServerOp[] }
  | { step: "resync" }
  | { step: "drawings" }
  | { step: "burst" };
export type Scenario = { client: Who; setup: ServerOp[]; steps: Step[] };

const waitFor = async (what: string, condition: () => boolean | Promise<boolean>, ms = 5000) => {
  for (const start = Date.now(); Date.now() - start < ms;) { if (await condition()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`timed out waiting for ${what}`);
};

class StepFailure extends Error {}
/** What every run starts with besides its own setup, so tags, a canvas, an edge and a task exist
 *  for the random ops to act on (none of these creates a note: note numbers stay those of `setup`). */
const PRELUDE: ServerOp[] = [
  { op: "createTag", name: "t1" }, { op: "tagPath", path: "p/q" }, { op: "createCanvas", space: 0, title: "board" },
  { op: "createEdge", from: 0, to: 1 }, { op: "createTask", note: 0, title: "task", due: false },
];
/** MIRROR_DEBUG=1: how often each op was accepted (2xx) or refused, printed after the property. */
const tally = new Map<string, number>();

/** Run a scenario; throws StepFailure naming the step and every difference. */
export async function runScenario(scenario: Scenario, inspect?: (world: World, client: Client) => Promise<void>): Promise<void> {
  const { createWorld } = await loadBackend();
  const world = await createWorld(h.app!);
  h.workspaceId = world.workspaceId;
  const fail = (index: number, label: string, details: string[]) => {
    throw new StepFailure(`after step ${index} (${label}):\n  - ${details.join("\n  - ")}${h.failures.length ? `\n  server refusals seen by the client:\n    ${h.failures.slice(-5).join("\n    ")}` : ""}`);
  };
  const serverOp = async (op: ServerOp) => {
    const replies = await world.apply(op);
    await world.settle();
    if (process.env.MIRROR_DEBUG) for (const r of replies.slice(0, 1)) tally.set(`${op.op} ${Math.floor(r.status / 100)}xx`, (tally.get(`${op.op} ${Math.floor(r.status / 100)}xx`) ?? 0) + 1);
    const broken = replies.find((r) => r.status >= 500);
    if (broken) throw new StepFailure(`server answered ${broken.status} to ${JSON.stringify(op)}: ${JSON.stringify(broken.body).slice(0, 300)}`);
  };
  try {
    for (const op of [...scenario.setup, ...PRELUDE]) await serverOp(op);
    const client = await startClient(scenario.client, world);
    let lastCursor = 0;

    const verify = async (index: number, label: string, { rewind = false } = {}) => {
      const state = client.state();
      const details: string[] = [];
      if (!state.online) details.push("the client is offline after the step");
      if (state.membershipGated) details.push("the membership gate is still up after the step");
      details.push(...await projectionDiff(world, client));
      const cursor = await client.cursor();
      const head = await world.head();
      if (cursor < lastCursor && !rewind) details.push(`the event cursor moved back from ${lastCursor} to ${cursor}`);
      if (cursor > head) details.push(`the event cursor ${cursor} is past the server's newest event ${head}`);
      if (cursor < head) details.push(`the event cursor ${cursor} is behind the server's newest event ${head} after a finished sync`);
      lastCursor = Math.max(lastCursor, cursor);
      if (details.length) fail(index, label, details);
    };
    const synced = async (index: number, label: string) => {
      const result = await client.engine.sync();
      if (!result.ok) fail(index, label, [`sync() did not complete (unreachable: ${String(result.unreachable)})`]);
    };

    await client.engine.boot();
    // The cold start's idle full hydration lands behind the slim paint.
    await waitFor("the full bootstrap of the cold start", () => client.state().data.bodies !== "none");
    await synced(0, "boot");
    await verify(0, "cold boot");

    for (const [i, s] of scenario.steps.entries()) {
      const index = i + 1;
      switch (s.step) {
        case "server": await serverOp(s.op); break;
        case "delta": await synced(index, "delta"); await verify(index, "delta"); break;
        case "resync":
          h.forceResync = true;
          await synced(index, "resync_required");
          h.forceResync = false;
          // The re-bootstrap lands the server's state but leaves the cursor where it was
          // (a bootstrap never moves it forward): the next sync replays the gap, idempotently.
          await synced(index, "sync after resync_required");
          await verify(index, "resync_required");
          break;
        case "burst": await serverOp({ op: "burst", count: 505 }); break;
        case "drawings": await client.engine.downloadDrawingsForOffline({ force: true }); await synced(index, "drawings"); await verify(index, "drawing download"); break;
        case "bootstrap":
          h.slimThreshold = s.kind === "slim" ? 0 : 2000;
          await client.engine.refresh();
          h.slimThreshold = 2000;
          await synced(index, `${s.kind} bootstrap`);
          await verify(index, `${s.kind} bootstrap then sync`);
          break;
        case "lateBootstrap": {
          // The download starts now and its answer is the server as of now ...
          let started!: () => void;
          const begun = new Promise<void>((r) => { started = r; });
          let release!: () => void;
          h.hold = { started, gate: new Promise<void>((r) => { release = r; }) };
          h.slimThreshold = s.kind === "slim" ? 0 : 2000;
          const landing = client.engine.refresh();
          h.slimThreshold = 2000;
          await begun;
          h.hold = null;
          // ... newer changes and their deltas reach the mirror meanwhile ...
          for (const op of s.meanwhile) await serverOp(op);
          await synced(index, "delta while the bootstrap downloads");
          await verify(index, "delta while the bootstrap downloads");
          // ... and then the old answer lands.
          release();
          await landing;
          await synced(index, "sync after the late bootstrap");
          await verify(index, `late ${s.kind} bootstrap then sync`, { rewind: true });
          break;
        }
      }
    }
    await synced(scenario.steps.length + 1, "final sync");
    await verify(scenario.steps.length + 1, "final sync");
    await inspect?.(world, client);
  } finally {
    await world.settle().catch(() => {});
  }
}

// ── Generators ───────────────────────────────────────────────────────────────

const who = fc.constantFrom<Who>("owner", "member");
const idx = fc.nat(7);
const title = fc.constantFrom("alpha", "beta", "gamma", "Alpha", "日記", "plan");
const body = fc.constantFrom("", "one", "two lines\nof text", "# heading\n\nbody [[alpha]] #beta", "- [ ] a\n- [x] b");
const small = fc.nat(5);

const serverOp: fc.Arbitrary<ServerOp> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ op: fc.constant("createNote" as const), by: who, space: fc.nat(3), parent: fc.option(idx, { nil: null, freq: 4 }), title, body }) },
  { weight: 4, arbitrary: fc.record({ op: fc.constant("editNote" as const), by: who, note: idx, body }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("renameNote" as const), by: who, note: idx, title }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant("moveNote" as const), note: idx, parent: fc.option(idx, { nil: null }), sort: fc.integer({ min: -3, max: 3 }) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("deleteNote" as const), note: idx }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("restoreNote" as const), note: idx }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("createTag" as const), name: fc.constantFrom("t1", "t2", "t3", "topic") }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("tagPath" as const), path: fc.constantFrom("p/q", "p/r", "p/q/s", "x/y") }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("renameTag" as const), tag: idx, name: fc.constantFrom("u1", "u2", "renamed") }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("deleteTag" as const), tag: idx }) },
  { weight: 7, arbitrary: fc.record({ op: fc.constant("applyTag" as const), by: who, note: idx, tag: idx }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant("removeTag" as const), by: who, note: idx, tag: idx }) },
  { weight: 4, arbitrary: fc.record({ op: fc.constant("setAttr" as const), by: who, note: idx, key: fc.nat(ATTRIBUTE_KEYS.length - 1), value: fc.constantFrom("a", "bb", "ccc", "stroke-data"), inheritable: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("delAttr" as const), note: idx, key: fc.nat(ATTRIBUTE_KEYS.length - 1) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("createEdge" as const), from: idx, to: idx }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("deleteEdge" as const), edge: idx }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("createTask" as const), note: idx, title, due: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant("patchTask" as const), task: idx, status: fc.constantFrom("todo" as const, "doing" as const, "done" as const, "cancelled" as const), title }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("createCanvas" as const), space: fc.nat(3), title }) },
  { weight: 4, arbitrary: fc.record({ op: fc.constant("placeOnCanvas" as const), canvas: small, note: idx }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("removeFromCanvas" as const), canvas: small, note: idx }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("setWhiteboardTab" as const), canvas: small, shown: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("deleteCanvas" as const), canvas: small }) },
  { weight: 3, arbitrary: fc.record({ op: fc.constant("moveSpace" as const), note: idx, space: fc.nat(3) }) },
  { weight: 4, arbitrary: fc.record({ op: fc.constant("setMember" as const), space: fc.nat(2), perm: fc.constantFrom("view" as const, "edit" as const, "none" as const) }) },
);

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 60, arbitrary: serverOp.map((op): Step => ({ step: "server", op })) },
  { weight: 20, arbitrary: fc.constant<Step>({ step: "delta" }) },
  { weight: 5, arbitrary: fc.constantFrom<Step>({ step: "bootstrap", kind: "full" }, { step: "bootstrap", kind: "slim" }) },
  { weight: 5, arbitrary: fc.record({ step: fc.constant("lateBootstrap" as const), kind: fc.constantFrom("full" as const, "slim" as const), meanwhile: fc.array(serverOp, { minLength: 1, maxLength: 4 }) }) },
  { weight: 5, arbitrary: fc.constant<Step>({ step: "resync" }) },
  { weight: 5, arbitrary: fc.constant<Step>({ step: "drawings" }) },
  { weight: 2, arbitrary: fc.constant<Step>({ step: "burst" }) },
);

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  client: fc.constantFrom<Who>("member", "member", "owner"),
  setup: fc.array(fc.record({ op: fc.constant("createNote" as const), by: who, space: fc.nat(3), parent: fc.constant(null), title, body }), { minLength: 2, maxLength: 5 }),
  steps: fc.array(stepArb, { minLength: 3, maxLength: 30 }),
});

// ── Properties ───────────────────────────────────────────────────────────────

const describeDb = describe.skipIf(!isTestDb);

describeDb("local mirror equals the server under random server histories", () => {
  afterAll(() => { vi.unstubAllGlobals(); });

  it("after every client action the mirror and the store equal the actor's fresh bootstrap", async () => {
    const runs = Number(process.env.PROPS_RUNS) > 0 ? Number(process.env.PROPS_RUNS) : 8;
    try {
      await fc.assert(fc.asyncProperty(scenarioArb, async (scenario) => { await runScenario(scenario); }), { seed: PROPS_SEED, numRuns: runs, verbose: 1 });
      if (process.env.MIRROR_DEBUG) writeFileSync(process.env.MIRROR_DEBUG, [...tally].sort().map(([k, v]) => `${k}=${v}`).join("\n"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${detail}\n\nreplay: PROPS_SEED=${PROPS_SEED} PROPS_RUNS=${runs}`, { cause: error });
    }
  }, 30 * 60_000);
});

// A deterministic scenario that exercises every kind of step once. It guards the
// harness itself: if it ever fails, the property above proves nothing.
describeDb("mirror harness", () => {

  it("a catch-up that needs several delta pages is mirrored exactly", async () => {
    // 520 attribute writes: more than the 500 events one delta carries.
    await runScenario({
      client: "member",
      setup: [{ op: "createNote", by: "owner", space: 0, parent: null, title: "alpha", body: "one" }],
      steps: [
        { step: "server", op: { op: "burst", count: 520 } },
        { step: "server", op: { op: "renameNote", by: "owner", note: 0, title: "beta" } },
        { step: "delta" },
      ],
    }, async () => {
      const pages = h.requests.filter((r) => r === "POST /api/sync").length;
      expect(pages, "POST /api/sync requests of the whole run").toBeGreaterThanOrEqual(3);
    });
  }, 300_000);

  it("the comparison notices a mirror that lost a note (negative control)", async () => {
    await runScenario({
      client: "owner",
      setup: [{ op: "createNote", by: "owner", space: 0, parent: null, title: "alpha", body: "one" }],
      steps: [],
    }, async (world, client) => {
      expect(await projectionDiff(world, client)).toEqual([]);
      await client.localDb.removeNode(world.pools.notes[0]!);
      const diff = await projectionDiff(world, client);
      expect(diff.some((line) => line.includes('mirror: missing note "alpha"'))).toBe(true);
    });
  }, 120_000);

  it("a plain history is mirrored exactly (positive control)", async () => {
    await runScenario({
      client: "member",
      setup: [{ op: "createNote", by: "owner", space: 0, parent: null, title: "alpha", body: "one" }],
      steps: [
        { step: "server", op: { op: "createNote", by: "owner", space: 2, parent: null, title: "beta", body: "two" } },
        { step: "server", op: { op: "setAttr", by: "owner", note: 0, key: 0, value: "a", inheritable: false } },
        { step: "delta" },
        { step: "bootstrap", kind: "slim" },
        { step: "server", op: { op: "setMember", space: 1, perm: "none" } },
        { step: "delta" },
      ],
    });
  }, 120_000);
});

// ── Findings ─────────────────────────────────────────────────────────────────
//
// Each is a shortest failing sequence found by the property above, replayed
// here as a fixed scenario. `it.fails` passes while the problem exists and
// FAILS once it is fixed - then change it to `it`, and drop the `taskAttributes` option (finding 2).
//
//  1. A bootstrap that lands late undid a permission change the mirror had already
//     applied, and nothing put it right (1a revoke, 1b grant; full and slim). Fixed in
//     syncEngine: a bootstrap that lands after the membership epoch moved makes the
//     next sync check the readable set again.
//  2. The projections disagreed about task nodes' attributes (2): a grant's projection (nodesFor)
//     carried them, the bootstrap and the delta do not, and no later path updated or removed them.
//     Fixed in membership.ts: nodesFor leaves a task node's attributes out too (its task row carries it).

describeDb("findings", () => {
  for (const kind of ["full", "slim"] as const) {
    // 1a. The actor loses a note while a bootstrap is downloading. A sync brings the revocation
    // in (the membership reconcile deletes the note and saves the new epoch). Then the old
    // bootstrap - taken before the revocation - lands: it puts the note back and rewinds the
    // cursor, and the sync that replays the gap finds the epoch equal to the saved one, so no
    // reconcile runs; a space change is not a node event either. The member's device keeps a
    // note (title, body, attributes, its tasks) it may no longer read, and later syncs do not
    // remove it.
    it(`1a. a late ${kind} bootstrap brings back a note the actor lost access to`, async () => {
      await runScenario({
        client: "member",
        setup: [{ op: "createNote", by: "owner", space: 0, parent: null, title: "alpha", body: "secret later" }],
        steps: [{ step: "lateBootstrap", kind, meanwhile: [{ op: "moveSpace", note: 0, space: 3 }] }],
      });
    }, 120_000);

    // 1b. The mirror image: the actor is given a space while a bootstrap is downloading. The sync
    // reconciles and the note arrives; the old bootstrap then drops it (a full bootstrap deletes
    // the notes it lacks, a slim one the ids absent from its list) and the replay fetches nothing
    // (the grant is not a node event, the epoch is already saved). A note the actor may read is
    // missing from the mirror and the store.
    it(`1b. a late ${kind} bootstrap removes a note the actor was just given access to`, async () => {
      await runScenario({
        client: "member",
        setup: [{ op: "createNote", by: "owner", space: 3, parent: null, title: "alpha", body: "one" }],
        steps: [{ step: "lateBootstrap", kind, meanwhile: [{ op: "setMember", space: 2, perm: "view" }] }],
      });
    }, 120_000);
  }

  // 2. A grant (the membership reconcile's POST /api/sync/nodes, and the delta's attribute events)
  // ships the attributes of task nodes (_task_status ...); a bootstrap leaves them out, because its
  // attribute list is read for the notes it returns and task nodes are not among them. The same
  // actor therefore holds different attribute rows depending on how a note arrived. Nothing in the
  // app reads a task node's attributes from the mirror (they are not in the notes' attrs maps), so
  // it is harmless today, but "mirror == fresh bootstrap" is not true row for row.
  it("2. a granted space brings no task attributes a bootstrap does not carry", async () => {
    await runScenario({
      client: "member",
      setup: [{ op: "createNote", by: "owner", space: 3, parent: null, title: "alpha", body: "one" }],
      steps: [{ step: "server", op: { op: "setMember", space: 2, perm: "view" } }, { step: "delta" }],
    }, async (world, client) => {
      expect(await projectionDiff(world, client, { taskAttributes: true })).toEqual([]);
    });
  }, 120_000);
});
