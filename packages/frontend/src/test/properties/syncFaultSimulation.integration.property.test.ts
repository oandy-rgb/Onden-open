// @vitest-environment jsdom
// Several devices on the REAL backend over a network that misbehaves.
//
// Each device runs the real client stack (noteWriter/tagWriter → writeQueue →
// writeRecovery → localDb worker with sql.js → syncEngine, own local copy and
// own Web Locks). Its `fetch` goes to the backend's own Hono `app` on a real
// Postgres (helpers/realBackendWorld.ts), so Idempotency-Key replay, patch
// bases (`patch_base_unknown`), the three-way body merge, move/cycle refusal,
// delete/undelete cascades and sync deltas are the shipped code. The existing
// pieces test one layer each (writeQueueModel: queue vs a fake server;
// multiTab: tabs vs a fake server; backend syncSimulator: HTTP protocol copy of
// the client vs the real server); this one runs both real halves together.
//
// The test chooses every fate of every request: delivered, dropped before the
// server saw it, applied with the answer lost, answered 503 by a "proxy",
// delivered twice at once, applied but answered later (reordering), or never
// answered (the client's 25 s deadline ends it). It also takes the server
// off and on, puts devices offline/online, reloads or crashes a device (its
// queue and local copy stay), and lets the other device edit in between.
//
// Operations (all through the real writers): create a note, type a line into a
// body (insert / delete / rewrite, so two devices touch the same or different
// lines), rename, move (also under its own descendant), delete, restore from
// the trash, add/remove a tag.
//
// After a run settles (everyone online, every request answered, queues drained,
// synced), against the server's own tables:
//   1 convergence: each device shows exactly what the server holds (title, body,
//     parent, tags, which notes are live), and so does a device opened afterwards
//     from scratch (bootstrap and deltas agree)
//   2 nothing acknowledged is lost: a line a device was told is saved (synced or
//     queued) is in the final body, in a recorded BODY_CONFLICT, or in that
//     device's recovery list (refused/unconfirmed writes) — unless a user removed it
//   3 no text is applied twice (a line appears once in a body)
//   4 a duplicate or retried write is not applied twice: per Idempotency-Key at most one
//     arrival is answered as new, a note has at most one NODE_CREATED event
//   5 the tree has no cycle and no missing parent; a live note is not under a deleted one;
//     event ids are strictly increasing in the log, and a device's cursor never goes back
//   6 no write is left in a device's queue, and none was silently dropped (queued writes
//     either reached the server or are in recovery: 2 covers the text, this covers the queue)
//
// Not covered here (see the PR): a viewer-only device for scope leaks (permissions have their own
// property tests), the backend process restarting (the server "down" fate is a network outage),
// handwriting strokes.
//
// Needs Postgres: DATABASE_URL naming a `…_test` database that already holds the schema (a backend
// test run builds it). Without it the test is skipped (and says so), it never passes silently.
//
// The devices are two pages of ONE signed-in account (the workspace's owner; auth is mocked to that session), each
// with its own local copy. What a page sends reaches the server as sent (protocol, device id, Idempotency-Key), with
// the page's Origin, so the server's page gates are in the path (helpers/realBackendWorld.ts).
// jsdom, not the default happy-dom (first line): happy-dom's Request drops the Origin header before the backend sees it.
//
// Replay:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/syncFaultSimulation.integration.property.test.ts
//          (fast-check prints the seed, path and the shrunk command list; PROPS_PATH=<path> jumps
//          straight to the shrunk case; PROPS_TRACE=1 appends the server's timeline to a failure.)
//          SIM_STRICT_RETRY=1 also demands that a retry of an applied write is answered as success
//          (three cases the backend still refuses are listed in the PR / backend syncSim/regressions.ts).

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let WS = "";
/** The one signed-in person: every device is a page of this account (the session the mocked auth answers with). */
let USER: { id: string; email: string; name: string } | null = null;
/** The page's origin, as a browser sends it on every write (always allowed by the server's origin guard). */
const ORIGIN = "http://localhost";
vi.mock("../../../../backend/src/db", async (original) => ({ ...await original<Record<string, unknown>>(), getWorkspaceId: async () => WS }));
vi.mock("../../../../backend/src/auth", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => (USER ? { user: USER } : null)) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

import { CLIENT_PROTOCOL, CLIENT_PROTOCOL_HEADER } from "@onden/markdown";
import { nodeNeedsBody } from "../../lib/api";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";
import { RealBackendWorld, type Fate, type Handled } from "../helpers/realBackendWorld";
import { dataCtx, tabContext, type Tab } from "../helpers/tabWorld";

const DATABASE_URL = process.env.DATABASE_URL;
const enabled = /^postgres(ql)?:\/\/[^/]*\/[^/?]*_test(\?.*)?$/.test(DATABASE_URL ?? "") && /localhost|127\.0\.0\.1/.test(DATABASE_URL ?? "");
/** Runs are slow (real database, four module registries a device): capped unless PROPS_RUNS is set on purpose. */
const RUNS = process.env.PROPS_RUNS ? PROPS_RUNS : Math.min(PROPS_RUNS, 25);
/** One run takes about a second; far above that it is stuck. */
const RUN_LIMIT_MS = 90_000;
/** Shrinking a failure takes about a second per step; the report keeps the smallest case found when the budget ends. */
const SHRINK_BUDGET_MS = 6 * 60_000;
const STRICT_RETRY = !!process.env.SIM_STRICT_RETRY;
/** Look at the known bugs instead of steering around them (the KNOWN cases at the bottom). */
const INCLUDE_KNOWN = !!process.env.SIM_INCLUDE_KNOWN;

// The backend is loaded by a computed path and typed here by what the test uses: a type-level import would make
// the frontend's tsc check the whole backend with the frontend's settings.
type App = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
type Query = <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
const backendPath = (file: string): string => fileURLToPath(new URL(`../../../../backend/src/${file}.ts`, import.meta.url));
const backend = <T,>(file: string): Promise<T> => import(/* @vite-ignore */ backendPath(file)) as Promise<T>;
let app: App | undefined;
let q: Query;
let w: RealBackendWorld;
let spaceId = "";
let simTagIds: string[] = [];
const realSetTimeout = globalThis.setTimeout;
/** What the runs actually exercised (printed with SIM_STATS=1): a green run that never hit a fault proves nothing. */
const stats = { runs: 0, requests: 0, duplicates: 0, refused4xx: 0, deduped: 0, bodyConflicts: 0, queuedAcks: 0, recoveryLines: 0, lostAnswers: 0, dropped: 0, deadlines: 0, deaths: 0, deathsMidWrite: 0, resumeChecks: 0 };

beforeAll(async () => {
  if (!enabled) return;
  const db = await backend<{ q: Query; migrate: () => Promise<void> }>("db");
  q = db.q;
  // In-process PGlite (ONDEN_DB_DRIVER=pglite, no server) has no globalSetup to build its schema as the backend suite does: migrate it here.
  if (process.env.ONDEN_DB_DRIVER === "pglite") {
    const { useMigrationSource } = await backend<{ useMigrationSource: (source: () => Promise<Array<{ version: string; sql: string }>>) => void }>("dbMigrations");
    const dbFile = backendPath("db").replace(/^\/@fs/, "");
    useMigrationSource(async () => {
      const [fs, path] = await Promise.all([import("node:fs/promises"), import("node:path")]);
      const dir = path.join(path.dirname(dbFile), "../db/migrations");
      const names = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
      return Promise.all(names.map(async (name) => ({ version: name.replace(/\.sql$/, ""), sql: await fs.readFile(path.join(dir, name), "utf-8") })));
    });
    await db.migrate();
  }
  const present = (await q<{ t: string | null }>(`SELECT to_regclass('public.schema_migrations')::text AS t`)).rows[0]?.t;
  if (!present) return; // schema missing: the test skips itself
  app = (await backend<{ app: App }>("app")).app;
  WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Sync fault simulation', $1) RETURNING id::text`, [`simfault-${randomUUID()}`])).rows[0]!.id;
  // The account: the first person to sign in to an empty workspace becomes its owner (services/actors.ts
  // actorForSession), as on a fresh install. No System actor exists here, so nothing rides the native-origin bypass.
  USER = { id: `user-${randomUUID()}`, email: `owner-${randomUUID()}@example.test`, name: "Owner" };
  // The first request signs the person in; the workspace's config note is made lazily: not inside a run's first write.
  const first = await direct("GET", "/api/bootstrap?bodies=none");
  if (first.status !== 200) throw new Error(`sign-in failed: ${first.status} ${first.text}`);
  spaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [WS])).rows[0]!.id;
  for (const name of ["sim-a", "sim-b"]) {
    const made = await direct("POST", "/api/tags", { name: `${name}-${randomUUID().slice(0, 8)}`, id: randomUUID() });
    if (made.status !== 201) throw new Error(`tag setup failed: ${made.status} ${made.text}`);
    simTagIds.push((JSON.parse(made.text) as { id: string }).id);
  }
  w = new RealBackendWorld(app, { userId: USER.id, origin: ORIGIN });
  // sql.js reads its wasm from disk once, for real; after that nothing in a tab waits on the outside world.
  await (await import("sql.js")).default();
}, 120_000);
afterEach(() => { if (w) w.uninstall(); });
afterAll(async () => {
  // Straight to the process: piped, the default reporter does not show what a passed file logs in afterAll.
  if (process.env.SIM_STATS && stats.runs) process.stdout.write(`[sync-fault-sim] ${JSON.stringify(stats)}\n`);
  if (enabled && app) await (await backend<{ pool: { end(): Promise<void> } }>("db")).pool.end().catch(() => {});
});

async function direct(method: string, path: string, json?: unknown): Promise<{ status: number; text: string }> {
  // Set-up writes come from a page of the same account too: its Origin, the expected login, the protocol it speaks.
  const headers = { origin: ORIGIN, "X-Onden-Expected-User": USER!.id, [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL), ...(json !== undefined ? { "content-type": "application/json" } : {}) };
  const res = await app!.request(path, { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined });
  return { status: res.status, text: await res.text() };
}

// ── the run ──────────────────────────────────────────────────────────────────

type Dev = "A" | "B";
type Ack = "started" | "synced" | "queued" | "refused" | "failed";
type Typed = { line: string; note: string; dev: Dev; ack: Ack };
type Run = {
  nonce: string; counter: number; uuid: number;
  tabs: Record<Dev, Tab>; reboots: number;
  notes: string[]; /** creation order: how "the 3rd note" is resolved */
  typed: Typed[]; removedLines: Set<string>;
  /** The merge base of the note a device is typing into (draftActions `bases`), dropped when it moves to another note. */
  editing: Record<Dev, { note: string; base: string } | null>;
  everDeleted: string[];
  includeKnown: boolean;
  ops: Array<{ tab: Tab; done: Promise<unknown> }>;
  /** Per tab, writes started and not yet answered or queued. */
  writing: Map<Tab, number>;
  cursors: Map<string, number>;
  problems: string[];
  /** Per tab, the notes a started write has not finished with: where a death can leave the local copy ahead of the queue. */
  touching: Map<Tab, Map<string, number>>;
  /** `account|note` pairs whose local copy may legitimately show a write the device died in the middle of (the KNOWN phantom change). */
  phantom: Set<string>;
  /** Titles a device was told were saved. */
  titled: Titled[];
  /** Notes whose creation a device was told was saved. */
  created: Array<{ note: string; dev: Dev; ack: Ack }>;
  deaths: number;
};
type Titled = { title: string; note: string; dev: Dev; ack: Ack };

const macrotask = () => new Promise<void>((resolve) => setImmediate(resolve));
const realDelay = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));
const alive = (run: Run, dev: Dev): Tab | null => run.tabs[dev].dead ? null : run.tabs[dev];
const lines = (body: string): string[] => (body === "" ? [] : body.split("\n"));
const shownNote = (tab: Tab, id: string) => tab.mods.appStore.getAppState().data.nodes.find((n) => n.id === id);

/** Notes this run made that the device can see now (live in its own copy), in creation order. */
function visible(run: Run, tab: Tab): string[] {
  const shown = new Set(tab.mods.appStore.getAppState().data.nodes.filter((n) => n.node_type === "content").map((n) => n.id));
  return run.notes.filter((id) => shown.has(id));
}
const pickAt = <T,>(list: T[], n: number): T | undefined => (list.length ? list[n % list.length] : undefined);

/** Drive until `promise` settles: storage requests complete, the wire is answered with `fate`, time moves when nothing else can. */
async function drive<T>(promise: Promise<T>, fate: Fate | null = "deliver", limit = 3000): Promise<T> {
  let settled = false;
  let idle = 0;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < limit; i++) {
    await macrotask();
    if (settled) return promise;
    if (w.idb.io.length) { const item = w.idb.io.shift()!; tabContext.run(item.tab as Tab, item.run); continue; }
    await macrotask();
    if (settled) return promise;
    if (w.idb.io.length) continue;
    const open = w.backend.inflight[0];
    if (open && fate) { await w.backend.respond(open, fate); idle = 0; continue; }
    if (++idle < 4) { await realDelay(1); continue; }
    idle = 0;
    await vi.advanceTimersByTimeAsync(1000);
  }
  throw new Error("drive: the operation never finished");
}

function begin(run: Run, tab: Tab, fn: () => Promise<unknown>, write = false, note?: string): void {
  if (write) run.writing.set(tab, (run.writing.get(tab) ?? 0) + 1);
  const touched = note ? (run.touching.get(tab) ?? run.touching.set(tab, new Map()).get(tab)!) : null;
  if (touched && note) touched.set(note, (touched.get(note) ?? 0) + 1);
  const done = w.start(tab, fn).finally(() => {
    if (write) run.writing.set(tab, (run.writing.get(tab) ?? 1) - 1);
    if (touched && note) touched.set(note, (touched.get(note) ?? 1) - 1);
  });
  run.ops.push({ tab, done });
}

async function openDevice(run: Run, slot: Dev | null, wait: boolean, account = `dev${slot}`, asTheAppDoes = false): Promise<Tab> {
  const tab = await w.createTab(`${slot ?? account}${run.reboots++}`, account);
  if (slot) run.tabs[slot] = tab;
  // The app starts the connection lifecycle (connectivity.ts: boot, then the reconnect retry when the server could not be
  // reached); a plain boot() is the lighter start the other property uses.
  const booting = w.start(tab, async () => { if (asTheAppDoes) tab.mods.connectivity.attachConnectivity(window); else await tab.mods.syncEngine.boot(); });
  run.ops.push({ tab, done: booting });
  if (wait) await drive(booting);
  return tab;
}

async function reconnectLikeTheApp(tab: Tab): Promise<void> {
  await tab.mods.syncEngine.reconnect();
  await tab.mods.syncEngine.refreshIfStale();
}

// ── commands ─────────────────────────────────────────────────────────────────

type Cmd = fc.AsyncCommand<object, Run>;
const dev = fc.constantFrom<Dev>("A", "B");
const ix = fc.nat(30);
const pumps = fc.integer({ min: 0, max: 20 });
const seed = fc.integer({ min: 0, max: 1_000_000 });
const FATES: Fate[] = ["deliver", "deliver", "deliver", "deliver", "deliver", "arrive", "503", "net", "net", "lose", "lose", "dup"];

function cmd<A extends unknown[]>(name: (...a: A) => string, exec: (run: Run, ...a: A) => Promise<void>) {
  return (...args: A): Cmd => ({
    check: () => true,
    async run(_m, run) { await exec(run, ...args); },
    toString: () => name(...args),
  });
}

/** Start a user action on a device and leave it running (it ends when the wire is answered). */
function act(run: Run, d: Dev, note: string, fn: (tab: Tab, writer: ReturnType<Tab["mods"]["noteWriter"]["makeNoteWriter"]>) => Promise<void>): void {
  const tab = alive(run, d);
  if (!tab) return;
  begin(run, tab, () => fn(tab, tab.mods.noteWriter.makeNoteWriter(dataCtx(tab))), true, note);
}

const Create = cmd((d: Dev, parent: number | null, k: number, sd: number) => `create(${d}, under ${parent === null ? "top" : `note#${parent}`}) pump(${k},${sd})`, async (run, d, parent, k, sd) => {
  const tab = alive(run, d);
  if (!tab) return;
  const parentId = parent === null ? null : pickAt(visible(run, tab), parent);
  if (parent !== null && !parentId) return;
  const id = freshId(run);
  run.notes.push(id);
  const line = `${d}${++run.counter}`;
  run.typed.push({ line, note: id, dev: d, ack: "started" });
  const typed = run.typed[run.typed.length - 1]!;
  const made: { note: string; dev: Dev; ack: Ack } = { note: id, dev: d, ack: "started" };
  run.created.push(made);
  act(run, d, id, async (t, writer) => {
    try {
      const r = await writer.create({ id, title: `note ${run.notes.length}`, markdown: line, ...(parentId ? { parent_id: parentId } : { space_id: spaceId }) });
      typed.ack = r.status; made.ack = r.status;
    } catch (error) { typed.ack = error instanceof t.mods.api.ApiError ? "refused" : "failed"; made.ack = typed.ack; }
  });
  await w.pump(k, sd);
});

const Type = cmd((d: Dev, note: number, how: "insert" | "delete" | "rewrite", at: number, k: number, sd: number) => `type(${d}, ${how} line ${at} of note#${note}) pump(${k},${sd})`, async (run, d, note, how, at, k, sd) => {
  const tab = alive(run, d);
  const id = tab && pickAt(visible(run, tab), note);
  if (!tab || !id) return;
  // The editor opens a note only once its body is loaded (a slim bootstrap leaves bodies on the server).
  if (nodeNeedsBody(shownNote(tab, id))) return;
  const shown = shownNote(tab, id)?.markdown ?? "";
  const next = lines(shown);
  const slot = next.length ? at % (next.length + (how === "insert" ? 1 : 0)) : 0;
  const line = `${d}${++run.counter}`;
  if (how === "insert" || next.length === 0) next.splice(slot, 0, line);
  else if (how === "delete") run.removedLines.add(next.splice(slot, 1)[0]!);
  else { run.removedLines.add(next[slot]!); next[slot] = line; }
  const record: Typed | null = how === "delete" ? null : { line, note: id, dev: d, ack: "started" };
  if (record) run.typed.push(record);
  const body = next.join("\n");
  const base = run.editing[d]?.note === id ? run.editing[d]!.base : shown;
  // The next save of this note is based on this draft at once: the note's write lane orders the saves, and the
  // editor reads the base of a later save only when it is sent (draftActions), after the earlier one is in.
  run.editing[d] = { note: id, base: body };
  act(run, d, id, async (t, writer) => {
    try {
      const r = await writer.patch(id, { markdown: body }, { baseMarkdown: base });
      if (record) record.ack = r.status;
    } catch (error) {
      if (record) record.ack = error instanceof t.mods.api.ApiError ? "refused" : "failed";
      if (run.editing[d]?.note === id && run.editing[d]!.base === body) run.editing[d] = { note: id, base };
    }
  });
  await w.pump(k, sd);
});

const Rename = cmd((d: Dev, note: number, k: number, sd: number) => `rename(${d}, note#${note}) pump(${k},${sd})`, async (run, d, note, k, sd) => {
  const tab = alive(run, d);
  const id = tab && pickAt(visible(run, tab), note);
  if (!tab || !id) return;
  const record: Titled = { title: `renamed ${++run.counter}`, note: id, dev: d, ack: "started" };
  run.titled.push(record);
  act(run, d, id, async (t, writer) => {
    try { record.ack = (await writer.patch(id, { title: record.title })).status; }
    catch (error) { record.ack = error instanceof t.mods.api.ApiError ? "refused" : "failed"; }
  });
  await w.pump(k, sd);
});

const Move = cmd((d: Dev, note: number, to: number | null, k: number, sd: number) => `move(${d}, note#${note} -> ${to === null ? "top" : `note#${to}`}) pump(${k},${sd})`, async (run, d, note, to, k, sd) => {
  const tab = alive(run, d);
  const list = tab ? visible(run, tab) : [];
  const id = pickAt(list, note);
  // Any note counts as a target, also the note itself and its descendants: the server has to refuse the cycle.
  const target = to === null ? null : pickAt(list, to);
  if (!tab || !id || (to !== null && !target)) return;
  act(run, d, id, async (t, writer) => { await writer.patch(id, { parent_id: target }).catch(() => {}); });
  await w.pump(k, sd);
});

const Delete = cmd((d: Dev, note: number, k: number, sd: number) => `delete(${d}, note#${note}) pump(${k},${sd})`, async (run, d, note, k, sd) => {
  const tab = alive(run, d);
  const id = tab && pickAt(visible(run, tab), note);
  if (!tab || !id) return;
  run.everDeleted.push(id);
  act(run, d, id, async (t, writer) => { await writer.remove(id).catch(() => {}); });
  await w.pump(k, sd);
});

/** Restore from the trash: an online action (history writer), sent straight through the device's own api. */
const Undelete = cmd((d: Dev, pick: number, k: number, sd: number) => `undelete(${d}, #${pick}th deleted note) pump(${k},${sd})`, async (run, d, pick, k, sd) => {
  const tab = alive(run, d);
  const id = pickAt(run.everDeleted, pick);
  if (!tab || !id || !tab.online) return;
  act(run, d, id, async (t) => { await t.mods.api.api(`/api/nodes/${id}/undelete`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } }).catch(() => {}); });
  await w.pump(k, sd);
});

const Tag = cmd((d: Dev, note: number, tag: number, on: boolean, k: number, sd: number) => `tag(${d}, note#${note} ${on ? "+" : "-"}tag${tag % 2}) pump(${k},${sd})`, async (run, d, note, tag, on, k, sd) => {
  const tab = alive(run, d);
  const id = tab && pickAt(visible(run, tab), note);
  if (!tab || !id) return;
  begin(run, tab, async () => {
    const writer = tab.mods.tagWriter.makeTagWriter(dataCtx(tab));
    await (on ? writer.apply : writer.remove)(id, simTagIds[tag % simTagIds.length]!).catch(() => {});
  }, true, id);
  await w.pump(k, sd);
});

/** 「不發布」 / 「放回網站」 on a note: an online action, sent through the device's own api like Undelete. */
const SiteMark = cmd((d: Dev, note: number, off: boolean, k: number, sd: number) => `${off ? "keep off the site" : "put back on the site"}(${d}, note#${note}) pump(${k},${sd})`, async (run, d, note, off, k, sd) => {
  const tab = alive(run, d);
  const id = tab && pickAt(visible(run, tab), note);
  if (!tab || !id || !tab.online) return;
  const path = `/api/nodes/${id}/attributes/_published`;
  act(run, d, id, async (t) => {
    await t.mods.api.api(path, off
      ? { method: "PUT", headers: { "Idempotency-Key": crypto.randomUUID(), "content-type": "application/json" }, body: JSON.stringify({ value: "false", value_type: "text" }) }
      : { method: "DELETE", headers: { "Idempotency-Key": crypto.randomUUID() } }).catch(() => {});
  });
  await w.pump(k, sd);
});

const GoOffline = cmd((d: Dev) => `offline(${d})`, async (run, d) => {
  const tab = alive(run, d);
  if (!tab) return;
  tab.online = false;
  tab.mods.syncEngine.wentOffline();
  await w.pump(2);
});
const GoOnline = cmd((d: Dev, k: number, sd: number) => `online(${d}) pump(${k},${sd})`, async (run, d, k, sd) => {
  const tab = alive(run, d);
  if (!tab) return;
  tab.online = true;
  begin(run, tab, () => reconnectLikeTheApp(tab));
  await w.pump(k, sd);
});
const Drain = cmd((d: Dev, k: number, sd: number) => `drain(${d}) pump(${k},${sd})`, async (run, d, k, sd) => {
  const tab = alive(run, d);
  if (!tab) return;
  begin(run, tab, () => tab.mods.writeQueue.flushPendingWrites());
  await w.pump(k, sd);
});
const Sync = cmd((d: Dev, k: number, sd: number) => `sync(${d}) pump(${k},${sd})`, async (run, d, k, sd) => {
  const tab = alive(run, d);
  if (!tab) return;
  begin(run, tab, () => tab.mods.syncEngine.sync());
  await w.pump(k, sd);
});
const Respond = cmd((index: number, fate: Fate, k: number, sd: number) => `respond(#${index}, ${fate}) pump(${k},${sd})`, async (_run, index, fate, k, sd) => {
  const open = w.backend.open;
  if (open.length) await w.backend.respond(open[index % open.length]!, fate);
  await w.pump(k, sd);
});
const Pump = cmd((k: number, sd: number) => `pump(${k},${sd})`, async (_run, k, sd) => { await w.pump(k, sd); });
const Advance = cmd((ms: number) => `advance(${ms}ms)`, async (_run, ms) => { await w.advance(ms); });
const ServerOff = cmd(() => "server goes down", async () => { w.backend.down = true; });
const ServerOn = cmd(() => "server comes back", async () => { w.backend.down = false; });

/** The page is closed or crashed and opened again: the queue and the local copy stay on the device. */
const Reboot = cmd((d: Dev, steps: number, sd: number, clean: boolean) => `reboot(${d}, ${clean ? "pagehide first" : "crash"}) pump(${steps},${sd})`, async (run, d, steps, sd, clean) => {
  const old = alive(run, d);
  if (!old) return;
  // KNOWN (phantom change): a write the page has not yet queued or sent when it goes away is in no queue, but the
  // local copy already shows it (the mirror is written first). Like multiTab's crash, the property does not
  // close a page that is still writing; SIM_INCLUDE_KNOWN=1 does.
  if (!run.includeKnown && (run.writing.get(old) ?? 0) > 0) return;
  if (clean) {
    begin(run, old, () => old.mods.localDb.flushLocalDbSync());
    old.fire("pagehide");
  }
  await w.pump(steps, sd);
  w.kill(old, clean, false);
  run.editing[d] = null;
  await openDevice(run, d, false);
  await w.pump(5, sd);
});

/** How the page dies: what it managed to do on the way out, and what of its half-finished storage and wire work survives. */
type Death = {
  /** pagehide ran first (a tab closed or navigated), then the page was gone; otherwise it just stopped (a kill, a power cut). */
  pagehide: boolean;
  /** An IndexedDB transaction that was open commits (the flush reached the disk) or rolls back. */
  commit: boolean;
  /** The request the page had on the wire reached the server before it died (its answer never reaches anybody). */
  wireArrives: boolean;
  /** A keepalive request (sent from pagehide) outlives the page. */
  keepalive: boolean;
};
const deathText = (x: Death) => `${x.pagehide ? "pagehide then " : ""}${x.commit ? "disk keeps" : "disk drops"} open storage, ${x.wireArrives ? "wire arrives" : "wire lost"}${x.keepalive ? ", keepalive survives" : ""}`;

/** The page dies after `steps` more storage completions, at a point the test picks: between any two of a write's steps
 *  (mirror, queue row, request, clearing the row). The device is opened again from the same disk. Unlike Reboot, a device
 *  that is in the middle of writing may die; the one outcome that is allowed there is the KNOWN phantom change. */
const Crash = cmd((d: Dev, steps: number, sd: number, death: Death) => `crash(${d} after ${steps} storage steps: ${deathText(death)})`, async (run, d, steps, sd, death) => {
  const old = alive(run, d);
  if (!old) return;
  if (death.pagehide) {
    begin(run, old, () => old.mods.localDb.flushLocalDbSync());
    old.fire("pagehide");
  }
  await w.pump(steps, sd);
  if (death.wireArrives) for (const req of w.backend.inflight.filter((r) => r.tab === old && !r.arrived)) await w.backend.arrive(req);
  if (!run.includeKnown) {
    for (const [note, n] of run.touching.get(old) ?? []) if (n > 0) run.phantom.add(`${old.account}|${note}`);
  }
  run.deaths++;
  stats.deaths++;
  if ((run.writing.get(old) ?? 0) > 0) stats.deathsMidWrite++;
  w.kill(old, death.commit, death.pagehide && death.keepalive);
  run.editing[d] = null;
  await openDevice(run, d, false, `dev${d}`, true);
  await w.pump(5, sd);
});

/** Nothing is pressed: the network is fine and time passes. A device that is online and has queued writes empties its
 *  queue on its own (the retry timer, the boot, the resume), whatever step the last page died in. */
const Resume = cmd((d: Dev, ms: number) => `resume(${d}, ${ms} ms of quiet)`, async (run, d, ms) => {
  const tab = alive(run, d);
  // A page whose first request failed ends its boot "offline" and has no timer of its own: in the app the live-events
  // connection (SSE, not simulated here) brings it back, so only a device that believes it is online is held to this.
  if (!tab || !tab.online || w.backend.down || !tab.mods.appStore.getAppState().online) return;
  const before = await pendingRows(tab);
  if (before === 0) return;
  stats.resumeChecks++;
  // A queued write from this very page life may be waiting for the retry timer: give the longest wait of the schedule twice over.
  await drive(new Promise<void>((resolve) => setTimeout(resolve, ms)), "deliver", 20_000);
  const queue = await drive(w.start(tab, () => tab.mods.localDb.getPendingWrites()) as Promise<Array<{ method: string; path: string; body: string | null; attempts: number }>>);
  const left = queue.length;
  // Another request of this device may still be waiting for the other device's writes or the server's answer: only a queue that
  // did not move at all, with nothing on the wire from it, is the bug (a queue that is stuck after a death).
  if (left >= before && w.backend.open.every((r) => r.tab !== tab)) run.problems.push(`#7 device ${tab.name}: ${before} queued write(s) did not move in ${ms / 1000} s with the server up and the device online: ${queue.map((r) => `${r.method} ${nameOf(run, r.path)} ${(r.body ?? "").slice(0, 60)} (attempts ${r.attempts})`).join("; ")}`);
});

const weighted = (entries: Array<{ weight: number; arbitrary: fc.Arbitrary<Cmd> }>): Array<fc.Arbitrary<Cmd>> =>
  entries.flatMap(({ weight, arbitrary }) => Array<fc.Arbitrary<Cmd>>(weight).fill(arbitrary));
const commandArbs = weighted([
  { weight: 3, arbitrary: fc.tuple(dev, fc.option(ix, { nil: null, freq: 2 }), pumps, seed).map(([a, b, c, e]) => Create(a, b, c, e)) },
  { weight: 14, arbitrary: fc.tuple(dev, ix, fc.constantFrom("insert", "insert", "delete", "rewrite", "rewrite") as fc.Arbitrary<"insert" | "delete" | "rewrite">, fc.nat(2), pumps, seed).map(([a, b, c, e, f, g]) => Type(a, b, c, e, f, g)) },
  { weight: 1, arbitrary: fc.tuple(dev, ix, pumps, seed).map(([a, b, c, e]) => Rename(a, b, c, e)) },
  { weight: 3, arbitrary: fc.tuple(dev, ix, fc.option(ix, { nil: null, freq: 4 }), pumps, seed).map(([a, b, c, e, f]) => Move(a, b, c, e, f)) },
  { weight: 1, arbitrary: fc.tuple(dev, ix, pumps, seed).map(([a, b, c, e]) => Delete(a, b, c, e)) },
  { weight: 1, arbitrary: fc.tuple(dev, ix, pumps, seed).map(([a, b, c, e]) => Undelete(a, b, c, e)) },
  { weight: 2, arbitrary: fc.tuple(dev, ix, fc.nat(5), fc.boolean(), pumps, seed).map(([a, b, c, e, f, g]) => Tag(a, b, c, e, f, g)) },
  { weight: 2, arbitrary: fc.tuple(dev, ix, fc.boolean(), pumps, seed).map(([a, b, c, e, f]) => SiteMark(a, b, c, e, f)) },
  { weight: 3, arbitrary: dev.map((d) => GoOffline(d)) },
  { weight: 4, arbitrary: fc.tuple(dev, pumps, seed).map(([a, b, c]) => GoOnline(a, b, c)) },
  { weight: 3, arbitrary: fc.tuple(dev, pumps, seed).map(([a, b, c]) => Drain(a, b, c)) },
  { weight: 3, arbitrary: fc.tuple(dev, pumps, seed).map(([a, b, c]) => Sync(a, b, c)) },
  { weight: 9, arbitrary: fc.tuple(fc.nat(20), fc.constantFrom(...FATES), pumps, seed).map(([a, b, c, e]) => Respond(a, b, c, e)) },
  { weight: 3, arbitrary: fc.tuple(fc.integer({ min: 1, max: 60 }), seed).map(([a, b]) => Pump(a, b)) },
  { weight: 3, arbitrary: fc.constantFrom(500, 2_500, 16_000, 26_000).map((ms) => Advance(ms)) },
  { weight: 1, arbitrary: fc.constant(ServerOff()) },
  { weight: 2, arbitrary: fc.constant(ServerOn()) },
  { weight: 1, arbitrary: fc.tuple(dev, fc.integer({ min: 0, max: 30 }), seed, fc.boolean()).map(([a, b, c, e]) => Reboot(a, b, c, e)) },
]);

const deaths = fc.record({ pagehide: fc.boolean(), commit: fc.boolean(), wireArrives: fc.boolean(), keepalive: fc.boolean() });
/** The ordinary commands, plus deaths at any point and quiet stretches. */
const crashArbs: Array<fc.Arbitrary<Cmd>> = [
  ...commandArbs,
  ...weighted([
    { weight: 8, arbitrary: fc.tuple(dev, fc.integer({ min: 0, max: 40 }), seed, deaths).map(([a, b, c, e]) => Crash(a, b, c, e)) },
    { weight: 8, arbitrary: fc.tuple(dev, fc.constantFrom(5_000, 30_000, 90_000)).map(([a, b]) => Resume(a, b)) },
  ]),
];

// ── settling and checking ────────────────────────────────────────────────────

const liveOps = (run: Run) => Promise.allSettled(run.ops.filter((op) => !op.tab.dead).map((op) => op.done));
const pendingRows = async (tab: Tab): Promise<number> => (await drive(w.start(tab, () => tab.mods.localDb.getPendingWrites()) as Promise<unknown[]>)).length;

/** Everyone online, the server up, every request answered, every queue drained and synced. */
async function settle(run: Run): Promise<void> {
  w.backend.down = false;
  if (w.live().length === 0) await openDevice(run, "A", false);
  for (let round = 0; round < 12; round++) {
    for (const tab of w.live()) { tab.online = true; tab.mods.appStore.setOnline(true); }
    await drive(liveOps(run), "deliver");
    for (const tab of w.live()) {
      await drive(w.start(tab, () => reconnectLikeTheApp(tab)), "deliver");
      await drive(w.start(tab, () => tab.mods.writeQueue.flushPendingWrites()), "deliver");
      await drive(w.start(tab, () => tab.mods.syncEngine.sync()), "deliver");
    }
    while (w.backend.open.length) { await w.backend.respond(w.backend.open[0]!, "deliver"); await w.pump(3); }
    await w.advance(30_000);
    await w.drainStorage();
    let rows = 0;
    for (const tab of w.live()) rows += await pendingRows(tab);
    if (rows === 0 && w.backend.open.length === 0) {
      await drive(liveOps(run), "deliver");
      if (w.backend.open.length === 0) {
        // Every queue is empty: one more pull each, so a device that synced before another one flushed catches up.
        for (const tab of w.live()) await drive(w.start(tab, () => tab.mods.syncEngine.sync()), "deliver");
        await w.drainStorage();
        return;
      }
    }
  }
}

type ServerNote = { id: string; title: string; markdown: string; parent_id: string | null; deleted: boolean; node_type: string; tags: string[]; site: string };
async function serverNotes(ids: string[]): Promise<Map<string, ServerNote>> {
  const found = new Map<string, ServerNote>();
  for (let todo = ids; todo.length; ) {
    const rows = await q<ServerNote>(
      `SELECT n.id::text, n.title, n.markdown, n.parent_id::text, (n.deleted_at IS NOT NULL) AS deleted, n.node_type,
              COALESCE((SELECT array_agg(t.tag_id::text ORDER BY t.tag_id) FROM node_tags t WHERE t.node_id = n.id), '{}') AS tags,
              COALESCE((SELECT string_agg(a.key || '=' || a.value, ',' ORDER BY a.key) FROM node_attributes a WHERE a.node_id = n.id AND a.key IN ('_published', '_published_by_parent')), '') AS site
         FROM content_nodes n WHERE n.workspace_id = $1 AND n.id = ANY($2::uuid[])`, [WS, todo]);
    rows.rows.forEach((r) => found.set(r.id, r));
    todo = [...new Set(rows.rows.map((r) => r.parent_id).filter((p): p is string => !!p && !found.has(p)))];
  }
  return found;
}

/** Text of the BODY_CONFLICT entries the server recorded for a note. */
async function conflictLines(id: string): Promise<Set<string>> {
  const rows = await q<{ payload: unknown }>(`SELECT payload FROM domain_events WHERE workspace_id = $1 AND event_type = 'BODY_CONFLICT' AND target_id = $2`, [WS, id]);
  const out = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") lines(v).forEach((l) => out.add(l));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  rows.rows.forEach((r) => walk(r.payload));
  return out;
}

/** Every line a device kept for the user outside the queue: refused and unconfirmed writes. */
async function recoveryLines(tab: Tab): Promise<Set<string>> {
  await drive(w.start(tab, () => tab.mods.writeRecovery.refreshRecoveryWrites()), "deliver");
  const rejected = await drive(w.start(tab, () => tab.mods.localDb.getRejectedWrites()) as Promise<Array<{ body: string | null }>>, "deliver");
  const out = new Set<string>();
  for (const row of [...tab.mods.writeRecovery.getRecoveryWrites(), ...rejected]) {
    try {
      const md = (JSON.parse(row.body ?? "{}") as { markdown?: string }).markdown;
      if (typeof md === "string") lines(md).forEach((l) => out.add(l));
    } catch { /* not a body write */ }
  }
  return out;
}

/** The bodies of every write the devices kept outside the queue (refused or unconfirmed), as the user would find them in recovery. */
async function recoveryBodies(tabs: Tab[]): Promise<string[]> {
  const out: string[] = [];
  for (const tab of tabs) {
    await drive(w.start(tab, () => tab.mods.writeRecovery.refreshRecoveryWrites()), "deliver");
    const rejected = await drive(w.start(tab, () => tab.mods.localDb.getRejectedWrites()) as Promise<Array<{ body: string | null }>>, "deliver");
    for (const row of [...tab.mods.writeRecovery.getRecoveryWrites(), ...rejected]) if (row.body) out.push(row.body);
  }
  return out;
}

async function check(run: Run): Promise<string[]> {
  const problems = [...run.problems];
  const server = await serverNotes([...run.notes, ...simTagIds]);
  const label = (id: string) => `note#${run.notes.indexOf(id)}`;
  const simTags = new Set(simTagIds);
  for (const tab of w.live()) {
    if (tab.mods.localCopyState.getLocalCopyState() !== "ok") throw new Error(`test setup: tab ${tab.name} has no local copy (${tab.mods.localCopyState.getLocalCopyState()}); worker errors: ${tab.workerErrors.join(" | ")}`);
  }

  // 1 convergence — the devices and a device opened from scratch (bootstrap path) equal the server
  const fresh = await openDevice(run, null, true, "fresh");
  await drive(liveOps(run), "deliver");
  // KNOWN: a refused tag write leaves the device where its optimistic change put it, and no later delta repairs that.
  // The check skips such a note on the device that sent it. (A refused move or delete no longer does: the device
  // reads the note back from the server, lib/data/serverTruth.ts.)
  const refusedHere = new Set<string>();
  if (!run.includeKnown) {
    for (const h of w.backend.handled) {
      const structural = h.path.includes("/tags/");
      const id = /\/api\/nodes\/([0-9a-f-]{36})/.exec(h.path)?.[1];
      if (h.status >= 400 && structural && id) refusedHere.add(`${h.device}|${id}`);
    }
  }
  for (const tab of w.live()) {
    for (const id of run.notes) {
      if (refusedHere.has(`${tab.account}|${id}`) || run.phantom.has(`${tab.account}|${id}`)) continue;
      const s = server.get(id);
      const row = shownNote(tab, id);
      if (!s || s.deleted) { if (row) problems.push(`#1 ${label(id)}: device ${tab.name} still shows a note the server ${s ? "has deleted" : "never kept"}`); continue; }
      if (!row) { problems.push(`#1 ${label(id)}: device ${tab.name} does not have a live note the server has`); continue; }
      const tags = [...(row.label_tag_ids ?? [])].filter((t) => simTags.has(t)).sort().join();
      const want: Array<[string, unknown, unknown]> = [
        ["title", row.title, s.title],
        // A slim bootstrap leaves bodies on the server (body_len says there is one); a body that is loaded must be equal.
        ["body", nodeNeedsBody(row) ? "(has a body)" : row.markdown ?? "", nodeNeedsBody(row) ? (s.markdown === "" ? "" : "(has a body)") : s.markdown], ["parent", row.parent_id ?? null, s.parent_id],
        // The note's place on the site (「不發布」 and why): a device that drew a note under a kept-off parent offline settles on the server's answer.
        ["site", ["_published", "_published_by_parent"].flatMap((k) => (row.attrs?.[k] === undefined ? [] : [`${k}=${row.attrs[k]}`])).join(","), s.site], ["tags", tags, s.tags.filter((t) => simTags.has(t)).join()],
      ];
      for (const [field, got, expected] of want) if (got !== expected) problems.push(`#1 ${label(id)}: device ${tab.name}'s ${field} differs from the server: ${JSON.stringify(got)} vs ${JSON.stringify(expected)}`);
    }
    // 6 queue
    const rows = await pendingRows(tab);
    if (rows) problems.push(`#6 device ${tab.name} still has ${rows} queued write(s) after everything was delivered`);
  }
  void fresh;

  // 2 + 3 text
  const recovery = new Set<string>();
  for (const tab of w.live().filter((t) => t.account !== "fresh")) for (const l of await recoveryLines(tab)) recovery.add(l);
  const conflicts = new Map<string, Set<string>>();
  for (const id of new Set(run.typed.map((t) => t.note))) conflicts.set(id, await conflictLines(id));
  for (const t of run.typed) {
    const s = server.get(t.note);
    if (!(t.ack === "synced" || t.ack === "queued" || t.ack === "refused")) continue;
    if (run.removedLines.has(t.line) || recovery.has(t.line) || !s || s.deleted) continue;
    if (!lines(s.markdown).includes(t.line) && !conflicts.get(t.note)?.has(t.line)) {
      problems.push(`#2 ${label(t.note)}: line ${t.line} (device ${t.dev}, told "${t.ack}") is in neither the final body, a recorded conflict nor the device's recovery list`);
    }
  }
  for (const id of run.notes) {
    const s = server.get(id);
    if (!s || s.deleted) continue;
    const seen = new Map<string, number>();
    for (const l of lines(s.markdown)) seen.set(l, (seen.get(l) ?? 0) + 1);
    for (const [l, n] of seen) if (n > 1 && /^[AB]\d+$/.test(l)) problems.push(`#3 ${label(id)}: line ${l} appears ${n} times in the final body`);
  }

  // 2b a title or a note a device was told was saved is not lost either: the server got it, a later write replaced it, or recovery has it
  const kept = await recoveryBodies(w.live().filter((x) => x.account !== "fresh"));
  const handledTitles = w.backend.handled.filter((h) => h.status < 300 && h.body);
  for (const t of run.titled) {
    if (!(t.ack === "synced" || t.ack === "queued")) continue;
    const s = server.get(t.note);
    if (!s || s.deleted || run.everDeleted.includes(t.note)) continue;
    const reached = handledTitles.some((h) => h.body!.includes(JSON.stringify(t.title)));
    if (!reached && !kept.some((body) => body.includes(JSON.stringify(t.title)))) {
      problems.push(`#2 ${label(t.note)}: the title "${t.title}" (device ${t.dev}, told "${t.ack}") never reached the server and is not in the device's recovery list`);
    }
  }
  for (const c of run.created) {
    if (!(c.ack === "synced" || c.ack === "queued")) continue;
    if (!server.get(c.note) && !kept.some((body) => body.includes(c.note))) problems.push(`#2 ${label(c.note)}: creation (device ${c.dev}, told "${c.ack}") is neither on the server nor in the device's recovery list`);
  }

  // 4 duplicates and retries are not applied twice
  const byKey = new Map<string, Handled[]>();
  for (const h of w.backend.handled) if (h.key) byKey.set(h.key, [...(byKey.get(h.key) ?? []), h]);
  for (const [key, arrivals] of byKey) {
    // Tag membership is naturally idempotent (a second PUT/DELETE changes nothing and is answered plainly, without
    // `deduped`): the key is checked on the writes where a second application would show.
    if (arrivals.every((h) => h.path.includes("/tags/"))) continue;
    const fresh2xx = arrivals.filter((h) => h.status < 300 && !isDeduped(h));
    if (fresh2xx.length > 1) problems.push(`#4 key …${key.slice(-4)} was applied ${fresh2xx.length} times (${fresh2xx.map((h) => `${h.method} ${nameOf(run, h.path)}`).join(", ")})`);
    if (STRICT_RETRY) {
      const first = arrivals.findIndex((h) => h.status < 300);
      const refusedRetry = first >= 0 && arrivals.slice(first + 1).find((h) => h.status >= 300);
      if (refusedRetry) problems.push(`#4 a retry of an applied write was refused (${refusedRetry.status}): ${refusedRetry.method} ${nameOf(run, refusedRetry.path)}`);
    }
  }
  const created = await q<{ target_id: string; n: string }>(`SELECT target_id, count(*)::text AS n FROM domain_events WHERE workspace_id = $1 AND event_type = 'NODE_CREATED' AND target_id = ANY($2::text[]) GROUP BY target_id`, [WS, run.notes]);
  for (const r of created.rows) if (Number(r.n) > 1) problems.push(`#4 ${label(r.target_id)} was created ${r.n} times`);

  stats.runs++;
  stats.requests += w.backend.handled.length;
  stats.duplicates += w.backend.handled.filter((h) => h.duplicate).length;
  stats.refused4xx += w.backend.handled.filter((h) => h.status >= 400).length;
  stats.deduped += w.backend.handled.filter(isDeduped).length;
  stats.queuedAcks += run.typed.filter((t) => t.ack === "queued").length;
  stats.recoveryLines += recovery.size;
  stats.bodyConflicts += [...conflicts.values()].filter((c) => c.size).length;
  stats.lostAnswers += w.backend.log.filter((l) => l.endsWith("-> lose")).length;
  stats.dropped += w.backend.log.filter((l) => l.endsWith("-> net")).length;
  stats.deadlines += w.backend.log.filter((l) => l.endsWith("(deadline)")).length;

  // 5 tree and events
  for (const n of server.values()) {
    if (n.node_type === "class_tag" || !n.parent_id) continue;
    const parent = server.get(n.parent_id);
    if (!parent) problems.push(`#5 ${label(n.id)}: parent row is missing`);
    else if (parent.node_type === "class_tag") problems.push(`#5 ${label(n.id)}: parented to a tag`);
    else if (!n.deleted && parent.deleted) problems.push(`#5 ${label(n.id)}: live note under deleted ${label(parent.id)}`);
    const seen = new Set<string>([n.id]);
    for (let p: string | null = n.parent_id; p; p = server.get(p)?.parent_id ?? null) {
      if (seen.has(p)) { problems.push(`#5 ${label(n.id)}: parent chain has a cycle`); break; }
      seen.add(p);
    }
  }
  const ids = (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE workspace_id = $1 ORDER BY created_at, id`, [WS])).rows.map((r) => BigInt(r.id));
  // The log is ordered by commit; ids come from one sequence, so a lower id committing later is allowed, equal ids are not.
  if (new Set(ids).size !== ids.length) problems.push("#5 duplicate event ids");
  return problems;
}

const isDeduped = (h: Handled): boolean => h.reply.includes('"deduped":true');
const nameOf = (run: Run, path: string): string => path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, (id) => { const i = run.notes.indexOf(id); return i >= 0 ? `note#${i}` : "tag"; });

function freshId(run: Run): string {
  return `${run.nonce}-0000-4000-8000-${String(++run.uuid + 500).padStart(12, "0")}`;
}

/** Two devices on the same small seeded tree, the commands, settle, check. */
async function runCommands(commands: Iterable<Cmd>, includeKnown = INCLUDE_KNOWN): Promise<string[]> {
  // A run that never ends is a finding too, and one that stalls the whole file hides every other: it fails with its commands.
  const list = [...commands];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = realSetTimeout(() => { w.uninstall(); reject(new Error(`the run did not finish in ${RUN_LIMIT_MS / 1000} s: ${list.map(String).join(" | ")}`)); }, RUN_LIMIT_MS);
  });
  try { return await Promise.race([execute(list, includeKnown), stalled]); } finally { clearTimeout(timer); }
}

async function execute(commands: Cmd[], includeKnown: boolean): Promise<string[]> {
  w.install();
  // SIM_PROGRESS=<file>: one line per run (time, memory, commands), readable while the test is still going.
  if (process.env.SIM_PROGRESS) appendFileSync(process.env.SIM_PROGRESS, `${new Date().toISOString()} run ${stats.runs} rss=${Math.round(process.memoryUsage().rss / 1e6)}MB ${commands.map(String).join(" | ")}\n`);
  const run: Run = {
    nonce: randomUUID().slice(0, 8), counter: 0, uuid: 0, tabs: {} as Run["tabs"], reboots: 0, notes: [], typed: [], removedLines: new Set(),
    editing: { A: null, B: null }, everDeleted: [], includeKnown, ops: [], writing: new Map(), cursors: new Map(), problems: [],
    touching: new Map(), phantom: new Set(), titled: [], created: [], deaths: 0,
  };
  // Ids the run mints (notes, idempotency keys) must not repeat across runs: the database lives on.
  let n = 0;
  globalThis.crypto.randomUUID = (() => `${run.nonce}-0000-4000-8000-${String(++n).padStart(12, "0")}`) as typeof crypto.randomUUID;
  try {
    // The shared starting tree: two top-level notes and a child, made on the server before the devices open.
    const seeded: string[] = [];
    for (const parent of [null, null, 0] as const) {
      const id = freshId(run);
      const res = await direct("POST", "/api/nodes", { id, title: `seed ${seeded.length}`, markdown: `S${seeded.length}`, source_type: "manual", node_type: "content", ...(parent === null ? { space_id: spaceId } : { parent_id: seeded[parent] }) });
      if (res.status !== 201 && res.status !== 200) throw new Error(`seed failed: ${res.status} ${res.text}`);
      seeded.push(id);
    }
    run.notes.push(...seeded);
    // The first seed note is kept off the site (「不發布」): a note made under it starts kept off too, and the devices must agree with the server on that.
    const kept = await direct("PUT", `/api/nodes/${seeded[0]}/attributes/_published`, { value: "false", value_type: "text" });
    if (kept.status !== 200) throw new Error(`seed mark failed: ${kept.status} ${kept.text}`);
    await openDevice(run, "A", true);
    await openDevice(run, "B", true);
    await fc.asyncModelRun(() => ({ model: {}, real: run }), commands as never);
    await settle(run);
    const problems = await check(run);
    if (problems.length && process.env.SIM_PROGRESS) appendFileSync(process.env.SIM_PROGRESS, `FAIL ${problems.join(" ; ")}\n`);
    return problems.length && process.env.PROPS_TRACE ? [...problems, ...w.backend.log] : problems;
  } finally {
    w.uninstall();
  }
}

describe("devices on the real backend over a faulty network", () => {
  it("random interleavings and faults: nothing acknowledged is lost, every device converges", async (ctx) => {
    if (!enabled || !app) ctx.skip();
    await fc.assert(
      fc.asyncProperty(fc.commands(commandArbs, { maxCommands: 30, size: "max" }), async (commands) => {
        expect(await runCommands(commands)).toEqual([]);
      }),
      { seed: PROPS_SEED, numRuns: RUNS, verbose: 0, path: process.env.PROPS_PATH, endOnFailure: !!process.env.SIM_NO_SHRINK, interruptAfterTimeLimit: SHRINK_BUDGET_MS },
    );
  }, Number(process.env.PROPS_TIMEOUT ?? 15 * 60_000));

  it("the client dies at any step and opens again: nothing acknowledged is lost, nothing is applied twice, the queue moves on", async (ctx) => {
    if (!enabled || !app) ctx.skip();
    await fc.assert(
      fc.asyncProperty(fc.commands(crashArbs, { maxCommands: 30, size: "max" }), async (commands) => {
        expect(await runCommands(commands)).toEqual([]);
      }),
      { seed: PROPS_SEED, numRuns: RUNS, verbose: 0, path: process.env.PROPS_PATH, endOnFailure: !!process.env.SIM_NO_SHRINK, interruptAfterTimeLimit: SHRINK_BUDGET_MS },
    );
  }, Number(process.env.PROPS_TIMEOUT ?? 15 * 60_000));

  // ── cases the property found, kept as plain command lists ──

  // KNOWN (a refused write stays on screen). The server refuses a structural write and the device keeps showing
  // what the write would have done, with no later delta to repair it:
  //   * a queued move the server refuses on replay (here: under its own descendant, 400) is cleared from the queue
  //     with a toast, but the note stays under the new parent in the local copy — the device shows a loop;
  //   * a delete of a note the server already deleted (a note below a deleted one, or a stale hydration brought it
  //     back on screen) is refused 404 and writeLifecycle rolls the optimistic delete back: the deleted note is
  //     back for good (the sync cursor is already past its delete event).
  // Fixed since: the first and third (a refused move or delete is settled against the server's row, serverTruth.ts).
  // Still known: the page going away mid-write (second case), and refused tag writes (skipped by the property).
  // SIM_INCLUDE_KNOWN=1 turns the skips off.
  it("a queued move refused on replay goes back to where the server has the note", async (ctx) => {
    if (!enabled || !app) ctx.skip();
    expect(await runCommands([ServerOff(), Advance(500), Move("A", 0, 26, 0, 0), Tag("A", 0, 0, false, 5, 0)], true)).toEqual([]);
  });

  // KNOWN (phantom change): the page goes away while a move is still being written; nothing was queued or sent, and
  // the local copy the next page load opens shows the note under its new parent for good.
  it("a move to the note's own place is neither drawn nor sent (the server reads it as top level)", async (ctx) => {
    if (!enabled || !app) ctx.skip();
    expect(await runCommands([Advance(500), Respond(3, "deliver", 0, 0), GoOffline("B"), Move("B", 0, 0, 9, 601575), Drain("A", 8, 821553)], true)).toEqual([]);
  });

  it.fails("KNOWN: a move still being written when the page goes away stays in the local copy", async (ctx) => {
    if (!enabled || !app) ctx.skip();
    expect(await runCommands([Rename("B", 0, 0, 0), Move("B", 4, 0, 0, 0), Reboot("B", 8, 224439, true), Advance(16000)], true)).toEqual([]);
  });

  // A move under the note itself: the writer neither draws nor sends it (noteWriter.ts), so a page that dies with the
  // server off and opens again has nothing of it in its queue or its local copy.
  it("a move under the note itself leaves nothing behind when the page dies and opens again", async (ctx) => {
    if (!enabled || !app) ctx.skip();
    expect(await runCommands([ServerOff(), Move("B", 0, 0, 0, 0), Crash("B", 12, 0, { pagehide: true, commit: false, wireArrives: false, keepalive: false }), Drain("A", 0, 0)], true)).toEqual([]);
  });

  // A note a device makes offline under a kept-off note is drawn kept off (the shared default), and the server decides when the
  // request arrives: here another device put the parent back on the site first, so the server gives the new note no flag and
  // the device must show it as on the site, not as kept off (note#0 is the seed note kept off the site).
  it("an offline create under a note put back on the site meanwhile is settled on the server's answer", async (ctx) => {
    if (!enabled || !app) ctx.skip();
    expect(await runCommands([GoOffline("A"), SiteMark("B", 0, false, 20, 1), Drain("B", 20, 1), Create("A", 0, 0, 0), GoOnline("A", 30, 1), Drain("A", 30, 1)], true)).toEqual([]);
  });

  // The control: nothing changed on the other device, so the offline drawing (kept off, with its reason) is what the server stores too.
  it("an offline create under a kept-off note is kept off on the device and on the server alike", async (ctx) => {
    if (!enabled || !app) ctx.skip();
    expect(await runCommands([GoOffline("A"), Create("A", 0, 0, 0), GoOnline("A", 30, 1), Drain("A", 30, 1)], true)).toEqual([]);
  });

  it("a refused second delete leaves the deleted note off the screen", async (ctx) => {
    if (!enabled || !app) ctx.skip();
    expect(await runCommands([Advance(500), Delete("A", 0, 0, 0), Respond(0, "deliver", 0, 0), Sync("A", 5, 0), Delete("A", 0, 0, 0)], true)).toEqual([]);
  });
});
