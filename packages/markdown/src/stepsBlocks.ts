// The ```steps block (逐步圖): a note's "one step at a time" figure. The author
// writes the STATE of each step, the app does the playing and the transition
// (docs/architecture/steps-block.md). This file is the one reading of the
// syntax, shared by the app, the published site and the exports:
//
//   ````steps
//   Words about the whole figure (optional).
//
//   ## First step
//   Any Markdown: code, a mermaid diagram, an image, a list, a table.
//
//   ## Second step
//   ...
//   ````
//
// The outer fence is longer than any fence inside (CommonMark), so a step may
// hold a ``` code block. A `## ` line starts a
// step only outside the fences of the steps' own text.

import { fenceInfoWord, fenceScanner, openingFenceInfo } from "./fences.js";

export const STEPS_LANG = "steps";

export type Step = { title: string; body: string };
export type StepsDoc = {
  /** Text before the first step (the whole figure's note); "" when none. */
  intro: string;
  steps: Step[];
};

const STEP_HEADING = /^ {0,3}##(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;

const trimBlankLines = (lines: readonly string[]): string => {
  let from = 0;
  let to = lines.length;
  while (from < to && lines[from]!.trim() === "") from++;
  while (to > from && lines[to - 1]!.trim() === "") to--;
  return lines.slice(from, to).join("\n");
};

/** The block's text (what is between the outer fences) as steps. A text with
 *  no `##` line is an intro and no steps. */
export function parseSteps(source: string): StepsDoc {
  const next = fenceScanner();
  const intro: string[] = [];
  const steps: Array<{ title: string; lines: string[] }> = [];
  for (const line of source.split("\n")) {
    const kind = next(line);
    const heading = kind === "outside" ? STEP_HEADING.exec(line) : null;
    if (heading) steps.push({ title: (heading[1] ?? "").trim(), lines: [] });
    else (steps.length ? steps[steps.length - 1]!.lines : intro).push(line);
  }
  return { intro: trimBlankLines(intro), steps: steps.map((s) => ({ title: s.title, body: trimBlankLines(s.lines) })) };
}

/** The two-step sample the editor's "Step-by-step" command inserts: a literal, so
 *  the editor's menu (loaded at start) pulls in none of the parsing above. */
export const STEPS_TEMPLATE = "````steps\n## Step 1\n```js\nlet total = 0;\n```\n\n## Step 2\n```js\nlet total = 0;\nfor (const n of list) total += n;\n```\n````\n";

type Range = { start: number; end: number; closed: boolean };

/** Line ranges `[start, end)` of each top-level steps block: the opening fence
 *  line through its closing line (or the end of the text when unclosed). */
function stepsRanges(lines: readonly string[]): Range[] {
  const next = fenceScanner();
  const ranges: Range[] = [];
  let open: number | null = null;
  lines.forEach((line, i) => {
    const kind = next(line);
    if (kind === "open" && fenceInfoWord(openingFenceInfo(line) ?? "") === STEPS_LANG) open = i;
    else if (kind === "close" && open !== null) { ranges.push({ start: open, end: i + 1, closed: true }); open = null; }
  });
  if (open !== null) ranges.push({ start: open, end: lines.length, closed: false });
  return ranges;
}

/** Whether `markdown` holds a steps block (a site then ships the player). */
export function usesSteps(markdown: string): boolean {
  return markdown.includes(STEPS_LANG) && stepsRanges(markdown.split("\n")).length > 0;
}

/** `markdown` with each steps block written out as plain Markdown: its intro,
 *  then a `### title` heading and the body for each step. For readers that
 *  have no player (an export to another app, the offline HTML): the steps are
 *  all there, in order. Text without a steps block is returned as it is. */
export function expandSteps(markdown: string): string {
  if (!markdown.includes(STEPS_LANG)) return markdown;
  const lines = markdown.split("\n");
  const ranges = stepsRanges(lines);
  if (ranges.length === 0) return markdown;
  const out: string[] = [];
  let at = 0;
  for (const { start, end, closed } of ranges) {
    out.push(...lines.slice(at, start));
    const { intro, steps } = parseSteps(lines.slice(start + 1, closed ? end - 1 : end).join("\n"));
    const parts = [intro, ...steps.map((s, i) => `### ${s.title || i + 1}${s.body ? `\n\n${s.body}` : ""}`)].filter((p) => p !== "");
    out.push(parts.join("\n\n"));
    at = end;
  }
  out.push(...lines.slice(at));
  return out.join("\n");
}
