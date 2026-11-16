// @vitest-environment jsdom
// Metamorphic tests of the app's search ASSEMBLY — `searchNotes` (lib/data/noteSearch.ts, what reads.notes.search is) —
// and of this device's own index, on a browser-version device: the real client stack (localDb → sql.js worker, the
// page mirror in the app store, syncEngine) against the real backend on its portable engine (PGlite / ILIKE), which is
// what the browser version runs. The relations are the ones of the engine tests (backend
// searchPrefix.metamorphic.integration.test.ts; corpus and relations: @onden/markdown helpers/searchMetamorphic.ts):
//
//   MR-S1  a shorter query finds at least what the longer one found (every prefix, down to ONE grapheme)
//   MR-S2  a one-grapheme query's answer depends on what the text holds, not on the grapheme's class
//   MR-S3  typo-tolerant rows appear only when there is no exact row
//
// Each engine can be right while the assembly is wrong: `searchNotes` sends a query to this device's copy when
// `query.trim().length < 2` (UTF-16 units) and to the server otherwise; the backend route answers `[]` when the raw
// query is shorter than 2; and the local mirror holds bodies only once they have been fetched. A prefix walk crosses
// that boundary, and so does a one-grapheme query that is two UTF-16 units long (a Han character of Extension B, an
// emoji, a letter with a combining accent).
//
// Rows are tagged by where they came from, so only exact rows are compared: "fuzzy" is a row with `titleRanges` (only
// the typo-tolerant path sets it); a row is "server" when the wire carried a /api/nodes/search for the query and the
// reply held its id, otherwise "local".
//
// The device: a cold start on an empty browser profile (slim bootstrap, then the full bodies at the next idle slot,
// as the app does). "Settled" waits for that — the wire is answered and time advances until every body is in the
// local copy — and the world refuses to go on if a body is still missing (that would be a flaky test, not a finding).
// The "first paint" device is the same boot stopped right after the slim bootstrap, bodies not yet downloaded.
//
// Differential (ordinary properties, next to the metamorphic ones): the server's engine and this device's index
// answer the same exact set for the same query, except for the differences listed in DIFFERENCES, and the table is
// exactly what differs (each row's example really differs; nothing else does).
//
// Needs a database whose name ends in _test (PGlite or Postgres), as syncFaultSimulation.integration.property.test.ts;
// without it the file skips. The on-device engine on its own (no backend) is searchPrefixLocal.metamorphic.test.ts.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let WS = "";
let USER: { id: string; email: string; name: string } | null = null;
const ORIGIN = "http://localhost";
vi.mock("../../../../backend/src/db", async (original) => ({ ...await original<Record<string, unknown>>(), getWorkspaceId: async () => WS }));
vi.mock("../../../../backend/src/auth", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => (USER ? { user: USER } : null)) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
}));

import fc from "fast-check";
import { CLIENT_PROTOCOL, CLIENT_PROTOCOL_HEADER } from "@onden/markdown";
import { metamorphic } from "../../../../markdown/src/test/helpers/metamorphic.js";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";
import {
  prefixCases, shorterFindsAtLeastWhatLongerFound, oneGraphemeIgnoresItsClass, fuzzyOnlyWithoutExact, withSwap, newCoverage, describeCoverage,
  graphemesOf, spelled, GRAPHEME_CLASSES, SPELLED_TWO_WAYS, type SearchNote, type SearchWorld, type PrefixCase, type FoundRow,
} from "../../../../markdown/src/test/helpers/searchMetamorphic.js";
import { RealBackendWorld } from "../helpers/realBackendWorld";
import { tabContext, type Tab } from "../helpers/tabWorld";

const DATABASE_URL = process.env.DATABASE_URL;
const enabled = /^postgres(ql)?:\/\/[^/]*\/[^/?]*_test(\?.*)?$/.test(DATABASE_URL ?? "") && /localhost|127\.0\.0\.1/.test(DATABASE_URL ?? "");
/** One case boots a whole device (about half a second alone, two under load): the runs are capped at this, whatever PROPS_RUNS says; the report prints "capped by maxRuns". */
const MAX_RUNS = 150;
const TIMEOUT = 60 * 60_000;
const realSetTimeout = globalThis.setTimeout;

type App = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
type Query = <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
type Actor = { id: string };
// Not `new URL(`…${file}.ts`, import.meta.url)`: Vite reads that as an asset URL and breaks on a file name with a slash.
const BACKEND_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../backend/src");
const backendPath = (file: string): string => `${BACKEND_SRC}/${file}.ts`;
const backend = <T,>(file: string): Promise<T> => import(/* @vite-ignore */ backendPath(file)) as Promise<T>;
let app: App | undefined;
let q: Query;
let serverSearch: (workspaceId: string, query: string, actor: Actor, limit: number) => Promise<Array<{ id: string }>>;
let sessionActor: (user: { id: string; email: string; name: string }, workspaceId: string) => Promise<Actor>;
let awaitAllDispatchers: () => Promise<void>;

beforeAll(async () => {
  if (!enabled) return;
  // The browser version's backend: portable engine (ILIKE), as in PGlite. (A real Postgres with pgroonga would otherwise pick pgroonga.)
  process.env.ONDEN_SEARCH_ENGINE = "portable";
  const db = await backend<{ q: Query; migrate: () => Promise<void> }>("db");
  q = db.q;
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
  if (!present) return;
  app = (await backend<{ app: App }>("app")).app;
  serverSearch = (await backend<{ searchNodes: typeof serverSearch }>("services/nodeSearch")).searchNodes;
  sessionActor = (await backend<{ actorForSession: typeof sessionActor }>("services/actors")).actorForSession;
  awaitAllDispatchers = (await backend<{ awaitAllDispatchers: () => Promise<void> }>("services/dispatcherQueue")).awaitAllDispatchers;
  await (await import("sql.js")).default();
}, 120_000);
afterAll(async () => {
  if (enabled && app) await (await backend<{ pool: { end(): Promise<void> } }>("db")).pool.end().catch(() => {});
});

async function direct(method: string, path: string, json?: unknown): Promise<{ status: number; text: string }> {
  const headers = { origin: ORIGIN, "X-Onden-Expected-User": USER!.id, [CLIENT_PROTOCOL_HEADER]: String(CLIENT_PROTOCOL), ...(json !== undefined ? { "content-type": "application/json" } : {}) };
  const res = await app!.request(path, { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined });
  return { status: res.status, text: await res.text() };
}

const macrotask = () => new Promise<void>((resolve) => setImmediate(resolve));
const realDelay = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

/** Run the device until `promise` settles: storage requests complete, the wire is answered, time moves when nothing else can. */
async function drive<T>(w: RealBackendWorld, promise: Promise<T>): Promise<T> {
  let settled = false;
  let idle = 0;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let step = 0; step < 4000; step++) {
    await macrotask();
    if (settled) return promise;
    const stored = w.idb.io.shift();
    if (stored) { tabContext.run(stored.tab as Tab, stored.run); continue; }
    await macrotask();
    if (settled) return promise;
    if (w.idb.io.length) continue;
    const open = w.backend.inflight[0];
    if (open) { await w.backend.respond(open, "deliver"); idle = 0; continue; }
    if (++idle < 4) { await realDelay(1); continue; }
    idle = 0;
    await vi.advanceTimersByTimeAsync(1000);
  }
  throw new Error("drive: the operation never finished");
}

// ── the browser-version device ───────────────────────────────────────────────

type Device = SearchWorld & {
  w: RealBackendWorld;
  /** The server's engine behind the route, asked as the route's service (no 2-character rule). */
  serverEngine(query: string): Promise<number[]>;
  /** This device's own index (localCopy.search) over the mirror the boot filled. */
  localEngine(query: string): Promise<number[]>;
  /** Whether the query went to the wire. */
  asked(query: string): Promise<boolean>;
  bodiesInMirror(): Promise<number>;
};

/** `settled`: wait for the bodies (the world checks they are all in the local copy). Otherwise stop right after the first paint. */
async function openDevice(notes: SearchNote[], { settled }: { settled: boolean }): Promise<Device> {
  WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Search prefix metamorphic', $1) RETURNING id::text`, [`mr-search-${randomUUID()}`])).rows[0]!.id;
  USER = { id: `user-${randomUUID()}`, email: `owner-${randomUUID()}@example.test`, name: "Owner" };
  // The first person to sign in to an empty workspace is its owner.
  const first = await direct("GET", "/api/bootstrap?bodies=none");
  if (first.status !== 200) throw new Error(`sign-in failed: ${first.status} ${first.text}`);
  const spaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [WS])).rows[0]!.id;
  const ids: string[] = notes.map(() => randomUUID());
  for (const [at, note] of notes.entries()) {
    const made = await direct("POST", "/api/nodes", { id: ids[at], title: note.title, markdown: note.body, source_type: "manual", node_type: "content", space_id: spaceId });
    if (made.status !== 201) throw new Error(`creating note ${at} failed: ${made.status} ${made.text}`);
  }
  // What a save starts after it answers (derived work) must be done before anything is searched.
  await awaitAllDispatchers();
  const actor = await sessionActor(USER, WS);
  const w = new RealBackendWorld(app!, { userId: USER.id, origin: ORIGIN });
  w.install();
  const tab = await w.createTab("device", `dev-${USER.id}`);
  // Imported in the tab's registry (createTab ended with its modules; nothing has reset the registry since).
  // The app registers its modules when it loads; a workspace that lists its modules asks that registry (shellFeatures).
  await import("../../modules");
  const { searchNotes } = await import("../../lib/data/noteSearch");
  const run = <T,>(fn: () => Promise<T>): Promise<T> => drive(w, tabContext.run(tab, fn));
  await run(() => tab.mods.syncEngine.boot());
  const mirrorBodies = async (): Promise<number> => {
    let have = 0;
    for (const [at, note] of notes.entries()) {
      const stored = await run(() => tab.mods.localDb.getStoredBody(ids[at]!));
      if ((stored ?? "") === note.body && (note.body !== "" || stored !== null)) have++;
    }
    return have;
  };
  if (settled) {
    // The idle slot (1.2 s of page time) fetches the bodies; the offline download follows. Time passes while the wire is answered.
    await run(() => new Promise<void>((resolve) => setTimeout(resolve, 30_000)));
    const have = await mirrorBodies();
    const held = tab.mods.appStore.getAppState().data.nodes.filter((n) => ids.includes(n.id)).length;
    if (have !== notes.length || held !== notes.length) throw new Error(`the world is not settled: ${have} of ${notes.length} bodies in the local copy, ${held} notes in the page mirror`);
  }
  const indexOf = (id: string): number => ids.indexOf(id);
  const device: Device = {
    w,
    async search(query) {
      const before = w.backend.handled.length;
      const outcome = await run(() => searchNotes(query));
      const wire = w.backend.handled.slice(before).filter((h) => h.path.startsWith("/api/nodes/search"));
      const fromServer = new Set<string>(wire.flatMap((h) => (h.status === 200 ? (JSON.parse(h.reply) as Array<{ id: string }>).map((row) => row.id) : [])));
      return outcome.rows.flatMap((row): FoundRow[] => {
        const index = indexOf(row.id);
        if (index < 0) return [];
        return [{ index, source: "titleRanges" in row ? "fuzzy" : fromServer.has(row.id) ? "server" : "local" }];
      });
    },
    async asked(query) {
      const before = w.backend.handled.length;
      await run(() => searchNotes(query));
      return w.backend.handled.slice(before).some((h) => h.path.startsWith("/api/nodes/search"));
    },
    async serverEngine(query) { return (await serverSearch(WS, query, actor, 30)).map((hit) => indexOf(hit.id)).filter((at) => at >= 0).sort((a, b) => a - b); },
    async localEngine(query) { return (await run(() => tab.mods.localDb.searchNodes(query))).map((hit) => indexOf(hit.id)).filter((at) => at >= 0).sort((a, b) => a - b); },
    bodiesInMirror: mirrorBodies,
  };
  return device;
}
const closeDevice = (device: Device): void => { device.w.uninstall(); };

const NFC_DECOMPOSED = "decomposed text: the portable engine does not fold NFC/NFD (documented)";
const isDecomposed = (text: string): boolean => text !== text.normalize("NFC");
/** The device's own index finds both spellings of a grapheme that has two (NFC / NFD), the server's does not (the differential below). */
const FOLDS = "the grapheme has an NFC and an NFD spelling, and the device's index finds both (documented)";
const GRAPHEMES_WITH_ONE_SPELLING = GRAPHEME_CLASSES.filter((name) => !SPELLED_TWO_WAYS.includes(name));
const hasOtherSpelling = (grapheme: string): boolean => grapheme.normalize("NFC") !== grapheme.normalize("NFD");

describe.skipIf(!enabled)("the app's one search on a browser-version device", () => {
  it("MR-S1 routing (searchNotes, settled device): a shorter query finds at least what the longer one found", async () => {
    const coverage = newCoverage();
    await metamorphic({
      name: "MR-S1 routing (d)", source: prefixCases(),
      setup: (input: PrefixCase) => openDevice(input.notes, { settled: true }), teardown: closeDevice,
      relation: (world, input) => shorterFindsAtLeastWhatLongerFound(world, input, { coverage, whyNothing: (fragment) => (isDecomposed(fragment) ? NFC_DECOMPOSED : null) }),
      minCompared: 0.6, skipShare: { [NFC_DECOMPOSED]: 0.3, "the whole fragment found nothing": 0.03 }, maxRuns: MAX_RUNS,
    });
    process.stdout.write(`${describeCoverage(coverage)}\n`);
    expect(coverage.bodyOnlyExpected, "the runs must have asked one-grapheme queries that only a body match can answer").toBeGreaterThan(0);
  }, TIMEOUT);

  it("MR-S2 routing (settled device): a one-grapheme query does not depend on the grapheme's class", async () => {
    await metamorphic({
      name: "MR-S2 routing (d)", source: prefixCases({ swapFrom: GRAPHEMES_WITH_ONE_SPELLING }),
      setup: (input: PrefixCase) => openDevice([...input.notes, ...withSwap(input.notes, input.fragment[0]!, input.swap)], { settled: true }), teardown: closeDevice,
      relation: (world, input) => oneGraphemeIgnoresItsClass(world, input, { untypable: (g) => (hasOtherSpelling(g) ? FOLDS : null) }),
      minCompared: 0.6, skipShare: { [FOLDS]: 0.4, "the swap grapheme is already in the corpus": 0.02, "neither grapheme was found": 0.1 }, maxRuns: MAX_RUNS,
    });
  }, TIMEOUT);

  it("MR-S3 routing: typo-tolerant rows appear only when there is no exact row", async () => {
    await metamorphic({
      name: "MR-S3 routing (d)", source: prefixCases(),
      setup: (input: PrefixCase) => openDevice(input.notes, { settled: true }), teardown: closeDevice,
      relation: (world, input) => fuzzyOnlyWithoutExact(world, input),
      minCompared: 1, skipShare: {}, maxRuns: MAX_RUNS,
    });
  }, TIMEOUT);

  // ── fixed cases ──

  /** One walk (MR-S1) over a fixed corpus, on a device that is settled or has only painted. */
  async function walk(notes: SearchNote[], fragment: string, settled: boolean): Promise<void> {
    const device = await openDevice(notes, { settled });
    try {
      const verdict = await shorterFindsAtLeastWhatLongerFound(device, { notes, fragment: graphemesOf(fragment), home: { note: 0, field: "body" }, swap: "嗨" });
      if (verdict !== null) throw new Error(typeof verdict === "string" ? verdict : `skipped: ${verdict.skipped}`);
    } finally { closeDevice(device); }
  }

  it("a Han character found only in a body is found by the one-character query once the device holds the bodies", async () => {
    await walk([{ title: "筆記", body: "日本書館" }, { title: "咖啡", body: "x" }], "日本書館", true);
  }, TIMEOUT);

  // KNOWN OPEN — the broken relation: on a device that has painted but not yet downloaded the bodies, a one-character query
  // (this device's copy, titles only) finds fewer notes than the two-character query the server answers.
  // Shrunk from the random walk (PROPS_SEED=20261023): notes [{title:"筆",body:"ㄅㄅㄅ"},{title:"筆",body:""}], fragment ㄅㄅㄅ.
  // Cause (verified by reading): noteSearch.ts `tooShortForServer` sends text under 2 UTF-16 units to localRows → localCopy.search,
  // whose LIKE fallback reads nodes.markdown (localDbWorker searchTitlesAndBodies), and the slim bootstrap stores no bodies until the
  // idle slot (syncEngine.ts boot: onIdle(hydrateFullBootstrap)) or downloadBodiesForOffline has run. The fix is one mechanism, after this.
  it.fails("KNOWN OPEN first paint: a one-character query finds a body-only note that the two-character query finds", async () => {
    await walk([{ title: "筆", body: "ㄅㄅㄅ" }, { title: "筆", body: "" }], "ㄅㄅㄅ", false);
  }, TIMEOUT);

  it("the same corpus, first paint: a query of two or more characters is the server's and finds the body-only note", async () => {
    const notes = [{ title: "筆", body: "ㄅㄅㄅ" }];
    const device = await openDevice(notes, { settled: false });
    try {
      expect(await device.bodiesInMirror(), "a first-paint device holds no body yet").toBe(0);
      expect(await device.search("ㄅㄅ")).toEqual([{ index: 0, source: "server" }]);
      expect(await device.search("ㄅ"), "one character: this device's copy, no body").toEqual([]);
    } finally { closeDevice(device); }
  }, TIMEOUT);

  // The result limit is its own behaviour (the random corpora stay under it so it cannot truncate them): both doors cut at 30.
  it("more matches than the limit: this device's index (one character) and the server (two) both answer 30", async () => {
    const notes = Array.from({ length: 35 }, (_, at) => ({ title: `n${at}`, body: "筆記" }));
    const device = await openDevice(notes, { settled: true });
    try {
      expect((await device.search("筆")).length).toBe(30);
      expect((await device.search("筆記")).length).toBe(30);
    } finally { closeDevice(device); }
  }, TIMEOUT);

  // ── differential: the server's engine and this device's index ──

  type Seen = { query: string; notes: SearchNote[]; server: number[]; local: number[] };
  type Difference = { id: string; reason: string; explains: (seen: Seen) => boolean; example: { notes: SearchNote[]; query: string } };
  const holds = (note: SearchNote, text: string): boolean => note.title.includes(text) || note.body.includes(text);
  /** Every difference the two engines have on a typable query, with the reason. The test below asserts the list is exactly what differs:
   *  nothing else differs, and each example really differs. (docs/architecture/portable-backend.md §4 lists the server side.) */
  const DIFFERENCES: Difference[] = [{
    id: "unicode-spellings",
    reason: "This device's index tries the query as typed, in NFC and in NFD (localDbWorker searchNodes); the server reads the query in NFC (parseSearchQuery) and ILIKE does not fold Unicode forms. A note spelled the other way is found here only.",
    explains: ({ query, notes, server, local }) => server.every((at) => local.includes(at))
      && local.filter((at) => !server.includes(at)).every((at) => !holds(notes[at]!, query.normalize("NFC")) && (holds(notes[at]!, query) || holds(notes[at]!, query.normalize("NFD")))),
    example: { notes: [{ title: "x", body: "e\u0301" }], query: "e\u0301" },
  }];

  it("the server's engine and this device's index answer the same exact set, except for DIFFERENCES", async () => {
    let compared = 0, differing = 0;
    await fc.assert(fc.asyncProperty(prefixCases(), async (input) => {
      const device = await openDevice(input.notes, { settled: true });
      try {
        for (let length = 1; length <= input.fragment.length; length++) {
          const query = input.fragment.slice(0, length).join("");
          const seen: Seen = { query, notes: input.notes, server: await device.serverEngine(query), local: await device.localEngine(query) };
          compared++;
          if (seen.server.join() === seen.local.join()) continue;
          differing++;
          const why = DIFFERENCES.find((difference) => difference.explains(seen));
          expect(why, `unlisted difference for ${spelled(query)}: server [${seen.server}] device [${seen.local}] over ${JSON.stringify(input.notes.map((n) => [spelled(n.title), spelled(n.body)]))}`).toBeDefined();
        }
      } finally { closeDevice(device); }
    }), { seed: PROPS_SEED, numRuns: Math.min(PROPS_RUNS, MAX_RUNS) });
    process.stdout.write(`[differential] server vs device: ${compared} queries compared, ${differing} differed (all explained by DIFFERENCES)\n`);
    expect(compared).toBeGreaterThan(0);
  }, TIMEOUT);

  it.each(DIFFERENCES.map((difference) => [difference.id, difference] as const))("difference %s: its example really differs", async (_id, difference) => {
    const device = await openDevice(difference.example.notes, { settled: true });
    try {
      const seen: Seen = { query: difference.example.query, notes: difference.example.notes, server: await device.serverEngine(difference.example.query), local: await device.localEngine(difference.example.query) };
      expect(seen.server).not.toEqual(seen.local);
      expect(difference.explains(seen)).toBe(true);
    } finally { closeDevice(device); }
  }, TIMEOUT);
});
