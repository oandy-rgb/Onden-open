// `onden-query` / `onden-base` fenced blocks outside the app (D113).
//
// In the app such a block is a live query (OndenQueryBlock posts to the
// authenticated /api/query; OndenBaseBlock evaluates the store's notes). The
// published site and the exports are read by people who can't run it, so the
// user's rule is: when a note is published (or exported) each block's result
// is FROZEN — a static list, listing only notes that are themselves on the
// site (or in the export). The server evaluates it once (backend
// modules/website/publishing/queryBlocks.ts freezeQueryBlocks) and stores the result
// on the note as `query_blocks`; every renderer of the published profile —
// the site (MarkdownRenderer) and the HTML exports (md2html) — draws that
// list and nothing else, never a live query.
//
// This file is what both ends share: which blocks a note has, the frozen
// result's shape and how a renderer finds a block's result, and the
// onden-query spec parser (so the server reads a block exactly as the app).

import { visit } from "unist-util-visit";
import { parserFor } from "./parsers.js";
import { stripFrontmatter } from "./frontmatter.js";

export const QUERY_BLOCK_LANGS = ["onden-query", "onden-base"] as const;
export type QueryBlockLang = (typeof QUERY_BLOCK_LANGS)[number];

/** At most this many rows are frozen per block; the rest is `more`. */
export const FROZEN_ROWS_MAX = 200;

/** One listed note: its id, title and slug as the site serves it. `values`:
 *  the block's other columns (`FrozenQueryBlock.columns`), as text. `note`:
 *  for a block node an onden-query lists, the title of the note it is in. */
export type FrozenQueryRow = { id: string; title: string; slug: string; values?: string[]; note?: string };

/** A block's result, frozen when the note was published or exported. */
export type FrozenQueryBlock = {
  lang: QueryBlockLang;
  /** The block's text (queryBlockKey form): how a renderer finds it. */
  source: string;
  /** Column headers after the title (an onden-base table's `order` keys);
   *  empty for a plain list. */
  columns: string[];
  rows: FrozenQueryRow[];
  /** Matching notes past `rows` (the block's limit or FROZEN_ROWS_MAX). */
  more: number;
  /** Why the block has no result (it can't be read): shown instead. */
  problem?: string;
};

export function isQueryBlockLang(lang: string | null | undefined): lang is QueryBlockLang {
  return lang === "onden-query" || lang === "onden-base";
}

/** A block's text as the key it is frozen under: trailing whitespace dropped
 *  (react-markdown and the HTML pipeline end a code block's text with "\n"). */
export function queryBlockKey(source: string): string {
  return source.replace(/\s+$/, "");
}

/** The onden-query / onden-base blocks in `markdown`, in order, each once. */
export function queryBlocksIn(markdown: string): Array<{ lang: QueryBlockLang; source: string }> {
  if (!markdown.includes("onden-query") && !markdown.includes("onden-base")) return [];
  const tree = parserFor("codeBlocks").parse(stripFrontmatter(markdown));
  const out: Array<{ lang: QueryBlockLang; source: string }> = [];
  const seen = new Set<string>();
  visit(tree, "code", (node) => {
    const lang = node.lang ?? "";
    if (!isQueryBlockLang(lang)) return;
    const source = queryBlockKey(node.value);
    const key = `${lang}\u0000${source}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ lang, source });
  });
  return out;
}

/** The frozen result of the block `lang` / `source` among `blocks`, or null
 *  (a note published before D113, or a body that isn't a published note's). */
export function frozenQueryBlock(
  blocks: readonly FrozenQueryBlock[] | null | undefined, lang: QueryBlockLang, source: string,
): FrozenQueryBlock | null {
  const key = queryBlockKey(source);
  return blocks?.find((b) => b.lang === lang && b.source === key) ?? null;
}

// ── onden-query spec ────────────────────────────────────────────────────
// A tiny YAML subset (~5 keys) rather than a full YAML parser, which would be
// 70KB for this one feature.

/** Top-level keys the block understands; `tag` is an alias of `tags` (people
 *  write the singular, and the block used to drop it — the API ignored the
 *  unknown key and the query listed every note). */
const QUERY_KEYS = ["tags", "where", "sort", "limit", "offset", "blocks"] as const;
const KEY_ALIASES: Record<string, string> = { tag: "tags" };

export type ParsedQuery =
  | { ok: true; spec: Record<string, unknown> }
  /** A line the block can't read: shown inline instead of running the query,
   *  so a typo never silently widens to "every note". */
  | { ok: false; problem: "unknown_key" | "unreadable_line" | "bad_number"; detail: string };

// Two-pass parser: collect top-level keys and the indented sub-block of
// `where:` if present. Comma in a top-level value yields an array.
export function parseQuerySpec(text: string): ParsedQuery {
  const out: Record<string, unknown> = {};
  let inWhere = false;
  const whereObj: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;
    const isIndented = /^\s{2,}/.test(rawLine);
    const line = rawLine.trim();
    if (inWhere && isIndented) {
      const idx = line.indexOf(":");
      if (idx <= 0) return { ok: false, problem: "unreadable_line", detail: line };
      whereObj[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      continue;
    }
    inWhere = false;
    const idx = line.indexOf(":");
    if (idx <= 0) return { ok: false, problem: "unreadable_line", detail: line };
    const written = line.slice(0, idx).trim();
    const key = KEY_ALIASES[written.toLowerCase()] ?? written.toLowerCase();
    if (!(QUERY_KEYS as readonly string[]).includes(key)) return { ok: false, problem: "unknown_key", detail: written };
    const val = line.slice(idx + 1).trim();
    if (!val) {
      if (key === "where") inWhere = true;
      continue;
    }
    // `blocks: include` asked for block nodes that inherit a tag; since
    // 2026-11-09 none do, and a tag query lists the ones tagged themselves
    // anyway. The line is skipped so a block written before still runs.
    if (key === "blocks") continue;
    if (key === "limit" || key === "offset") {
      const n = Number(val);
      if (!Number.isInteger(n) || n < 0) return { ok: false, problem: "bad_number", detail: written };
      out[key] = n;
      continue;
    }
    // `tags` is always a list — `tags: reading` (one tag, the simplest query)
    // used to go out as a string and the API refused it (400).
    if (key === "tags") {
      const names = val.split(",").map((s) => s.trim().replace(/^#/, "")).filter(Boolean);
      out.tags = [...(Array.isArray(out.tags) ? out.tags as string[] : []), ...names];
    } else {
      out[key] = val;
    }
  }
  if (Object.keys(whereObj).length > 0) out.where = whereObj;
  return { ok: true, spec: out };
}
