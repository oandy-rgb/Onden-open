// Second dedupe batch of docs/research/dup-patterns-2026-10-30-fe-ui.md (items 4, 6, 7, 8, 9, 12, 14).
// Each rule is an allow-list or a baseline that only shrinks: a failure names the file and the
// owner — use the owner. An exception needs a reason, and an exception whose file no longer
// breaks the rule fails too, so the lists only shrink. "pending: open PR" = the file is being
// edited by an unmerged PR; move it to the owner when that PR has merged.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { describe, expect, it } from "vitest";
import { codeLines, cssFiles, cssRules, SRC, sourceFiles } from "./sources";

type Exceptions = Record<string, string>;

function check(hits: string[], exceptions: Exceptions, what: string) {
  const files = new Set(hits.map((h) => h.split(":")[0]));
  expect(hits.filter((h) => !(h.split(":")[0] in exceptions)), what).toEqual([]);
  expect(Object.keys(exceptions).filter((f) => !files.has(f)), "these exceptions no longer need to be listed").toEqual([]);
}

/** A count that may only go down: more is a new violation, fewer means the baseline must be lowered. */
function countNoMoreThan(actual: number, baseline: number, what: string) {
  expect(actual, `${what}: more than the baseline — use the owner instead of a new one`).toBeLessThanOrEqual(baseline);
  expect(actual, `${what}: fewer than the baseline — lower the baseline in this file to ${actual}`).toBe(baseline);
}

const PENDING = "pending: an open PR is editing this file";
const rel = (file: string) => relative(SRC, file);
const allRules = () => cssFiles().flatMap(cssRules);
const cssText = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
const decls = (rule: { body: string }, prop: string) =>
  [...rule.body.matchAll(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, "g"))].map((m) => m[1].trim());

describe("the allow-list helpers themselves", () => {
  it("fail on a file nobody listed, a stale exception, and a baseline that is off", () => {
    expect(() => check(["stray.css:3"], {}, "x")).toThrow();
    expect(() => check([], { "gone.css": "old" }, "x")).toThrow();
    expect(() => check(["listed.css:3"], { "listed.css": "why" }, "x")).not.toThrow();
    expect(() => countNoMoreThan(3, 2, "x")).toThrow();
    expect(() => countNoMoreThan(1, 2, "x")).toThrow();
    expect(() => countNoMoreThan(2, 2, "x")).not.toThrow();
  });
});

// ── 7. Three breakpoints: 600 / 900 / 1280 ─────────────────────────────────────
// A pair such as max-width 599 / min-width 600 is the same breakpoint. CSS cannot read the
// constants in lib/mediaQuery.ts, so the numbers are written out and this guard keeps them equal.
const BREAKPOINT_WIDTHS = new Set([599, 600, 601, 899, 900, 901, 1279, 1280, 1281]);
// ratchet:list BREAKPOINTS_PENDING
const BREAKPOINTS_PENDING: Exceptions = {
};
const offGridWidths = (css: string) =>
  [...css.matchAll(/@media[^{]*/g)].flatMap((m) =>
    [...m[0].matchAll(/(?:max|min)-width:\s*([\d.]+)(px|em|rem)?/g)]
      .filter((w) => w[2] !== "px" || !BREAKPOINT_WIDTHS.has(Number(w[1])))
      .map((w) => w[0]));

describe("breakpoints (item 7)", () => {
  it("@media widths in CSS are 600, 900 or 1280 (±1)", () => {
    const hits = cssFiles().flatMap((f) => offGridWidths(cssText(f)).map((w) => `${rel(f)}:${w}`));
    check(hits, BREAKPOINTS_PENDING, "an @media width other than 600 / 900 / 1280px; pick the nearest of the three");
  });

  it("JS media queries come from lib/mediaQuery.ts and use the same three widths", () => {
    const uses = sourceFiles(".")
      .filter((f) => rel(f) !== "lib/mediaQuery.ts")
      .flatMap((f) => codeLines(f).flatMap((line, i) => (/\((?:max|min)-width\s*:/.test(line) ? [`${rel(f)}:${i + 1}`] : [])));
    expect(uses, "a width media query in JS goes through lib/mediaQuery (MOBILE_QUERY / BREAKPOINT_PX)").toEqual([]);
    const hook = readFileSync(`${SRC}/lib/mediaQuery.ts`, "utf8");
    expect(hook).toMatch(/BREAKPOINT_PX\s*=\s*\{\s*phone:\s*600,\s*mobile:\s*900,\s*wide:\s*1280\s*\}/);
    expect(hook).toMatch(/MOBILE_QUERY\s*=\s*`\(max-width:\s*\$\{BREAKPOINT_PX\.mobile\}px\)`/);
  });

  it("self-check: an off-grid width is found, a paired one is not", () => {
    expect(offGridWidths("@media (max-width: 640px) { }")).toHaveLength(1);
    expect(offGridWidths("@media (min-width: 72em) { }")).toHaveLength(1);
    expect(offGridWidths("@media (max-width: 900px), (pointer: coarse) { } @media (min-width: 901px) and (max-width: 1279px) { }")).toEqual([]);
  });
});

// ── 4. One empty state: ui-level EmptyState ─────────────────────────────────────
// `-empty` rules and `className="…-empty"` elements are the hand-made ones. They only go down;
// each one moves to <EmptyState size="inline" title=… /> (one line) or the panel/page sizes.
const EMPTY_CSS_BASELINE = 31;
const EMPTY_TSX_BASELINE = 35;
const emptyClass = /(?<![\w-])[a-z0-9]+(?:-[a-z0-9]+)*-empty(?![\w-])/;
const handMadeEmptyCss = (rules: ReturnType<typeof cssRules>) =>
  rules.filter((r) => r.file !== "components/EmptyState.css" && r.selector.split(",").some((s) => emptyClass.test(s.replace(/\.onden-empty-state\S*/g, ""))));
const handMadeEmptyTsx = (line: string) => /className=[^>]*["'`\s]([a-z0-9]+(?:-[a-z0-9]+)*-empty)(?![\w-])/.test(line.replace(/onden-empty-state\S*/g, ""));

describe("empty states (item 4)", () => {
  it("hand-made -empty CSS rules only go down", () => {
    countNoMoreThan(handMadeEmptyCss(allRules()).length, EMPTY_CSS_BASELINE, "CSS rules named *-empty");
  });

  it("hand-made className=*-empty elements only go down", () => {
    const uses = sourceFiles(".").flatMap((f) => codeLines(f).filter(handMadeEmptyTsx));
    countNoMoreThan(uses.length, EMPTY_TSX_BASELINE, "JSX elements with a *-empty class");
  });

  it("self-check", () => {
    expect(handMadeEmptyTsx('<p className="foo-empty">x</p>')).toBe(true);
    expect(handMadeEmptyTsx('<p className={`a ${b} foo-empty`}>x</p>')).toBe(true);
    expect(handMadeEmptyTsx('<EmptyState size="inline" className="foo-empty--center" />')).toBe(false);
    expect(handMadeEmptyTsx('<div className="onden-empty-state">')).toBe(false);
    expect(handMadeEmptyCss([{ file: "a.css", line: 1, media: [], selector: ".foo-empty", body: "" }])).toHaveLength(1);
    expect(handMadeEmptyCss([{ file: "a.css", line: 1, media: [], selector: ".foo-empty--x", body: "" }])).toHaveLength(0);
  });
});

// ── 6. One close button: ui/CloseButton ─────────────────────────────────────────
// The ✕ of a dialog, sheet or panel header is <CloseButton/> (Button variant="icon": 44px where the
// pointer is a finger, one icon size). No `*-close` class of its own, no hand-made aria-label "Close".
const CLOSE_OWNER = "components/ui/";
// ratchet:list CLOSE_PENDING
const CLOSE_PENDING: Exceptions = {
  "components/NodeAttributesPanel.css": `${PENDING}; .attr-panel-close`,
  "components/history/NoteHistory.tsx": `${PENDING}; two .nh-icon close buttons`,
  "settings/SettingsModal.tsx": `${PENDING}; the settings header ✕`,
  "styles/global.css": `${PENDING}; .toast-close`,
};
const closeClass = /\.[a-z0-9-]*-close(?![\w-])/;
const handMadeClose = (line: string) => /aria-label=\{t\("Close"\)\}/.test(line);

describe("close buttons (item 6)", () => {
  it("no *-close class outside ui/", () => {
    const hits = cssFiles().filter((f) => !rel(f).startsWith(CLOSE_OWNER))
      .flatMap((f) => cssRules(f).filter((r) => closeClass.test(r.selector)).map((r) => `${r.file}:${r.line}`));
    check(hits, Object.fromEntries(Object.entries(CLOSE_PENDING).filter(([f]) => f.endsWith(".css"))), "a close button's size comes from <CloseButton/> (ui/)");
  });

  it('no hand-made aria-label={t("Close")} outside ui/', () => {
    const hits = sourceFiles(".").filter((f) => !rel(f).startsWith(CLOSE_OWNER))
      .flatMap((f) => codeLines(f).flatMap((line, i) => (handMadeClose(line) ? [`${rel(f)}:${i + 1}`] : [])));
    check(hits, Object.fromEntries(Object.entries(CLOSE_PENDING).filter(([f]) => f.endsWith(".tsx"))), "the ✕ of a dialog or panel is <CloseButton/> from components/ui");
  });

  it("self-check", () => {
    expect(closeClass.test(".palette-close:hover")).toBe(true);
    expect(closeClass.test(".closeness")).toBe(false);
    expect(handMadeClose('<button aria-label={t("Close")} onClick={x}>')).toBe(true);
    expect(handMadeClose("<CloseButton onClick={x} />")).toBe(false);
  });
});

// ── 8. One focus ring: --ac-focus-outline ───────────────────────────────────────
// A visible outline is `outline: var(--ac-focus-outline)` with `outline-offset` of --ac-focus-offset
// (outside) or --ac-focus-inset (rows that clip). `outline: none` only goes down.
// ratchet:list OUTLINE_PENDING
const OUTLINE_PENDING: Exceptions = {
  "modules/tasks/tasks.css": PENDING,
  "components/history/WorkspaceHistory.css": PENDING,
  "components/history/NoteHistory.css": PENDING,
  "components/AppTopbar.css": PENDING,
  "settings/SettingsModal.css": PENDING,
  "styles/global.css": PENDING,
  "styles/sidebar.css": PENDING,
  "modules/website/studio/StyleChoices.css": "the selected swatch draws a gap ring in the page colour, not a focus ring",
};
const OUTLINE_OWNER = "styles/tokens.css";
const OUTLINE_NONE_BASELINE = 38;
const isNone = (v: string) => /^(none|0)$/.test(v);
const badOutline = (r: { body: string }) =>
  decls(r, "outline").some((v) => !isNone(v) && v !== "var(--ac-focus-outline)") ||
  decls(r, "outline-offset").some((v) => !/^var\(--ac-focus-(offset|inset)\)$/.test(v));

describe("focus ring (item 8)", () => {
  it("outline and outline-offset use the focus tokens", () => {
    const hits = allRules().filter((r) => r.file !== OUTLINE_OWNER && badOutline(r)).map((r) => `${r.file}:${r.line}`);
    check(hits, OUTLINE_PENDING, "write `outline: var(--ac-focus-outline); outline-offset: var(--ac-focus-offset)` (or --ac-focus-inset)");
  });

  it("`outline: none` only goes down", () => {
    const n = allRules().reduce((sum, r) => sum + decls(r, "outline").filter(isNone).length, 0);
    countNoMoreThan(n, OUTLINE_NONE_BASELINE, "outline: none declarations");
  });

  it("self-check", () => {
    expect(badOutline({ body: "outline: 2px solid red; outline-offset: 2px" })).toBe(true);
    expect(badOutline({ body: "outline: 2px solid var(--accent);" })).toBe(true);
    expect(badOutline({ body: "outline: var(--ac-focus-outline); outline-offset: var(--ac-focus-inset)" })).toBe(false);
    expect(badOutline({ body: "outline: none" })).toBe(false);
    expect(badOutline({ body: "outline-offset: -2px" })).toBe(true);
  });
});

// ── 9. One layer table: --z-* ────────────────────────────────────────────────────
// ratchet:list Z_PENDING
const Z_PENDING: Exceptions = {
};
// The board's own chrome layer is owned by boardChrome.guard.test.ts (--board-chrome-z).
const badZ = (r: { body: string }) => decls(r, "z-index").some((v) => !/^var\(--(z-[a-z0-9-]+|board-chrome-z)(,\s*\d+)?\)$/.test(v));

describe("z-index (item 9)", () => {
  it("every z-index is a --z-* token from styles/tokens.css", () => {
    const hits = allRules().filter(badZ).map((r) => `${r.file}:${r.line}`);
    check(hits, Z_PENDING, "use a layer from the --z-* table in styles/tokens.css; a new layer is a new token there");
  });

  it("every --z-* a stylesheet uses is defined", () => {
    const tokens = new Set([...cssText(`${SRC}/styles/tokens.css`).matchAll(/(--z-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = cssFiles().flatMap((f) => [...cssText(f).matchAll(/var\((--z-[a-z0-9-]+)\)/g)].map((m) => m[1]));
    expect(used.filter((u) => !tokens.has(u))).toEqual([]);
  });

  it("self-check", () => {
    expect(badZ({ body: "z-index: 10;" })).toBe(true);
    expect(badZ({ body: "z-index: var(--z-toast);" })).toBe(false);
    expect(badZ({ body: "z-index: var(--board-chrome-z, 12);" })).toBe(false);
  });
});

// ── 12. Chips: ui/Chip ───────────────────────────────────────────────────────────
// A read-only label is <Chip tone=…/>. The classes below are the ones still hand-made (most are
// pressable, which is a Button, or sit in a file an open PR edits); a new chip/badge/pill class fails.
// ratchet:list CHIP_CLASSES_KEPT
const CHIP_CLASSES_KEPT = [
  "app-colors__chip", "bases-list-badge", "canvas-back-pill", "card-node-ai-badge",
  "cv-cal-chip", "cv-cal-chips", "cv-gallery-badge", "cv-gallery-badge-key",
  "cv-gallery-badge-val", "cv-gallery-badges", "cv-kanban-badge", "cv-kanban-badge-key",
  "cv-kanban-badge-val", "cv-kanban-card-badges", "cv-view-chip", "cv-view-chip--active",
  "cv-view-chip-layout", "cv-view-chip-name", "function-chip", "inbox-filter-chip",
  "md-link-chip", "md-task-chip", "member-badge", "member-badge--pending",
  "nh-pill", "nh-pill--float", "note-readonly-badge", "pnl-here-badge",
  "quick-add-chip", "quick-add-chips", "rss-dest-chip",
  "space-chip", "tag-extends-chip",
  "tag-function-chip", "tk-chip", "tk-chip--deadline", "tk-chip--deadline-soon",
  "tk-chip--evening", "tk-chip--overdue", "tk-chip--recur", "tk-chips",
  "tk-pill", "tk-pill--on", "tk-pills", "user-badge",
  "user-badge--error", "user-badge--offline", "user-chip", "wh-cut-badge",
];
const chipClassIn = (selector: string) => [...selector.matchAll(/\.([a-z0-9_-]*(?:chip|badge|pill)[a-z0-9_-]*)/gi)].map((m) => m[1]);
const KEPT = new Set(CHIP_CLASSES_KEPT);

describe("chips and badges (item 12)", () => {
  const seen = () => new Set(allRules().filter((r) => !r.file.startsWith("components/ui/")).flatMap((r) => chipClassIn(r.selector)));

  it("no new chip / badge / pill class", () => {
    expect([...seen()].filter((c) => !KEPT.has(c)),
      "a read-only label is <Chip> from components/ui; a pressable one is a Button").toEqual([]);
  });

  it("the kept list has no class that is gone", () => {
    const s = seen();
    expect(CHIP_CLASSES_KEPT.filter((c) => !s.has(c)), "these chip classes no longer exist — drop them from CHIP_CLASSES_KEPT").toEqual([]);
  });

  it("self-check", () => {
    expect(chipClassIn(".foo-badge:hover .x")).toEqual(["foo-badge"]);
    expect(chipClassIn(".plain")).toEqual([]);
  });
});

// ── 14. One @keyframes per name, no dead CSS ──────────────────────────────────────
// ratchet:list KEYFRAMES_PENDING
const KEYFRAMES_PENDING: Exceptions = {
  "styles/global.css": `${PENDING}; spin, onden-fade-in and onden-pop-in are each defined twice there (delete the second copy of each)`,
};
export function duplicateKeyframes(files: { file: string; css: string }[]): string[] {
  const seen = new Map<string, string[]>();
  for (const { file, css } of files)
    for (const m of css.matchAll(/@keyframes\s+([\w-]+)/g)) seen.set(m[1], [...(seen.get(m[1]) ?? []), file]);
  return [...seen].filter(([, where]) => where.length > 1).flatMap(([name, where]) => [...new Set(where)].map((f) => `${f}:${name}`));
}
// ratchet:list DEAD_CLASSES
const DEAD_CLASSES: Exceptions = {
  "styles/global.css": `${PENDING}; .segmented-control has no user (the real segmented groups are hand-made)`,
};

describe("keyframes and dead CSS (item 14)", () => {
  it("a @keyframes name is defined once across all stylesheets", () => {
    const hits = duplicateKeyframes(cssFiles().map((f) => ({ file: rel(f), css: cssText(f) })));
    check(hits, KEYFRAMES_PENDING, "delete the second copy; one @keyframes per name");
  });

  it(".segmented-control (no user) is gone", () => {
    const hits = allRules().filter((r) => /\.segmented-control(?![\w-])/.test(r.selector)).map((r) => `${r.file}:${r.line}`);
    check(hits, DEAD_CLASSES, "dead CSS: delete it");
  });

  it("self-check", () => {
    expect(duplicateKeyframes([{ file: "a.css", css: "@keyframes x {}" }, { file: "b.css", css: "@keyframes x {}" }])).toHaveLength(2);
    expect(duplicateKeyframes([{ file: "a.css", css: "@keyframes x {} @keyframes y {}" }])).toEqual([]);
    expect(duplicateKeyframes([{ file: "a.css", css: "@keyframes x {} @keyframes x {}" }])).toEqual(["a.css:x"]);
  });
});
