// Guard for the 2026-10-30 "markdown text" dedupe batch (docs/research/dup-patterns-2026-10-30-render.md
// A1 A4 A6 A7 A11, dup-patterns-2026-10-30-cross.md 2 7 14). Each rule names the one file that may do
// the thing; any other file that does it fails. An exception says why it is not "doing it again", and
// one that no longer matches fails too, so the lists only shrink. The frontend half (MarkdownRenderer
// surfaces, `<mark>`) is packages/frontend/src/test/guards/dup-b2-text.guard.test.ts.
import { describe, expect, it } from "vitest";
import { FILES, staleAllowances, violations, type OwnerRule } from "./sources";

function check(rule: OwnerRule, { onlyIn }: { onlyIn?: RegExp } = {}) {
  const files = onlyIn ? FILES.filter((f) => onlyIn.test(f.path)) : FILES;
  describe(rule.what, () => {
    it("is done only by its owner", () => {
      expect(violations(files, rule), "use the owner's function instead of writing it again").toEqual([]);
    });
    it("lists no exception that stopped matching", () => {
      const exceptions = Object.keys(rule.exceptions ?? {});
      expect(staleAllowances(files, rule).filter((path) => exceptions.includes(path))).toEqual([]);
    });
    it.each(rule.samples)("sees a violation in: %s", (sample) => {
      expect(violations([{ path: "somewhere/else.ts", text: sample }], rule)).toEqual(["somewhere/else.ts"]);
    });
  });
}

type Rule = OwnerRule & { samples: string[] };

// ── A1: Markdown down to plain words ────────────────────────────────────────
check({
  what: "emphasis, strikethrough and code marks are stripped by plainText.ts (plainInline) only",
  pattern: /\[[*_~`>=]{3,}\]/,
  owners: ["markdown/src/plainText.ts"],
  exceptions: {
  },
  samples: ["const s = text.replace(/[*_~`]/g, '');", "x.replace(/[*_~`>]/g, '')"],
} as Rule);

check({
  what: "heading hashes and list / task markers in front of a line are stripped by plainText.ts (stripLineMarker) only",
  pattern: /\.replace\(\s*\/\^[^/\n]*(?:#\{1,6\}|\\\[\[ xX\]\\\])/,
  owners: ["markdown/src/plainText.ts"],
  exceptions: {
    "markdown/src/blocks.ts": "block label; in-flight PR on this file — use stripLineMarker after those land",
    "markdown/src/paragraphs.ts": "paragraph diff sampling; in-flight PR on this file",
  },
  samples: ["line.replace(/^#{1,6}\\s+/, '')", "line.replace(/^\\s*(?:[-+*])\\s+(?:\\[[ xX]\\]\\s+)?/, '')"],
} as Rule);

check({
  what: "a `[ ]` / `[x]` task box regex is written only in plainText.ts (checklistLine)",
  pattern: /\\\[\[ xX\]\\\]/,
  owners: ["markdown/src/plainText.ts"],
  exceptions: {
    "markdown/src/mentions.ts": "a mention inside a task item: reads the box to skip it (TASK_BOX), part of the mentions block reader",
    "markdown/src/paragraphs.ts": "paragraph diff sampling; in-flight PR on this file",
    "markdown/src/blocks.ts": "block label; in-flight PR on this file",
    "frontend/src/components/MarkdownEditor.tsx": "Enter on a task line; in-flight PR on this file — use checklistLine after it lands",
  },
  samples: ["const TASK = /^\\[[ xX]\\]\\s+/;"],
} as Rule);

// ── A11: "this line is fenced code" ─────────────────────────────────────────
check({
  what: "a ``` / ~~~ fence is detected by fences.ts only",
  pattern: /`\{3,\}|~\{3,\}|\(```\|~~~\)|\["`~"\]|startsWith\(["'](?:```|~~~)/,
  owners: ["markdown/src/fences.ts"],
  exceptions: {
    "markdown/src/paragraphs.ts": "FENCE_LINE in paragraph splitting; in-flight PR on this file",
    "backend/src/services/exportZip.ts": "one regex for fenced blocks AND inline code spans (code is quoted as written); not a line-by-line fence reader",
  },
  samples: ["const FENCE = /^ {0,3}(`{3,}|~{3,})/;", "if (/^\\s*(```|~~~)/.test(raw)) {"],
} as Rule);

// ── A6: [[wikilink]] is found by the linear scanner ─────────────────────────
check({
  what: "a `[[…]]` regex literal is written only where the linear scanner cannot serve",
  pattern: /\/[^/\n]*\\\[\\\[[^/\n]*\/[gimsuy]*/,
  owners: ["markdown/src/text.ts"],
  exceptions: {
    "frontend/src/lib/editorCompletion.ts": "detects a half-typed `[[` before the caret (nothing is closed yet, scanWikilinks finds closed links)",
    "backend/src/modules/rss/htmlToMarkdown.ts": "escapes `[[` in imported text so it is not read as a link",
  },
  samples: ["s.replace(/\\[\\[([^\\]]*)\\]\\]/g, '$1')"],
} as Rule);

// ── cross 2: frontmatter `---` fences ───────────────────────────────────────
check({
  what: "the `---` frontmatter fence of a note is found by @onden/markdown frontmatter.ts (frontmatterEndLine / readFrontmatter) only",
  pattern: /["'`]---["'`]|\/\^---/,
  owners: ["markdown/src/frontmatter.ts"],
  exceptions: {
    "frontend/src/lib/whatsNew.ts": "reads the changes/ files' own header, a separate format",
  },
  samples: ["if (doc.line(1).text.trimEnd() !== \"---\") return false;", "const head = /^---\\r?\\n([\\s\\S]*?)\\r?\\n---/.exec(source);"],
} as Rule, { onlyIn: /^frontend\// });

// ── cross 14: a cut text ends in "…" through ellipsize ──────────────────────
check({
  what: "cutting a text and adding `…` by hand (cutToUnits(…) + \"…\") — use ellipsize (the limit includes the `…`)",
  pattern: /cutToUnits\([^\n]*\}…|cutToUnits\([^\n]*\)\s*\+\s*["'`]…/,
  owners: [],
  samples: ["const clip = (s) => `${cutToUnits(s, 40)}…`;", "return cutToUnits(line, 60) + \"…\";"],
} as Rule, { onlyIn: /^(frontend|backend|site)\// });
