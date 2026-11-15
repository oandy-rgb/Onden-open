// Property: the on-device search (localDbWorker searchNodes: SQLite FTS5 trigram
// then a LIKE fallback) finds a note by any piece of its title or its text — in
// Chinese, where there are no spaces to split words at — and its snippet
// highlights the piece that was typed, never half an emoji. The server's
// PGroonga does the same (backend test/searchUnicode.integration.test.ts).
// Generators: markdown/src/test/helpers/unicodeText.ts. Seed and run count from
// PROPS_SEED / PROPS_RUNS.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import initSqlJs from "sql.js";
import { prepareLocalDatabase } from "../../lib/localDbSchema";
import { PROPS_RUNS, PROPS_SEED } from "../../../../markdown/src/test/helpers/propsConfig";
import { searchCorpus, searchFold, pieceOf, hasLoneSurrogate, toFullwidth } from "../../../../markdown/src/test/helpers/unicodeText";

const disk = vi.hoisted(() => ({ bytes: null as ArrayBuffer | null }));
vi.mock("../../lib/indexedDbStorage", () => ({ idbLoad: async () => disk.bytes, idbSave: async (bytes: ArrayBuffer) => { disk.bytes = bytes; } }));
vi.mock("sql.js", async (original) => {
  const real = await original<typeof import("sql.js")>();
  return { default: () => real.default() };
});

let receive: (event: { data: { id: number; op: string; args: unknown[]; storageScope: string | null } }) => void;
let sequence = 0;
const replies = new Map<number, (reply: { ok: boolean; result?: unknown; error?: string }) => void>();
function rpc<T>(op: string, ...args: unknown[]): Promise<T> {
  const id = ++sequence;
  return new Promise<T>((resolve, reject) => {
    replies.set(id, (reply) => (reply.ok ? resolve(reply.result as T) : reject(new Error(reply.error))));
    receive({ data: { id, op, args, storageScope: null } });
  });
}

type Hit = { id: string; snippet: { text: string; ranges: [number, number][] } | null };
const search = (query: string) => rpc<Hit[]>("searchNodes", query);

// One corpus per file: a note is (title, body); the properties pick a piece of
// one of them and look for it. Built from the shared generators, fixed by the seed.
const CORPUS_SIZE = 120;
const corpus = searchCorpus(CORPUS_SIZE, PROPS_SEED);

beforeAll(async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  prepareLocalDatabase(db);
  db.run("INSERT INTO workspace (id, name, slug) VALUES ('w', 'Test', 'test')");
  corpus.forEach((n, i) => db.run(
    "INSERT INTO nodes (id, source_type, node_type, title, slug, markdown) VALUES (?, 'local', 'content', ?, ?, ?)",
    [`n${i}`, n.title, `n${i}`, n.body],
  ));
  db.run("INSERT INTO nodes (id, source_type, node_type, title, slug, markdown) VALUES ('fixed-cafe', 'local', 'content', ?, 'fixed-cafe', ?)", ["Café 日記", "咖啡館的紀錄"]);
  db.run("INSERT INTO nodes (id, source_type, node_type, title, slug, markdown) VALUES ('fixed-tilde', 'local', 'content', ?, 'fixed-tilde', ?)", ["nightly", "\uff5dZ\u597d\u65bc\t\u0303\u5176"]);
  db.run("INSERT INTO nodes (id, source_type, node_type, title, slug, markdown) VALUES ('fixed-zwsp-mark', 'local', 'content', ?, 'fixed-zwsp-mark', ?)", ["nightly zwsp", "\u89bd\u6b0a\u200b\u0301o"]);
  disk.bytes = db.export().buffer as ArrayBuffer;
  db.close();
});

beforeEach(async () => {
  vi.resetModules();
  const worker = { onmessage: null, postMessage: (reply: { id: number; ok: boolean; result?: unknown; error?: string }) => {
    replies.get(reply.id)?.(reply); replies.delete(reply.id);
  } };
  vi.stubGlobal("self", worker);
  await import("../../lib/localDbWorker");
  receive = worker.onmessage!;
  await rpc("initLocalDb");
});

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllTimers(); });

// A query is looked for as typed, so a piece with a bare `"` or a leading `-`
// is a search operator, not text (queryTerms): left out of the generator.
const typable = (piece: string) => piece.length > 0 && !/["]|^-|\s(?:OR)\s/.test(piece) && !/\s/.test(piece);

describe("on-device search finds Chinese and Unicode text", () => {
  it("a piece of any title finds that note", async () => {
    await fc.assert(fc.asyncProperty(fc.nat(CORPUS_SIZE - 1), fc.nat(40), fc.integer({ min: 3, max: 8 }), async (at, from, length) => {
      const piece = pieceOf(corpus[at]!.title, from, length);
      fc.pre(typable(piece));
      const hits = await search(piece);
      if (hits.length < 50) expect(hits.map((h) => h.id), `title ${JSON.stringify(corpus[at]!.title)} piece ${JSON.stringify(piece)}`).toContain(`n${at}`);
    }), { seed: PROPS_SEED, numRuns: PROPS_RUNS });
  });

  it("a piece of any body finds that note, and the snippet highlights what was typed without splitting a character", async () => {
    await fc.assert(fc.asyncProperty(fc.nat(CORPUS_SIZE - 1), fc.nat(40), fc.integer({ min: 3, max: 8 }), async (at, from, length) => {
      const piece = pieceOf(corpus[at]!.body, from, length);
      fc.pre(typable(piece));
      const hits = await search(piece);
      if (hits.length >= 50) return;
      const hit = hits.find((h) => h.id === `n${at}`);
      expect(hit, `body ${JSON.stringify(corpus[at]!.body)} piece ${JSON.stringify(piece)}`).toBeDefined();
      const snippet = hit!.snippet;
      if (!snippet) return;
      expect(hasLoneSurrogate(snippet.text)).toBe(false);
      expect(snippet.ranges.length, `snippet ${JSON.stringify(snippet)}`).toBeGreaterThan(0);
      for (const [s, e] of snippet.ranges) {
        expect(hasLoneSurrogate(snippet.text.slice(s, e))).toBe(false);
        expect(searchFold(snippet.text.slice(s, e)), `range ${s}-${e} of ${JSON.stringify(snippet.text)}`).toBe(searchFold(piece));
      }
    }), { seed: PROPS_SEED, numRuns: PROPS_RUNS });
  });

  it("a one-character Chinese query (the LIKE fallback) finds a note that has it in its title", async () => {
    await fc.assert(fc.asyncProperty(fc.nat(CORPUS_SIZE - 1), async (at) => {
      const char = [...corpus[at]!.title].find((c) => /\p{Script=Han}/u.test(c));
      fc.pre(char !== undefined);
      const hits = await search(char!);
      if (hits.length < 50) expect(hits.map((h) => h.id)).toContain(`n${at}`);
    }), { seed: PROPS_SEED, numRuns: Math.min(PROPS_RUNS, 60) });
  });

  // Current behaviour (listed in the PR for a decision): the on-device index
  // stores text as written, so it is exact up to ASCII case. The server's
  // PGroonga folds width and NFC/NFD on both sides.
  it("a note stored with half-width Latin is not found by its full-width form (the server finds it)", async () => {
    const note = corpus.findIndex((n) => /[A-Za-z]{3,}/.test(n.title));
    if (note < 0) return;
    const word = corpus[note]!.title.match(/[A-Za-z]{3,}/)![0];
    expect((await search(word)).map((h) => h.id)).toContain(`n${note}`);
    expect((await search(toFullwidth(word))).map((h) => h.id)).not.toContain(`n${note}`);
  });

  // A title typed in NFD (e + U+0301) and one in NFC are found by either spelling: the worker
  // tries the query in both forms (the server's PGroonga folds them on both sides).
  it("a query typed in NFD finds a title stored in NFC", async () => {
    expect((await search("Cafe\u0301")).map((h) => h.id)).toContain("fixed-cafe");
  });

  // Nightly 2026-10-28, PROPS_SEED=1028726334 PROPS_RUNS=5000: a body piece that starts with a
  // combining mark right after a tab finds the note, but the snippet (tab shown as a space)
  // has no highlighted range. Likely cause: the snippet's whitespace collapse changes the
  // text the match is located in, so the mark-first term is not found again.
  it("FINDING nightly: a piece starting with a combining mark after a tab still gets a highlight", async () => {
    const hit = (await search("\u0303\u5176")).find((h) => h.id === "fixed-tilde");
    expect(hit).toBeDefined();
    expect(hit!.snippet?.ranges.length).toBeGreaterThan(0);
  });

  // FINDING nightly 2026-11-08, seed 1040027385 (PROPS_RUNS=5000, corpus note 95, from 0, length 3):
  // typing 覽權 + zero-width space finds the note, but the highlighted range also covers the combining
  // acute after the space, which was not typed (range text folds to a different string than the query).
  // Invariant: a highlighted range holds exactly what was typed. Likely cause: the snippet widens the
  // range to a grapheme-cluster edge (packages/markdown/src/snippet.ts clusterEdge) past a mark that
  // does not belong to the typed text.
  it.fails("FINDING nightly: a highlight of text ending in a zero-width space does not swallow the combining mark after it", async () => {
    const piece = "\u89bd\u6b0a\u200b";
    const hit = (await search(piece)).find((h) => h.id === "fixed-zwsp-mark");
    expect(hit?.snippet).toBeTruthy();
    for (const [s, e] of hit!.snippet!.ranges) expect(searchFold(hit!.snippet!.text.slice(s, e))).toBe(searchFold(piece));
  });

  it("an ordinary query finds the same note by title or by body, in either script", async () => {
    expect((await search("Café")).map((h) => h.id)).toContain("fixed-cafe");
    expect((await search("咖啡館")).map((h) => h.id)).toContain("fixed-cafe");
    expect((await search("日記")).map((h) => h.id)).toContain("fixed-cafe");
  });
});
