// Property: the server's search (PGroonga, services/nodeSearch.ts) finds a note
// by any piece of its title or text — Chinese has no spaces to split words at —
// ignoring case, full-width vs half-width forms and NFC vs NFD, and its snippet
// highlights what was typed without cutting a character. Its answer is held to
// the same reference as the app's on-device index (frontend
// test/properties/localSearchUnicode.property.test.ts reads the same corpus).
// Generators: markdown/src/test/helpers/unicodeText.ts. Seed and run count from
// PROPS_SEED / PROPS_RUNS. Needs pgroonga: skips unless DATABASE_URL names a
// *_test database.

import { describe, expect, it, beforeAll, vi } from "vitest";
import fc from "fast-check";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig.js";
import { searchCorpus, searchFold, pieceOf, toFullwidth, hasLoneSurrogate } from "../../../../markdown/src/test/helpers/unicodeText.js";
import { pool } from "../../db.js";
import { searchNodes } from "../../services/nodeSearch.js";
import { freshWorkspace } from "../helpers/roundTripWorld.js";
import type { ActorCtx } from "../../types.js";
import { needsPgroonga } from "../helpers/pgliteSkips.js";
import { seedQ } from "../helpers/seedQ.js";

// A workspace of a few hundred notes is read by the planner with a plain scan, which matches like a
// substring search; a real one goes through the PGroonga index, whose tokenizer is different (see the
// findings below). These tests ask the index, whatever the table's size: the pool's sessions start with
// enable_seqscan off (libpq's PGOPTIONS, read when the pool connects).
vi.hoisted(() => { process.env.PGOPTIONS = "-c enable_seqscan=off"; });

const enabled = isTestDatabase();
const TIMEOUT = 20 * 60_000;
const CORPUS_SIZE = 120;
const corpus = searchCorpus(CORPUS_SIZE, PROPS_SEED);
/** What a person types to find part of `source` that the index reliably finds: a run of Chinese
 *  characters (extension planes included), or a whole Latin / numeric word. Other scripts, accents,
 *  Bopomofo, emoji and punctuation depend on the tokenizer (see the findings below). */
const WORD_CHAR = /^(?!\p{Script=Han})[\p{L}\p{N}\p{M}]$/u;
function typable(piece: string, source = ""): boolean {
  if (/^\p{Script=Han}+$/u.test(piece)) return true;
  if (!/^[A-Za-z0-9]+$/.test(piece)) return false;
  const at = source.indexOf(piece);
  const before = [...source.slice(0, Math.max(0, at))].at(-1) ?? "", after = [...source.slice(at + piece.length)][0] ?? "";
  return at < 0 || !(WORD_CHAR.test(before) || WORD_CHAR.test(after));
}

describe.skipIf(!enabled)("server search finds Chinese and Unicode text (PGroonga)", () => {
  let ws = "";
  let actor: ActorCtx;
  const ids: string[] = [];

  beforeAll(async () => {
    ({ ws, actor } = await freshWorkspace("uni-search"));
    for (const [i, n] of corpus.entries()) {
      ids.push((await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
         VALUES ($1, 'manual', 'content', $2, $3, $4) RETURNING id::text`, [ws, n.title, `uni-${i}`, n.body])).rows[0]!.id);
    }
  });

  const search = (query: string) => searchNodes(ws, query, actor, 50);

  it("a piece of any title finds that note", async () => {
    await fc.assert(fc.asyncProperty(fc.nat(CORPUS_SIZE - 1), fc.nat(40), fc.integer({ min: 2, max: 8 }), async (at, from, length) => {
      const piece = pieceOf(corpus[at]!.title, from, length);
      fc.pre(typable(piece, corpus[at]!.title));
      const hits = await search(piece);
      if (hits.length < 50) expect(hits.map((h) => h.id), `title ${JSON.stringify(corpus[at]!.title)} piece ${JSON.stringify(piece)}`).toContain(ids[at]);
    }), { seed: PROPS_SEED, numRuns: PROPS_RUNS });
  }, TIMEOUT);

  it("a piece of any body finds that note and highlights it", async () => {
    await fc.assert(fc.asyncProperty(fc.nat(CORPUS_SIZE - 1), fc.nat(40), fc.integer({ min: 2, max: 8 }), async (at, from, length) => {
      const piece = pieceOf(corpus[at]!.body, from, length);
      fc.pre(typable(piece, corpus[at]!.body));
      const hits = await search(piece);
      if (hits.length >= 50) return;
      const hit = hits.find((h) => h.id === ids[at]);
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
  }, TIMEOUT);

  it("is blind to case, full-width forms and NFC / NFD in what is typed", async () => {
    await fc.assert(fc.asyncProperty(fc.nat(CORPUS_SIZE - 1), fc.nat(40), fc.integer({ min: 2, max: 8 }), fc.constantFrom("upper", "fullwidth", "halfwidth", "nfd"), async (at, from, length, how) => {
      const piece = pieceOf(corpus[at]!.title, from, length);
      fc.pre(typable(piece, corpus[at]!.title));
      const typed = { upper: piece.toUpperCase(), fullwidth: toFullwidth(piece), halfwidth: piece.normalize("NFKC"), nfd: piece.normalize("NFD") }[how];
      fc.pre(typable(typed));
      const hits = await search(typed);
      if (hits.length < 50) expect(hits.map((h) => h.id), `${how}: ${JSON.stringify(typed)} for title ${JSON.stringify(corpus[at]!.title)}`).toContain(ids[at]);
    }), { seed: PROPS_SEED, numRuns: PROPS_RUNS });
  }, TIMEOUT);

  // Current behaviour of the INDEX, kept as examples so a tokenizer change
  // shows here. The planner reads a small table by scanning it, which matches
  // like a substring search; a real workspace uses the index, so these force it
  // (enable_seqscan off) and ask the same predicate as nodeSearch.ts. The
  // on-device index (SQLite trigram + LIKE) is plain substring search and finds
  // both; listed in the PR for a decision.
  describe("where the server's index differs from a substring search (current behaviour)", () => {
    let id = "";
    beforeAll(async () => {
      id = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
         VALUES ($1, 'manual', 'content', $2, $3, $4) RETURNING id::text`, [ws, "括號〈【筆記】〉", "uni-findings", "專線無ri很工法"])).rows[0]!.id;
    });

    async function viaIndex(text: string): Promise<string[]> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL enable_seqscan = off");
        const rows = await client.query<{ id: string }>(
          `SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND (title &@~ $2 OR markdown &@~ $2)`, [ws, text]);
        await client.query("ROLLBACK");
        return rows.rows.map((r) => r.id);
      } finally { client.release(); }
    }

    it.skipIf(needsPgroonga)("a piece starting inside a Latin word ('i很工') does not find the note; the whole word or the Chinese part does", async () => {
      expect(await viaIndex("i很工")).not.toContain(id);
      expect(await viaIndex("ri很工")).toContain(id);
      expect(await viaIndex("很工")).toContain(id);
    });

    // Found at PROPS_SEED=20261023 once the pieces were not limited to Chinese characters and whole Latin words.
    it.skipIf(needsPgroonga)("pieces with punctuation, an accented or Bopomofo letter next to a word, or a keycap emoji are not reliably found", async () => {
      const row = async (title: string, slug: string) => (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
         VALUES ($1, 'manual', 'content', $2, $3, '') RETURNING id::text`, [ws, title, slug])).rows[0]!.id;
      const punct = await row("］！回𤋮5", "uni-f-punct");
      const mixed = await row("4ǖÅㄊǖz", "uni-f-mixed");
      const keycap = await row("Åｙ1️⃣ｃ布m兒", "uni-f-keycap");
      expect(await viaIndex("！回")).not.toContain(punct);
      expect(await viaIndex("回𤋮")).toContain(punct);
      expect(await viaIndex("Åㄊ")).not.toContain(mixed);
      expect(await viaIndex("ｙ1️⃣")).not.toContain(keycap);
      expect(await viaIndex("布m兒")).toContain(keycap);
    });

    it.skipIf(needsPgroonga)("a query of only punctuation ('〈【') is not reliable: it finds one note that has it and not another; the words beside it always do", async () => {
      // Found at seed 20261023: this title has 〈【 and the index does not return it for 〈【.
      const other = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
         VALUES ($1, 'manual', 'content', $2, $3, '') RETURNING id::text`, [ws, "：〈【𥉉又t有〉～🔥驫ㄨ", "uni-findings-2"])).rows[0]!.id;
      expect(await viaIndex("〈【")).not.toContain(other);
      expect(await viaIndex("𥉉又")).toContain(other);
      expect(await viaIndex("筆記")).toContain(id);
    });
  });
});
