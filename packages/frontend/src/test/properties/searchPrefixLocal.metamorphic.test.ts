// Metamorphic tests of THIS DEVICE's offline index (localCopy.search → the sql.js worker's searchNodes: SQLite FTS5 trigram,
// then a LIKE fallback), on its own: no server, no page mirror. The relations are the ones of the other engines
// (corpus and relations: @onden/markdown helpers/searchMetamorphic.ts; helpers/metamorphic.ts is the runner):
//
//   MR-S1  a shorter query finds at least what the longer one found — every prefix of a fragment, down to ONE grapheme
//   MR-S2  a one-grapheme query's answer depends on what the text holds, not on which class the grapheme is in
//
// The worker is the real one (localDbWorker over sql.js, its database file served from a fake IndexedDB), opened once per
// generated case on the corpus; a query is asked as the app asks it (the worker's `searchNodes`). The app's routing
// (which engine gets a query) is searchPrefix.metamorphic.integration.test.ts.

import { afterEach, describe, expect, it, vi } from "vitest";
import initSqlJs from "sql.js";
import { prepareLocalDatabase } from "../../lib/localDbSchema";
import { metamorphic } from "../../../../markdown/src/test/helpers/metamorphic.js";
import {
  prefixCases, shorterFindsAtLeastWhatLongerFound, oneGraphemeIgnoresItsClass, withSwap, newCoverage, describeCoverage, GRAPHEME_CLASSES, SPELLED_TWO_WAYS,
  type SearchNote, type SearchWorld, type PrefixCase,
} from "../../../../markdown/src/test/helpers/searchMetamorphic.js";

const disk = vi.hoisted(() => ({ bytes: null as ArrayBuffer | null }));
vi.mock("../../lib/indexedDbStorage", () => ({ idbLoad: async () => disk.bytes, idbSave: async (bytes: ArrayBuffer) => { disk.bytes = bytes; } }));
vi.mock("sql.js", async (original) => {
  const real = await original<typeof import("sql.js")>();
  return { default: () => real.default() };
});

type Reply = { ok: boolean; result?: unknown; error?: string };
let receive: (event: { data: { id: number; op: string; args: unknown[]; storageScope: string | null } }) => void;
let sequence = 0;
const replies = new Map<number, (reply: Reply) => void>();
function rpc<T>(op: string, ...args: unknown[]): Promise<T> {
  const id = ++sequence;
  return new Promise<T>((resolve, reject) => {
    replies.set(id, (reply) => (reply.ok ? resolve(reply.result as T) : reject(new Error(reply.error))));
    receive({ data: { id, op, args, storageScope: null } });
  });
}

/** This engine tries the query in NFC and NFD (localDbWorker searchNodes), so a grapheme that has two spellings finds the text in either:
 *  what it finds depends on the spelling, by design (the worker's own tests: "a query typed in NFD finds a title stored in NFC"). */
const FOLDS = "the grapheme has an NFC and an NFD spelling, and this engine finds both (documented)";
const GRAPHEMES_WITH_ONE_SPELLING = GRAPHEME_CLASSES.filter((name) => !SPELLED_TWO_WAYS.includes(name));
const hasOtherSpelling = (grapheme: string): boolean => grapheme.normalize("NFC") !== grapheme.normalize("NFD");

/** The device with these notes in its copy (bodies included: the world a settled device is in). */
async function openLocal(notes: SearchNote[]): Promise<SearchWorld> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  prepareLocalDatabase(db);
  db.run("INSERT INTO workspace (id, name, slug) VALUES ('w', 'Test', 'test')");
  notes.forEach((note, at) => db.run(
    "INSERT INTO nodes (id, source_type, node_type, title, slug, markdown) VALUES (?, 'local', 'content', ?, ?, ?)", [`n${at}`, note.title, `n${at}`, note.body]));
  disk.bytes = db.export().buffer as ArrayBuffer;
  db.close();
  vi.resetModules();
  const worker = { onmessage: null, postMessage: (reply: { id: number } & Reply) => { replies.get(reply.id)?.(reply); replies.delete(reply.id); } };
  vi.stubGlobal("self", worker);
  await import("../../lib/localDbWorker");
  receive = worker.onmessage!;
  await rpc("initLocalDb");
  return {
    search: async (query) => (await rpc<Array<{ id: string }>>("searchNodes", query)).map((hit) => ({ index: Number(hit.id.slice(1)), source: "local" as const })),
  };
}
const closeLocal = (): void => { vi.unstubAllGlobals(); vi.clearAllTimers(); };
afterEach(closeLocal);

describe("this device's offline index (localCopy.search)", () => {
  it("MR-S1 on-device engine: every prefix of a fragment, down to one grapheme", async () => {
    const coverage = newCoverage();
    await metamorphic({
      name: "MR-S1 on-device (c)", source: prefixCases(),
      setup: (input: PrefixCase) => openLocal(input.notes), teardown: closeLocal,
      relation: (world, input) => shorterFindsAtLeastWhatLongerFound(world, input, { coverage }),
      minCompared: 0.85, skipShare: { "the whole fragment found nothing": 0.03 },
    });
    process.stdout.write(`${describeCoverage(coverage)}\n`);
    expect(coverage.bodyOnlyExpected, "the runs must have asked one-grapheme queries that only a body match can answer").toBeGreaterThan(0);
  }, 20 * 60_000);

  it("MR-S2 on-device engine: a one-grapheme query does not depend on the grapheme's class", async () => {
    await metamorphic({
      name: "MR-S2 on-device (c)", source: prefixCases({ swapFrom: GRAPHEMES_WITH_ONE_SPELLING }),
      setup: (input: PrefixCase) => openLocal([...input.notes, ...withSwap(input.notes, input.fragment[0]!, input.swap)]), teardown: closeLocal,
      relation: (world, input) => oneGraphemeIgnoresItsClass(world, input, { untypable: (g) => (hasOtherSpelling(g) ? FOLDS : null) }),
      minCompared: 0.55, skipShare: { [FOLDS]: 0.4, "the swap grapheme is already in the corpus": 0.02, "neither grapheme was found": 0.1 },
    });
  }, 20 * 60_000);
});
