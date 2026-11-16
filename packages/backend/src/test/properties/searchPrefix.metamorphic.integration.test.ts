// Metamorphic tests of the server's two text engines (services/textSearch.ts): pgroonga and the portable ILIKE engine.
// A metamorphic test needs no model of the right answer: it checks a relation between the answers to related queries
// (helpers/metamorphic.ts in @onden/markdown; the corpus and the relations: helpers/searchMetamorphic.ts, which the
// frontend's searchPrefix.metamorphic test reads too, for the on-device engine and for the app's routing).
//
//   MR-S1  a shorter query finds at least what the longer one found — every prefix of a fragment, down to ONE grapheme
//   MR-S2  a one-grapheme query's answer depends on what the text holds, not on which class the grapheme is in
//
// Here the engine is `searchNodes` (the service the route calls), so the route's own "no text under 2 characters"
// rule is NOT in the path: it belongs to the assembly, which the frontend test covers (engine (d) there).
//
// pgroonga reliably finds runs of Han characters and WHOLE Latin / digit words only (searchUnicode.integration.property.test.ts).
// A prefix that cuts a Latin word in half may legitimately not match, so this file asks `typable()` of EVERY prefix of the
// walk and skips the case ("not typable for pgroonga") when one fails; the relation is not weakened for the portable engine.
// The class weights favour Han for pgroonga so that enough cases can compare; the skip share is bounded by the runner.
//
// Notes are made through createNote (titles are stored in NFC, as the app does) and the derived work is awaited
// (awaitAllDispatchers) before anything is searched.
//
// Needs a database whose name ends in _test. The pgroonga test needs the extension: it skips by name on PGlite
// (needsPgroonga); the portable test runs on both.

import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig.js";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { needsPgroonga } from "../helpers/pgliteSkips.js";
import { metamorphic } from "../../../../markdown/src/test/helpers/metamorphic.js";
import {
  prefixCases, GRAPHEME_CLASSES, shorterFindsAtLeastWhatLongerFound, oneGraphemeIgnoresItsClass, withSwap, newCoverage, describeCoverage, exactIndices, spelled, graphemesOf,
  type SearchNote, type SearchWorld, type PrefixCase,
} from "../../../../markdown/src/test/helpers/searchMetamorphic.js";
import { createNote } from "../../services/noteCreate.js";
import { searchNodes } from "../../services/nodeSearch.js";
import { resetTextSearchEngineChoice } from "../../services/textSearch.js";
import { awaitAllDispatchers } from "../../services/dispatcherQueue.js";
import { freshWorkspace } from "../helpers/roundTripWorld.js";

// A small table is read by the planner with a plain scan, which matches like a substring search; the pgroonga
// engine is asked through its index (the pool's sessions start with enable_seqscan off; see searchUnicode).
vi.hoisted(() => { process.env.PGOPTIONS = "-c enable_seqscan=off"; });

const enabled = isTestDatabase();
const TIMEOUT = 60 * 60_000;

type Engine = "pgroonga" | "portable";

async function openWorld(engine: Engine, notes: SearchNote[]): Promise<SearchWorld> {
  process.env.ONDEN_SEARCH_ENGINE = engine;
  resetTextSearchEngineChoice();
  const { ws, actor } = await freshWorkspace(`mr-${engine}`);
  const ids: string[] = [];
  for (const note of notes) ids.push((await createNote({ actor, workspaceId: ws, title: note.title, markdown: note.body, event: { uiContext: "test.metamorphic" } })).node.id);
  await awaitAllDispatchers();
  return {
    // Fewer notes than the limit (30), so it cannot truncate; its own behaviour is an ordinary test (see the frontend file).
    // The engine is chosen again per query: two worlds (one per engine) can be open at once.
    search: async (query) => {
      process.env.ONDEN_SEARCH_ENGINE = engine;
      resetTextSearchEngineChoice();
      return (await searchNodes(ws, query, actor, 30)).map((hit) => ({ index: ids.indexOf(hit.id), source: "server" as const }));
    },
  };
}

afterEach(() => { delete process.env.ONDEN_SEARCH_ENGINE; resetTextSearchEngineChoice(); });

// ── pgroonga's tokenizer: what the index reliably finds (copied from searchUnicode.integration.property.test.ts) ──
const WORD_CHAR = /^(?!\p{Script=Han})[\p{L}\p{N}\p{M}]$/u;
function typable(piece: string, source = ""): boolean {
  if (/^\p{Script=Han}+$/u.test(piece)) return true;
  if (!/^[A-Za-z0-9]+$/.test(piece)) return false;
  const at = source.indexOf(piece);
  const before = [...source.slice(0, Math.max(0, at))].at(-1) ?? "", after = [...source.slice(at + piece.length)][0] ?? "";
  return at < 0 || !(WORD_CHAR.test(before) || WORD_CHAR.test(after));
}
const NOT_TYPABLE = "not typable for pgroonga";
/** The query is read in NFC (parseSearchQuery, D58) and the portable engine does not fold Unicode forms (portable-backend.md §4),
 *  so text stored decomposed cannot be found by anything typed: a known, documented difference with its own fixed example below. */
const DECOMPOSED = "decomposed text: the portable engine does not fold NFC/NFD (documented)";
const isDecomposed = (text: string): boolean => text !== text.normalize("NFC");

describe.skipIf(!enabled)("a shorter query finds at least what the longer one found (server engines)", () => {
  it("MR-S1 portable engine (ILIKE): every prefix of a fragment, down to one grapheme", async () => {
    const coverage = newCoverage();
    await metamorphic({
      name: "MR-S1 portable", source: prefixCases(),
      setup: (input: PrefixCase) => openWorld("portable", input.notes),
      relation: (world, input) => shorterFindsAtLeastWhatLongerFound(world, input, { coverage, whyNothing: (fragment) => (isDecomposed(fragment) ? DECOMPOSED : null) }),
      minCompared: 0.7, skipShare: { [DECOMPOSED]: 0.3, "the whole fragment found nothing": 0.03 },
    });
    process.stdout.write(`${describeCoverage(coverage)}\n`);
    expect(coverage.bodyOnlyExpected, "the runs must have asked one-grapheme queries that only a body match can answer").toBeGreaterThan(0);
  }, TIMEOUT);

  it("MR-S2 portable engine: a one-grapheme query does not depend on the grapheme's class", async () => {
    await metamorphic({
      name: "MR-S2 portable", source: prefixCases({ swapFrom: GRAPHEME_CLASSES.filter((name) => name !== "nfd") }),
      setup: (input: PrefixCase) => openWorld("portable", [...input.notes, ...withSwap(input.notes, input.fragment[0]!, input.swap)]),
      relation: (world, input) => oneGraphemeIgnoresItsClass(world, input, { untypable: (g) => (isDecomposed(g) ? DECOMPOSED : null) }),
      minCompared: 0.7, skipShare: { [DECOMPOSED]: 0.3, "the swap grapheme is already in the corpus": 0.02, "neither grapheme was found": 0.1 },
    });
  }, TIMEOUT);

  // Han-heavy: pgroonga finds runs of Han characters reliably, so these are the cases that can compare.
  it.skipIf(needsPgroonga)("MR-S1 pgroonga engine: every prefix of a fragment that is typable, down to one grapheme", async () => {
    const coverage = newCoverage();
    await metamorphic({
      name: "MR-S1 pgroonga", source: prefixCases({ classWeights: { han: 12, hanExtB: 6 } }),
      setup: (input: PrefixCase) => openWorld("pgroonga", input.notes),
      relation: (world, input) => shorterFindsAtLeastWhatLongerFound(world, input, { coverage, untypable: (prefix, home) => (typable(prefix, home) ? null : NOT_TYPABLE) }),
      minCompared: 0.25, skipShare: { [NOT_TYPABLE]: 0.7, "the whole fragment found nothing": 0.05 },
    });
    process.stdout.write(`${describeCoverage(coverage)}\n`);
  }, TIMEOUT);

  it.skipIf(needsPgroonga)("MR-S2 pgroonga engine: a typable one-grapheme query does not depend on the grapheme's class", async () => {
    await metamorphic({
      name: "MR-S2 pgroonga", source: prefixCases({ classWeights: { han: 12, hanExtB: 6 } }),
      setup: (input: PrefixCase) => openWorld("pgroonga", [...input.notes, ...withSwap(input.notes, input.fragment[0]!, input.swap)]),
      relation: (world, input) => oneGraphemeIgnoresItsClass(world, input, { untypable: (g) => (typable(g) ? null : NOT_TYPABLE) }),
      minCompared: 0.1, skipShare: { [NOT_TYPABLE]: 0.9, "the swap grapheme is already in the corpus": 0.05, "neither grapheme was found": 0.1 },
    });
  }, TIMEOUT);

  // ── fixed examples: what the portable engine does today with Unicode spellings (portable-backend.md §4: no normalisation) ──
  it("portable engine today: text stored decomposed (NFD) is not found by either spelling; the same text stored precomposed is", async () => {
    const world = await openWorld("portable", [{ title: "decomposed", body: "e\u0301e\u0301筆" }, { title: "precomposed", body: "\u00E9\u00E9筆" }]);
    expect(exactIndices(await world.search("e\u0301")), "typed decomposed: the query is read in NFC").toEqual(new Set([1]));
    expect(exactIndices(await world.search("\u00E9")), "typed precomposed").toEqual(new Set([1]));
  }, TIMEOUT);

  // ── differential: pgroonga and the portable engine ──

  // For a typable query (a run of Han characters, or a whole Latin word), the exact set is the same, except the differences below.
  // UNVERIFIED on this machine: pgroonga is not installed here (the test skips by name), so this table is written from
  // portable-backend.md §4 and the searchUnicode findings, not from a run; the first real-Postgres run will say whether it is exact.
  type Seen = { query: string; notes: SearchNote[]; pgroonga: number[]; portable: number[] };
  const DIFFERENCES: Array<{ id: string; reason: string; explains: (seen: Seen) => boolean }> = [{
    id: "latin-inside-a-longer-word",
    reason: "pgroonga matches whole tokens, the portable engine any substring: a Latin query inside a longer word is found by the portable engine only.",
    explains: ({ query, notes, pgroonga, portable }) => pgroonga.every((at) => portable.includes(at))
      && portable.filter((at) => !pgroonga.includes(at)).every((at) => /^[A-Za-z0-9]+$/.test(query) && (notes[at]!.title + "\n" + notes[at]!.body).split(/[^\p{L}\p{N}\p{M}]+/u).every((word) => word !== query)),
  }];
  it.skipIf(needsPgroonga)("pgroonga and the portable engine answer the same exact set for a typable query, except for DIFFERENCES", async () => {
    let compared = 0, differing = 0;
    await fc.assert(fc.asyncProperty(prefixCases({ classWeights: { han: 12, hanExtB: 6 } }), async (input) => {
      const [pgroonga, portable] = [await openWorld("pgroonga", input.notes), await openWorld("portable", input.notes)];
      const home = input.notes[input.home.note]![input.home.field];
      for (let length = 1; length <= input.fragment.length; length++) {
        const query = input.fragment.slice(0, length).join("");
        if (!typable(query, home)) continue;
        const seen: Seen = { query, notes: input.notes, pgroonga: [...exactIndices(await pgroonga.search(query))].sort((a, b) => a - b), portable: [...exactIndices(await portable.search(query))].sort((a, b) => a - b) };
        compared++;
        if (seen.pgroonga.join() === seen.portable.join()) continue;
        differing++;
        expect(DIFFERENCES.some((difference) => difference.explains(seen)), `unlisted difference for ${spelled(query)} (${graphemesOf(query).length} graphemes): pgroonga [${seen.pgroonga}] portable [${seen.portable}] over ${JSON.stringify(input.notes.map((n) => [spelled(n.title), spelled(n.body)]))}`).toBe(true);
      }
    }), { seed: PROPS_SEED, numRuns: Math.min(PROPS_RUNS, 300) });
    process.stdout.write(`[differential] pgroonga vs portable: ${compared} queries compared, ${differing} differed\n`);
    expect(compared).toBeGreaterThan(0);
  }, TIMEOUT);
});
