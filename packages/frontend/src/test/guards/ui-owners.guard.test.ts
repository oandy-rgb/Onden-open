// First dedupe batch of docs/research/dup-patterns-2026-10-30-fe-ui.md (items 2, 3, 5, 13, 14).
// Each rule below is an allow-list: one owner may do the thing, every other file that does
// it fails. A failure names the file and the owner — use the owner. An exception needs a
// reason, and an exception whose file no longer does the thing fails too, so lists only shrink.
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

describe("the allow-list check itself", () => {
  it("fails on a file nobody listed, and on a stale exception", () => {
    expect(() => check(["stray.css:3"], {}, "x")).toThrow();
    expect(() => check([], { "gone.css": "old" }, "x")).toThrow();
    expect(() => check(["listed.css:3"], { "listed.css": "why" }, "x")).not.toThrow();
  });
});

const rel = (file: string) => relative(SRC, file);
const cssText = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

// ── 2. Corner notices live in the top layer ────────────────────────────────────
// A modal is a native <dialog> in the top layer; nothing outside it paints above it, whatever
// the z-index. A notice that must stay readable over a modal renders through ui/TopLayerPortal.
const FIXED_OWNERS = ["components/ui/"];
// ratchet:list FIXED_KEPT
const FIXED_KEPT: Exceptions = {
};
// A notice's rule, named by `file::selector`, and the component that must render it through the portal.
// ratchet:list FIXED_NOTICES
const FIXED_NOTICES: Record<string, string> = {
};
// global.css holds many rules; each fixed one is named, so a new one there fails.
// ratchet:list FIXED_SELECTORS_KEPT
const FIXED_SELECTORS_KEPT: Exceptions = {
};
// ratchet:list FIXED_PENDING
const FIXED_PENDING: Exceptions = {
  "components/siteFrame/sitePreview.css": "pending: preview pane overlay, not reviewed in this batch",
};

const fixedKey = (r: { file: string; selector: string }) => `${r.file}::${r.selector.replace(/\s+/g, " ").trim()}`;
const isFixedRule = (r: { body: string }) => /position:\s*fixed/.test(r.body);
const inlineFixed = (line: string) => /position:\s*["'`]fixed["'`]/.test(line);

/** `file:key` of every `position: fixed` rule that is neither in ui/ nor named in a list. */
export function unlistedFixed(rules: ReturnType<typeof cssRules>, listed: Set<string>): string[] {
  return rules
    .filter(isFixedRule)
    .filter((r) => !FIXED_OWNERS.some((o) => r.file.startsWith(o)) && !listed.has(r.file) && !listed.has(fixedKey(r)))
    .map((r) => `${r.file}:${r.selector.replace(/\s+/g, " ").trim()}`);
}

describe("position: fixed (item 2)", () => {
  const rules = cssFiles().flatMap(cssRules);
  const fixedKeys = new Set(rules.filter(isFixedRule).flatMap((r) => [r.file, fixedKey(r)]));
  const listed = new Set([...Object.keys(FIXED_KEPT), ...Object.keys(FIXED_NOTICES), ...Object.keys(FIXED_SELECTORS_KEPT)]);

  it("only ui, the layout pieces and the listed notices use it", () => {
    const hits = unlistedFixed(rules, listed);
    const pending = new Set(Object.keys(FIXED_PENDING));
    expect(hits.filter((h) => !pending.has(h.split(":")[0]) && !pending.has(`${h.split(":")[0]}::${h.slice(h.indexOf(":") + 1)}`)),
      `position: fixed only in ${FIXED_OWNERS.join(", ")} (plus the lists in this file); a notice goes through ui/TopLayerPortal`).toEqual([]);
    const listedAll = [...Object.keys(FIXED_KEPT), ...Object.keys(FIXED_NOTICES), ...Object.keys(FIXED_SELECTORS_KEPT), ...Object.keys(FIXED_PENDING)];
    expect(listedAll.filter((k) => !fixedKeys.has(k)), "these entries no longer use position: fixed — drop them").toEqual([]);
  });

  it("no component sets position: fixed inline", () => {
    const uses = sourceFiles(".")
      .filter((f) => !FIXED_OWNERS.some((o) => rel(f).startsWith(o)))
      .flatMap((f) => codeLines(f).flatMap((line, i) => (inlineFixed(line) ? [`${rel(f)}:${i + 1}`] : [])));
    expect(uses, "a fixed-position surface goes through ui/TopLayerPortal, ui/Popover or ui/Modal").toEqual([]);
  });

  it("every fixed-position notice renders through TopLayerPortal", () => {
    for (const [css, tsx] of Object.entries(FIXED_NOTICES)) {
      expect(fixedKeys, `${css} lost its position: fixed — drop it from FIXED_NOTICES`).toContain(css);
      expect(readFileSync(`${SRC}/${tsx}`, "utf8"), `${tsx} must render through TopLayerPortal`).toMatch(/<TopLayerPortal>/);
    }
  });

  it("self-check: an unlisted rule, a new rule in a listed file, and inline fixed are found", () => {
    const rule = (file: string, selector: string) => ({ file, line: 1, media: [], selector, body: "position: fixed" });
    const only = new Set(["styles/global.css::.toast-stack", "components/MobileNav.css"]);
    expect(unlistedFixed([rule("styles/global.css", ".toast-stack")], only)).toEqual([]);
    expect(unlistedFixed([rule("styles/global.css", ".new-banner")], only)).toHaveLength(1);
    expect(unlistedFixed([rule("components/Other.css", ".x")], only)).toHaveLength(1);
    expect(unlistedFixed([rule("components/MobileNav.css", ".x")], only)).toEqual([]);
    expect(inlineFixed('style={{ position: "fixed", top: 0 }}')).toBe(true);
    expect(inlineFixed("style={{ position: 'fixed' }}")).toBe(true);
    expect(inlineFixed('style={{ position: "absolute" }}')).toBe(false);
  });
});

// ── 3. One switch ──────────────────────────────────────────────────────────────
const hasRoleSwitch = (line: string) => /role=(?:["']switch["']|\{\s*["'`]switch["'`]\s*\})/.test(line);

describe('role="switch" (item 3)', () => {
  it("only components/ui writes it; use ui/Switch", () => {
    const uses = sourceFiles(".")
      .filter((f) => !rel(f).startsWith("components/ui/"))
      .flatMap((f) => codeLines(f).flatMap((line, i) => (hasRoleSwitch(line) ? [`${rel(f)}:${i + 1}`] : [])));
    expect(uses).toEqual([]);
  });

  it("self-check: both hand-written forms are recognised", () => {
    expect(hasRoleSwitch('<input type="checkbox" role="switch" />')).toBe(true);
    expect(hasRoleSwitch("<button role='switch' aria-checked>")).toBe(true);
    expect(hasRoleSwitch("<button role={'switch'}>")).toBe(true);
    expect(hasRoleSwitch('<input role={ "switch" } />')).toBe(true);
    expect(hasRoleSwitch('<button role="button">')).toBe(false);
  });
});

// ── 5. One inline error line ───────────────────────────────────────────────────
// A class named *-error that colours text is an error line written by hand. ui/FieldError owns it.
const ERROR_OWNER = "components/ui/FieldError.css";
// ratchet:list ERROR_PENDING
const ERROR_PENDING: Exceptions = {
  "styles/global.css": "pending: an open PR is editing this file; .login-error there is unused now and goes with it",
  "components/history/WorkspaceHistory.css": "pending: .wh-error is still used by files an open PR is editing (RewindConfirm, WorkspaceHistoryUndoCard)",
  "modules/rss/RssSheets.css": "pending: .rss-sheet-error is still used by RssSourceSheet, which an open PR is editing",
  "components/ServerSetup.css": "not migrated in this batch (first-connection screen)",
  "components/NodeAttributesPanel.css": "not migrated in this batch",
  "components/collections/CollectionView.css": "not migrated in this batch (cv-error, cell and quick-add errors)",
  "components/views/BaseRenderer.css": "not migrated in this batch",
  "components/PdfNodeView.css": "not migrated in this batch",
  "components/OndenQueryBlock.css": "not migrated in this batch",
  "components/MarkdownRenderer.css": "not migrated in this batch",
  "settings/SettingsModal.css": "not migrated in this batch (ai-key, import and system errors)",
  "modules/review/ReviewPanel.css": "not migrated in this batch",
};

const ERROR_CLASS = /\.[\w-]*(?:-error(?:-text|-msg|-message)?|-errors|-err)(?![\w-])/;

export function errorColourClasses(rules: ReturnType<typeof cssRules>): string[] {
  return rules
    .filter((r) => r.file !== ERROR_OWNER && /(^|[^\w-])color\s*:/.test(r.body)
      && r.selector.split(",").some((part) => ERROR_CLASS.test(part.trim().split(/[\s>+~]+/).pop() ?? "")))
    .map((r) => `${r.file}:${r.line}`);
}

describe("inline error text (item 5)", () => {
  it("only ui/FieldError colours an error line", () => {
    check(cssFiles().flatMap((f) => errorColourClasses(cssRules(f))), ERROR_PENDING, `use <FieldError> (${ERROR_OWNER}); do not write a *-error class with a colour`);
  });

  it("FieldError uses the error token and no hex fallback", () => {
    const rule = cssRules(`${SRC}/${ERROR_OWNER}`).find((r) => r.selector === ".ui-error");
    expect(rule?.body).toMatch(/color:\s*var\(--ac-danger\)/);
    expect(rule?.body).not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  it("self-check: a hand-written error class is found", () => {
    const fake = { file: "x.css", line: 1, media: [], selector: ".thing-error", body: "color: red" };
    expect(errorColourClasses([fake])).toEqual(["x.css:1"]);
    expect(errorColourClasses([{ ...fake, selector: ".thing-error-icon" }])).toEqual([]);
    for (const name of [".thing-err", ".thing-error-text", ".thing-errors", ".a .thing-error-msg"]) {
      expect(errorColourClasses([{ ...fake, selector: name }]), name).toEqual(["x.css:1"]);
    }
  });
});

// ── 13/14. @keyframes ──────────────────────────────────────────────────────────
// A name is defined once, and something uses it.
// ratchet:list KEYFRAMES_DUPLICATED
const KEYFRAMES_DUPLICATED: Exceptions = {
  "styles/global.css": "pending: an open PR is editing this file; spin, onden-fade-in and onden-pop-in are defined twice there until it merges",
};

describe("@keyframes (items 13, 14)", () => {
  const defs: { name: string; file: string }[] = [];
  const allCss = cssFiles();
  for (const file of allCss) for (const m of cssText(file).matchAll(/@keyframes\s+([\w-]+)/g)) defs.push({ name: m[1], file: rel(file) });

  it("each name is defined in one place", () => {
    const seen = new Map<string, string[]>();
    defs.forEach((d) => seen.set(d.name, [...(seen.get(d.name) ?? []), d.file]));
    const dup = [...seen].filter(([, files]) => files.length > 1).map(([name, files]) => `${files[0]}:${name}`);
    check(dup, KEYFRAMES_DUPLICATED, "a @keyframes name may be defined once in the whole stylesheet set");
  });

  it("each name is used by an animation", () => {
    const text = [...allCss.map(cssText), ...sourceFiles(".").map((f) => readFileSync(f, "utf8"))].join("\n");
    const unused = [...new Set(defs.map((d) => d.name))].filter((name) => !new RegExp(`animation(?:-name)?\\s*:[^;]*\\b${name}\\b`).test(text));
    expect(unused, "dead @keyframes: delete them").toEqual([]);
  });
});
