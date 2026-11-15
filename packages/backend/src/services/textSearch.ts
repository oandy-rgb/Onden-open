import { q } from "../db.js";
import { config } from "../config.js";
import { containsPattern } from "../utils.js";

// The one place that knows HOW note text is matched, ranked and highlighted.
// nodeSearch.ts builds the rest of the query (workspace, tags, attributes,
// readableScopeSql, LIMIT) and asks the engine for three SQL pieces:
//
//   const { match, order, keywords } = (await textSearchEngine()).build("n", parsed.text, params);
//   WHERE … AND ${match}          -- title or body matches the query text
//   ORDER BY ${order}             -- best first
//   SELECT … ${keywords} AS snippet_terms   -- words to highlight (text[])
//
// `build` appends its own positional parameters to `params`; the read policy
// stays in the same SQL statement, after them.
//
// Two engines, same result shape:
//   pgroonga — the production server: Groonga's index and relevance score.
//   portable — PGlite (desktop, browser, tests) or any Postgres without pgroonga:
//              ILIKE substring matching (pg_trgm GIN index on the column, so 3+ character
//              terms do not scan), own ranking. Differences are listed in
//              docs/architecture/portable-backend.md.
// Which one runs is decided from the database (the pgroonga extension is
// installed), not from where the code runs; ONDEN_SEARCH_ENGINE=portable|pgroonga forces it.

export type TextSearchSql = {
  /** A boolean SQL expression: the row's title or body matches the query text. */
  match: string;
  /** An ORDER BY list, best match first. */
  order: string;
  /** A `text[]` expression: the terms to highlight in the body snippet. */
  keywords: string;
};

export interface TextSearchEngine {
  readonly name: "pgroonga" | "portable";
  build(alias: string, queryText: string, params: unknown[]): TextSearchSql;
}

/** The title tiers every engine orders by before its own relevance: the title equals the typed
 *  text, then starts with it, then contains it whole, then the rest (a title that merely holds
 *  its words apart, a body match). Typing a note's exact name must put it first, however often
 *  other notes repeat the word; `Note 6` must put `Note 6`, `Note 60` and `My Note 6` before
 *  `Note 166`. The frontend's title pickers keep the same four tiers (lib/noteSearch.ts rankByTitle). */
function titleTiersFirst(alias: string, rawIdx: number): string {
  const title = `lower(${alias}.title)`, typed = `lower($${rawIdx})`;
  return `(${title} = ${typed}) DESC, starts_with(${title}, ${typed}) DESC, (strpos(${title}, ${typed}) > 0) DESC`;
}

export const pgroongaEngine: TextSearchEngine = {
  name: "pgroonga",
  build(alias, queryText, params) {
    params.push(queryText);
    const i = params.length;
    return {
      match: `(${alias}.title &@~ $${i} OR ${alias}.markdown &@~ $${i})`,
      order: `${titleTiersFirst(alias, i)}, pgroonga_score(${alias}.tableoid, ${alias}.ctid) DESC`,
      // Phrases whole; OR and -excluded words dropped (D76).
      keywords: `pgroonga_query_extract_keywords($${i})`,
    };
  },
};

export type PortableQuery = {
  /** Every group must match; a group matches when any of its terms does (`a OR b`). */
  groups: string[][];
  /** None of these may appear. */
  excluded: string[];
};

/** The query text as the portable engine reads it: words (AND), "phrases", `a OR b`, `-excluded`.
 *  OR binds tighter than the space between words: `a b OR c` is a AND (b OR c). */
export function parsePortableQuery(text: string): PortableQuery {
  const groups: string[][] = [];
  const excluded: string[] = [];
  let joinNext = false;
  for (const token of text.match(/-?"[^"]*"|\S+/g) ?? []) {
    if (token.toUpperCase() === "OR") { joinNext = groups.length > 0; continue; }
    const negated = token.startsWith("-") && token.length > 1;
    const term = (negated ? token.slice(1) : token).replace(/^"|"$/g, "").trim();
    if (!term) continue;
    if (negated) { excluded.push(term); joinNext = false; continue; }
    if (joinNext) groups[groups.length - 1]!.push(term);
    else groups.push([term]);
    joinNext = false;
  }
  return { groups, excluded };
}

export const portableEngine: TextSearchEngine = {
  name: "portable",
  build(alias, queryText, params) {
    const { groups, excluded } = parsePortableQuery(queryText);
    const patternIdx = new Map<string, number>();
    const rawIdx = new Map<string, number>();
    const pattern = (term: string) => {
      if (!patternIdx.has(term)) { params.push(containsPattern(term)); patternIdx.set(term, params.length); }
      return `$${patternIdx.get(term)}`;
    };
    const raw = (term: string) => {
      if (!rawIdx.has(term)) { params.push(term); rawIdx.set(term, params.length); }
      return `$${rawIdx.get(term)}`;
    };
    // Like pgroonga's `title &@~ q OR markdown &@~ q`: the whole query must hold in the title, or in the body.
    const holdsIn = (column: string): string => {
      const col = `coalesce(${alias}.${column}, '')`;
      const parts = [
        ...groups.map((g) => `(${g.map((t) => `${col} ILIKE ${pattern(t)}`).join(" OR ")})`),
        ...excluded.map((t) => `${col} NOT ILIKE ${pattern(t)}`),
      ];
      return parts.length > 0 && groups.length > 0 ? `(${parts.join(" AND ")})` : "false";
    };
    const match = `(${holdsIn("title")} OR ${holdsIn("markdown")})`;

    const terms = groups.flat();
    params.push(queryText);
    const whole = params.length;
    // Relevance: a term in the title weighs 1000, each body occurrence 1 (capped), summed over the terms.
    const score = terms.length === 0 ? "0" : terms.map((t) => {
      const r = raw(t);
      return `(CASE WHEN ${alias}.title ILIKE ${pattern(t)} THEN 1000 ELSE 0 END`
        + ` + least(999, (length(coalesce(${alias}.markdown, '')) - length(replace(lower(coalesce(${alias}.markdown, '')), lower(${r}), ''))) / greatest(length(${r}), 1)))`;
    }).join(" + ");
    return {
      match,
      order: `${titleTiersFirst(alias, whole)}, (${score}) DESC`,
      keywords: terms.length === 0 ? "ARRAY[]::text[]" : `ARRAY[${terms.map((t) => `${raw(t)}::text`).join(", ")}]`,
    };
  },
};

let chosen: Promise<TextSearchEngine> | null = null;

/** The engine for this database: pgroonga when the extension is installed, otherwise portable. */
export function textSearchEngine(): Promise<TextSearchEngine> {
  chosen ??= (async () => {
    const forced = config.str("ONDEN_SEARCH_ENGINE");
    if (forced === "portable") return portableEngine;
    if (forced === "pgroonga") return pgroongaEngine;
    const { rows } = await q(`SELECT 1 FROM pg_extension WHERE extname = 'pgroonga'`);
    return rows.length > 0 ? pgroongaEngine : portableEngine;
  })().catch((error) => { chosen = null; throw error; });
  return chosen;
}

/** For tests that switch the database or the setting between cases. */
export function resetTextSearchEngineChoice(): void {
  chosen = null;
}
