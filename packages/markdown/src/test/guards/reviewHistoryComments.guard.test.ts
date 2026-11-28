// Guard: a comment in product code says what the code is and why, not how it was reviewed
// (docs/agents/design-principles.md, 「契約、註解、命名與一致性」). "PR #1853, round 9, point 2" is true of a
// conversation, not of the code: it goes stale, a reader cannot act on it, and a function name quoted in it was
// once counted as a use by the unused-code check. History belongs in commit messages, PR comments and
// docs/agents/mistakes.md. Migration headers (packages/backend/db/migrations) are not product source and are not read.
//
// Each file is held to exactly its count in reviewHistoryComments.baseline.json: more fails, and fewer fails too
// until the baseline is lowered, so a removed comment cannot be traded for a new one later. The baseline only
// ratchets down (scripts/ratchetLib.mjs reads every guards/*baseline*.json, an empty `{}` included) and the file
// stays even when it is empty. Nobody cleans the old ones on purpose: they go when the file is touched. After
// removing some, lower the baseline:
// UPDATE_REVIEW_HISTORY_BASELINE=1 npx vitest run src/test/guards/reviewHistoryComments
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compareGroups, jsonGroups, JSON_FILES } from "../../../../../scripts/ratchetLib.mjs";
import { belowBaseline, overBaseline, sourceFiles, type SourceWalk } from "./sources";

const PACKAGES = fileURLToPath(new URL("../../../../", import.meta.url));
const BASELINE = fileURLToPath(new URL("./reviewHistoryComments.baseline.json", import.meta.url));
const BASELINE_IN_REPO = "packages/markdown/src/test/guards/reviewHistoryComments.baseline.json";
const LOWER = "UPDATE_REVIEW_HISTORY_BASELINE=1 npx vitest run src/test/guards/reviewHistoryComments";

/** 「輪」 as a round, not the first half of another word: 輪詢 (polling), 輪流／輪替／輪換／輪轉 (taking turns), 輪廓, 輪子. */
const ROUND = String.raw`輪(?![詢流替換轉廓子])`;

/**
 * A mention of review history. "round N" only with a number, and not a round of something the code does (a sync
 * exchange, a retry, a focus timer's round): "one more exchange round" and 「第 N 輪」 (a placeholder) are not history.
 * A bare issue or PR number with nothing else, "(#1853)" or "since #1794", is not counted: `#` and digits alone are
 * also a colour (#888888), a contract or spec item (contract #10), an issue that holds the reason (issue #2001) or
 * another project's ticket, and a pattern cannot tell those apart from a PR.
 */
const REVIEW_HISTORY = new RegExp(
  [
    String.raw`\bPRs? ?#\d+`, // "PR #1853", "PRs #1853 and #1854", "PR#12"
    String.raw`\breview of #\d+`, // "review of #1937"
    String.raw`(?<!\b(?:exchange|sync|retry|focus|gossip) )\brounds? \d+\b`, // "round 7", "review round 1, B5", "rounds 5–6"
    String.raw`\breview rounds?\b`, // "second review round"
    String.raw`第 ?(?:\d+|[一二三四五六七八九十兩]+) ?${ROUND}`, // 「第 2 輪」「第三輪」
    String.raw`審查[^\n。]{0,8}${ROUND}|${ROUND}[^\n。]{0,4}審查`, // 「審查第三輪」, not 「審查完再輪詢」
  ].join("|"),
  "i",
);

/** What this guard reads in every package's src: also .mjs/.cjs (desktop, ai-answerer) and .astro (site pages and heads); a folder named testing holds test helpers, as a *.testing.ts file does. */
const PRODUCT_WALK: SourceWalk = { extensions: ["ts", "tsx", "mjs", "cjs", "astro"], skipDirs: ["vendor", "tests", "__tests__", "e2e", "testing"] };

/**
 * Every product source file of every package (packages/<name>/src, walked by sources.ts `sourceFiles` with
 * PRODUCT_WALK), as a path from packages/, sorted.
 *   productFiles() → ["ai-answerer/src/adapters/acp.mjs", …, "frontend/src/components/SiteLayout.astro", …]
 */
function productFiles(): string[] {
  return readdirSync(PACKAGES, { withFileTypes: true })
    .filter((pkg) => pkg.isDirectory() && existsSync(join(PACKAGES, pkg.name, "src")))
    .flatMap((pkg) => sourceFiles(join(PACKAGES, pkg.name, "src"), PRODUCT_WALK))
    .map((file) => relative(PACKAGES, file).split(sep).join("/"))
    .sort();
}

type Range = { pos: number; end: number };

/**
 * The comments (`//`, block comment, JSDoc) of `text` parsed as `kind`, as character ranges. Strings, template
 * literals, regular expressions and JSX text are not comments: the TypeScript parser says which text is one.
 *   tsCommentRanges('f(); // a\n', ts.ScriptKind.TS) → [{ pos: 5, end: 10 }]
 */
function tsCommentRanges(text: string, kind: ts.ScriptKind): Range[] {
  const file = ts.createSourceFile("x", text, ts.ScriptTarget.Latest, true, kind);
  const ranges = new Map<number, Range>();
  const jsxTexts: ts.Node[] = [];
  // Every comment is trivia next to some token: on a line of its own it leads the next token, after code on the same
  // line it trails the one before, so the two lists of every node and token find them all. JSDoc nodes are comments
  // (their positions are inside one). JSX text is not trivia, but the scan after the tag before it reads it as some:
  // a range that starts inside JSX text is not a comment.
  const visit = (node: ts.Node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    if (node.kind === ts.SyntaxKind.JsxText) { jsxTexts.push(node); return; }
    for (const range of [...(ts.getLeadingCommentRanges(text, node.pos) ?? []), ...(ts.getTrailingCommentRanges(text, node.end) ?? [])]) ranges.set(range.pos, range);
    for (const child of node.getChildren(file)) visit(child);
  };
  visit(file);
  return [...ranges.values()].filter((range) => !jsxTexts.some((jsx) => range.pos >= jsx.pos && range.pos < jsx.end)).map(({ pos, end }) => ({ pos, end }));
}

/**
 * The comments of an .astro file, as character ranges. The frontmatter (between the opening `---` lines) and each
 * <script> body are TypeScript (tsCommentRanges); the rest is markup, where `<!-- -->` and a block comment (in a
 * <style>, or `{/* … *\/}` in the template) are the comments.
 *   astroCommentRanges("---\n// a\n---\n<!-- b -->\n") → [{ pos: 4, end: 8 }, { pos: 13, end: 23 }]
 */
function astroCommentRanges(text: string): Range[] {
  const ranges: Range[] = [];
  let markup = text;
  const code = (from: number, to: number) => {
    for (const range of tsCommentRanges(text.slice(from, to), ts.ScriptKind.TS)) ranges.push({ pos: range.pos + from, end: range.end + from });
    markup = markup.slice(0, from) + " ".repeat(to - from) + markup.slice(to);
  };
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (front) code(front[0].indexOf("\n") + 1, front[0].indexOf("\n") + 1 + front[1].length);
  for (const script of markup.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const from = script.index + script[0].indexOf(">") + 1;
    code(from, from + script[1].length);
  }
  for (const comment of markup.matchAll(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g)) ranges.push({ pos: comment.index, end: comment.index + comment[0].length });
  return ranges.sort((a, b) => a.pos - b.pos);
}

/**
 * The 1-based numbers of the lines of `text` that are inside a comment and mention review history (REVIEW_HISTORY).
 * A line with two such comments counts once. `path` only picks the dialect (.tsx: JSX; .mjs/.cjs: JavaScript;
 * .astro: astroCommentRanges).
 *   reviewHistoryLines("a.ts", 'const s = "PR #12"; // see PR #12\n') → [1]
 */
function reviewHistoryLines(path: string, text: string): number[] {
  if (!REVIEW_HISTORY.test(text)) return [];
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.[mc]js$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const ranges = path.endsWith(".astro") ? astroCommentRanges(text) : tsCommentRanges(text, kind).sort((a, b) => a.pos - b.pos);
  const lines = new Set<number>();
  let line = 1;
  let at = 0;
  for (const range of ranges) {
    for (; at < range.pos; at++) if (text[at] === "\n") line++;
    const first = line;
    text.slice(range.pos, range.end).split("\n").forEach((part, i) => { if (REVIEW_HISTORY.test(part)) lines.add(first + i); });
  }
  return [...lines].sort((a, b) => a - b);
}

function counts(files: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of files) {
    const n = reviewHistoryLines(file, readFileSync(join(PACKAGES, file), "utf8")).length;
    if (n > 0) out[file] = n;
  }
  return out;
}

describe("comments in product code do not tell review history", () => {
  const files = productFiles();
  const found = counts(files);
  if (process.env.UPDATE_REVIEW_HISTORY_BASELINE === "1") writeFileSync(BASELINE, `${JSON.stringify(found, null, 2)}\n`);
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, number>;

  it("no file has more review-history comment lines than its baseline", () => {
    expect(
      overBaseline(found, baseline),
      "say what the code is and why; the PR number, the round and the point go in the commit message, the PR comment or docs/agents/mistakes.md",
    ).toEqual([]);
  });

  it("no file has fewer than its baseline either: a removal lowers the baseline in the same change", () => {
    expect(belowBaseline(found, baseline), `lower the baseline: ${LOWER}`).toEqual([]);
  });

  it("the walk reads product source of every kind, and no tests or test helpers (a walk that found nothing would pass for nothing)", () => {
    for (const file of ["markdown/src/graphemes.ts", "frontend/src/components/CardNode.tsx", "desktop/src/main.mjs", "desktop/src/preload.cjs", "frontend/src/components/SiteLayout.astro"]) {
      expect(files, file).toContain(file);
    }
    expect(files.length).toBeGreaterThan(1000);
    expect(files.filter((file) => /\.(test|spec|testing)\.|\/(test|tests|__tests__|testing|fixtures|e2e|vendor|migrations|node_modules)\//.test(file))).toEqual([]);
  });

  it("counts a comment's mention, not a string's", () => {
    expect(reviewHistoryLines("a.ts", 'const s = "PR #12"; // see PR #12\n')).toEqual([1]);
    expect(reviewHistoryLines("a.ts", 'const s = "PR #12";\nconst t = `review of #12 ${s} round 3`;\nconst r = /PR #12/;\n')).toEqual([]);
    expect(reviewHistoryLines("a.tsx", "const x = <p>// PR #12 {/* PR #13 */}</p>;\n")).toEqual([1]);
    expect(reviewHistoryLines("a.tsx", "const x = <p>see PR #12</p>;\n")).toEqual([]);
    expect(reviewHistoryLines("a.tsx", "const x = (\n  <div>\n    // PR #12 is text here\n    <b>x</b> // and PR #13 here\n  </div>\n);\n")).toEqual([]);
    expect(reviewHistoryLines("a.ts", "requireHuman(actor); // as the POST (PR #1856 round 5)\nf();\n")).toEqual([1]);
    expect(reviewHistoryLines("a.cjs", 'const s = "PR #12"; // see PR #12\nmodule.exports = s;\n')).toEqual([1]);
  });

  it("reads an .astro file's frontmatter, scripts, styles and markup comments, not its text", () => {
    const page = [
      "---", // 1
      'const s = "PR #1"; // PR #2', // 2
      "---", // 3
      "<!-- PR #4 -->", // 4
      "<p>PR #5 in the text</p>", // 5
      "{/* PR #6 */}", // 6
      "<style>", // 7
      "  /* review round 7 */ p { color: red; }", // 8
      "</style>", // 9
      "<script>", // 10
      '  const t = "/* PR #11 */"; // PR #11', // 11
      "</script>", // 12
    ].join("\n");
    expect(reviewHistoryLines("a.astro", page)).toEqual([2, 4, 6, 8, 11]);
    expect(astroCommentRanges("---\n// a\n---\n<!-- b -->\n")).toEqual([{ pos: 4, end: 8 }, { pos: 13, end: 23 }]);
  });

  it("counts every line of a block comment that mentions it, once per line", () => {
    const text = "/**\n * Checked in parts (review of PR #1940,\n *  round 1, point 5). Nothing else here.\n */\nexport const a = 1; /* PR #1 */ // PR #2\n";
    expect(reviewHistoryLines("a.ts", text)).toEqual([2, 3, 5]);
  });

  it("knows the shapes of review history, in English and Chinese", () => {
    for (const comment of [
      "// (round 7)",
      "// review round 2, point 10",
      "// PR #1856 rounds 5–6",
      "// review of #1937, point 7",
      "// 第 2 輪審查",
      "// 審查第三輪說的",
      "// PR#12",
      "// as asked in PRs #1853 and #1854",
      "// changed in the second review round",
      "// 第三輪說要先檢查權限",
    ]) {
      expect(reviewHistoryLines("a.mjs", `${comment}\nexport const a = 1;\n`), comment).toEqual([1]);
    }
  });

  it("leaves rounds the code itself runs, placeholders and other numbers alone", () => {
    for (const comment of [
      "// one more exchange round",
      "// the next sync round 2 times",
      "// a retry round 3 starts later",
      "// after every focus round 4 a long break",
      "// 「開始第 N 輪」 / 「第 N 輪」 while a round runs",
      "// 「3 輪，共專注 75 分鐘」",
      "// no lossy utf8 round-trip; Round-2 path",
      "// colour #888888 (contract #10, issue #2001)",
      "// history-replication proposal §4.4 point 11",
      "// Round to at most 2 decimals",
      "// 審查通過之後才開始輪詢",
      "// the reason is in (#1853)",
    ]) {
      expect(reviewHistoryLines("a.ts", `${comment}\nexport const a = 1;\n`), comment).toEqual([]);
    }
  });

  it("fails a file that gains one such line, a new file that has one, and a removal the baseline did not follow", () => {
    const baseline = { "backend/src/a.ts": 2, "backend/src/c.ts": 1 };
    const same = { "backend/src/a.ts": 2, "backend/src/c.ts": 1 };
    expect([...overBaseline(same, baseline), ...belowBaseline(same, baseline)]).toEqual([]);
    expect(overBaseline({ ...same, "backend/src/a.ts": 3 }, baseline)).toEqual(["backend/src/a.ts: 3 (baseline 2)"]);
    expect(overBaseline({ ...same, "backend/src/b.ts": 1 }, baseline)).toEqual(["backend/src/b.ts: 1 (baseline 0)"]);
    expect(belowBaseline({ ...same, "backend/src/a.ts": 1 }, baseline)).toEqual(["backend/src/a.ts: 1 (baseline 2)"]);
    expect(belowBaseline({ "backend/src/a.ts": 2 }, baseline)).toEqual(["backend/src/c.ts: 0 (baseline 1)"]);
  });

  it("the ratchet still compares this baseline once it is emptied to {}", () => {
    expect(JSON_FILES.some((re) => re.test(BASELINE_IN_REPO))).toBe(true);
    const emptied = jsonGroups(BASELINE_IN_REPO, "{}\n");
    expect(compareGroups(emptied, jsonGroups(BASELINE_IN_REPO, '{ "backend/src/a.ts": 1 }'))).toEqual([
      `${BASELINE_IN_REPO}::(根)｜backend/src/a.ts：新增項目（原本沒有，現在 1）`,
    ]);
    expect(compareGroups(jsonGroups(BASELINE_IN_REPO, '{ "backend/src/a.ts": 1 }'), emptied)).toEqual([]);
  });
});
