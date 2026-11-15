// On a phone or small window an input's text is sized in one place: styles/input-font.css
// (16px or the text-size setting if larger — below 16px iOS zooms the page on
// focus; an input that should be bigger sets `--onden-input-size`). Inside a
// phone/touch breakpoint, no other rule may
// set `font-size` on an input, textarea, select or contenteditable, or on a class
// an <input>/<textarea>/<select> carries. Desktop rules are free: the touch rule
// outranks them where it applies.
//
// A failure names the rule. Delete its `font-size`; do not add the file to
// EXCEPTIONS. An exception needs a reason, and one whose file no longer breaks
// the rule fails too, so the list only shrinks.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { cssFiles, cssRules, SRC, sourceFiles, type CssRule } from "./sources";

const OWNER = "styles/input-font.css";
const BIGGER = "--onden-input-size";
const TOUCH_MEDIA = /max-width|pointer:\s*coarse|hover:\s*none|any-pointer/;
// Classes a library puts on its contenteditable element (CodeMirror's text area), which no TSX names.
const LIBRARY_EDITABLE = ["cm-content", "ProseMirror"];
const NOT_TEXT_INPUT = /^(checkbox|radio|range|color|file|hidden|button|submit|reset|image)$/;

// ratchet:list EXCEPTIONS
const EXCEPTIONS: Record<string, string> = {
  "styles/global.css": "pending: an open PR is editing this file; its older 16px floor (and the .bubble-link-input one) go when it merges",
  "components/CreateSheet.css": "pending: an open PR (one bottom sheet) is editing this file; delete its own 16px with that PR's follow-up",
  "modules/tasks/QuickAddTask.css": "pending: an open PR is editing this file; delete its own 16px with that PR's follow-up",
};

/** String literals inside a JSX `className` value: "a b", {`a ${x}`}, {classNames("a", on && "b")}, {cond ? "a" : "b"}. */
function classNameLiterals(tag: string): string[] {
  const at = /\bclassName=/.exec(tag);
  if (!at) return [];
  let i = at.index + at[0].length;
  let expr = "";
  if (tag[i] === '"') expr = tag.slice(i, tag.indexOf('"', i + 1) + 1);
  else if (tag[i] === "{") {
    let depth = 0;
    for (let j = i; j < tag.length; j++) {
      if (tag[j] === "{") depth++;
      else if (tag[j] === "}" && --depth === 0) { expr = tag.slice(i, j + 1); break; }
    }
  }
  const texts: string[] = [];
  const quoted = (code: string) => { for (const m of code.matchAll(/"([^"]*)"|'([^']*)'/g)) texts.push(m[1] ?? m[2]); };
  const rest = expr.replace(/`([^`]*)`/g, (_, template: string) => {
    texts.push(template.replace(/\$\{([^}]*)\}/g, (_x, inner: string) => { quoted(inner); return " "; }));
    return " ";
  });
  quoted(rest);
  return texts.flatMap((text) => text.split(/\s+/).filter(Boolean));
}

/** Class names carried by text-entry <input>, <textarea>, <select> (or their components/ui TextField, TextArea, Select) and contentEditable elements. */
export function inputClasses(source: string): Set<string> {
  const classes = new Set<string>();
  for (const open of source.matchAll(/<([a-zA-Z][\w.]*)\b/g)) {
    let depth = 0;
    let end = open.index! + open[0].length;
    for (; end < source.length; end++) {
      const ch = source[end];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0 && source[end - 1] !== "=") break;
    }
    const tag = source.slice(open.index!, end);
    const editable = /\bcontentEditable\b/.test(tag);
    if (!editable && !/^(input|textarea|select|TextField|TextArea|Select)$/.test(open[1])) continue;
    const type = /\btype="([^"]+)"/.exec(tag)?.[1];
    if (!editable && type && NOT_TEXT_INPUT.test(type)) continue;
    classNameLiterals(tag).forEach((c) => classes.add(c));
  }
  return classes;
}

function targetsInput(selector: string, classes: Set<string>): boolean {
  return selector.split(",").some((part) => {
    const subject = part.trim().split(/[\s>+~]+/).pop() ?? "";
    if (/(^|[^\w-])(input|textarea|select)(?![\w-])/.test(subject.replace(/\.[\w-]+/g, ""))) return true;
    if (/\[contenteditable/.test(subject)) return true;
    if (LIBRARY_EDITABLE.some((c) => new RegExp(`\\.${c}(?![\\w-])`).test(subject))) return true;
    return [...subject.matchAll(/\.([\w-]+)/g)].some((m) => classes.has(m[1]));
  });
}

const fontSizeOf = (rule: CssRule) => /(?:^|[;\s])font-size\s*:\s*([^;]+)/.exec(rule.body)?.[1];
const where = (rule: CssRule) => `${rule.file}:${rule.line} ${rule.selector.replace(/\s+/g, " ")}`;

/** Rules inside a touch breakpoint that set an input's `font-size` at all. */
export function strayInputFontRules(rules: CssRule[], classes: Set<string>): string[] {
  return rules
    .filter((r) => r.file !== OWNER && r.media.some((m) => TOUCH_MEDIA.test(m)) && fontSizeOf(r) && targetsInput(r.selector, classes))
    .map(where);
}

/** Input classes that rebuild the 16px floor themselves, in any breakpoint. */
export function floorImitations(rules: CssRule[], classes: Set<string>): string[] {
  return rules
    .filter((r) => r.file !== OWNER && /max\(\s*(16px|1rem)|\*\s*16\s*\/\s*14|^\s*1rem\s*$|var\(--ac-fs-input\)/.test(fontSizeOf(r) ?? "") && targetsInput(r.selector, classes))
    .map(where);
}

// Desktop 16px that is the design, not an imitation of the floor. A listed file must still
// contain one, so the list only shrinks.
// ratchet:list DESKTOP_KEPT
const DESKTOP_KEPT: Record<string, string> = {
};

describe("input text size on touch screens", () => {
  const classes = new Set<string>();
  for (const file of sourceFiles(".")) inputClasses(readFileSync(file, "utf8")).forEach((c) => classes.add(c));
  const rules = cssFiles().flatMap(cssRules);
  const imitations = floorImitations(rules, classes);
  const stray = [...strayInputFontRules(rules, classes), ...imitations.filter((hit) => !Object.keys(DESKTOP_KEPT).some((f) => hit.startsWith(`${f}:`)))];

  it("only styles/input-font.css sizes input text in a touch breakpoint", () => {
    const unexpected = stray.filter((hit) => !Object.keys(EXCEPTIONS).some((f) => hit.startsWith(`${f}:`)));
    expect(unexpected, `delete the font-size; ${OWNER} owns it`).toEqual([]);
    const stale = Object.keys(EXCEPTIONS).filter((f) => !stray.some((hit) => hit.startsWith(`${f}:`)));
    expect(stale, "these exceptions no longer need to be listed").toEqual([]);
  });

  it("the desktop-kept 16px entries are still there", () => {
    const stale = Object.keys(DESKTOP_KEPT).filter((f) => !imitations.some((hit) => hit.startsWith(`${f}:`)));
    expect(stale).toEqual([]);
  });

  it("the owner rule exists, outranks class rules, and covers touch screens of any width", () => {
    const css = readFileSync(join(SRC, OWNER), "utf8");
    expect(css).toMatch(/--input-text-size:\s*max\(var\(--ac-fs-input\),[^;]*--onden-input-size[^;]*\)/);
    expect(css).toMatch(/font-size:\s*var\(--input-text-size\)\s*!important/);
    const owner = rules.find((r) => r.file === OWNER);
    // a wide tablet is `pointer: coarse` but not narrow; a narrow mouse window is neither
    expect(owner?.media.join(" ")).toMatch(/pointer:\s*coarse/);
    expect(owner?.media.join(" ")).not.toMatch(/max-width:\s*(?!6\d\dpx)\d+/);
  });

  it("the note editor's text keeps the note font under the floor", () => {
    const rule = rules.find((r) => r.file === "components/OverviewEditor.css" && /\.note-document \.md-editor-cm \.cm-content$/.test(r.selector.trim()) && r.body.includes(BIGGER));
    expect(rule?.body).toMatch(/--onden-input-size:\s*var\(--onden-note-font\)/);
  });

  it("self-check: the scanner flags a violating rule and accepts the token", () => {
    const rule = (selector: string, body: string, media = ["@media (max-width: 600px)"]): CssRule =>
      ({ file: "x.css", line: 1, media, selector, body });
    const cls = new Set(["my-field"]);
    expect(strayInputFontRules([rule(".my-field", "font-size: 13px")], cls)).toHaveLength(1);
    expect(strayInputFontRules([rule("input[type=\"text\"]", "font-size: 13px")], cls)).toHaveLength(1);
    expect(strayInputFontRules([rule(".x textarea", "font-size: 13px")], cls)).toHaveLength(1);
    expect(strayInputFontRules([rule(".my-field", `${BIGGER}: 26px`)], cls)).toHaveLength(0);
    expect(floorImitations([rule(".my-field", "font-size: max(16px, var(--ac-fs-ui))", [])], cls)).toHaveLength(1);
    expect(floorImitations([rule(".my-field", "font-size: 13px", [])], cls)).toHaveLength(0);
    expect(strayInputFontRules([rule(".my-field", "font-size: 13px", [])], cls)).toHaveLength(0);
    expect(strayInputFontRules([rule(".button-label", "font-size: 13px")], cls)).toHaveLength(0);
    expect([...inputClasses(`<input type="text" className="a b" onChange={(e) => go(e)} /><input type="checkbox" className="c" />`)]).toEqual(["a", "b"]);
    expect([...inputClasses("<input className={classNames('p', on && \"q\", { r: x })} />")]).toEqual(["p", "q"]);
    expect([...inputClasses("<textarea className={`t ${on ? 'u' : 'v'}`} />")].sort()).toEqual(["t", "u", "v"]);
    expect([...inputClasses('<div contentEditable className="ed" /><div className="plain" />')]).toEqual(["ed"]);
    expect(strayInputFontRules([rule(".md-editor-cm .cm-content", "font-size: 15px")], cls)).toHaveLength(1);
  });
});
