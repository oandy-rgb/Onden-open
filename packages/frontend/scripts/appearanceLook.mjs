// What the sources say about the LOOK of the app, per kind of value — the ONE detector behind both
//   · the allowlist guards  (src/test/guards/allowlist/css.ts, detect.ts: rules fe-css-spacing … fe-icon-stroke), and
//   · the style census      (e2e/style-census/static.mjs: the "written in the source" numbers).
// It is pure text in, findings out (postcss for CSS, the TypeScript parser for TSX); walking files and counting per
// file is the caller's job. Contract of every rule here, the same as fe-css-color / fe-css-radius: a RAW LITERAL
// where a token (or one of the allowed keywords) must be used. Levels and tokens: docs/agents/appearance-rules.md.
// What a static scan cannot see (computed values, em/calc() results, inherited sizes, styles injected by the editor
// or set in JS) is listed there under each kind as 「只能由普查看到」.
import postcss from "postcss";
import ts from "typescript";

/** @typedef {{ kind: string, rule: string, raw: string[] }} Look */

/** kind → the rule id (without the `fe-` prefix). A kind with several rules lists them all. */
export const LOOK_RULES = {
  spacing: ["css-spacing"],
  "line-height": ["css-line-height"],
  "font-weight": ["css-font-weight"],
  "letter-spacing": ["css-letter-spacing"],
  "font-family": ["css-font-family"],
  "border-width": ["css-border-width"],
  opacity: ["css-opacity"],
  "transition-ms": ["css-duration"],
  easing: ["css-easing"],
  "control-height": ["css-control-height"],
  "max-width": ["css-max-width"],
  "focus-ring": ["css-focus-ring"],
  "icon-size": ["icon-size"],
  "icon-stroke": ["icon-stroke"],
};
export const CSS_LOOK_RULES = Object.values(LOOK_RULES).flat().filter((r) => r.startsWith("css-"));
export const TSX_LOOK_RULES = ["icon-size", "icon-stroke"];

// ── value helpers ─────────────────────────────────────────────────────────────────────────
/** `value` with every `var(…)` (fallbacks included, nesting balanced) replaced by a space. */
export function withoutVars(value) {
  let out = "";
  for (let i = 0; i < value.length; ) {
    if (value.startsWith("var(", i) && !/[\w-]/.test(value[i - 1] ?? " ")) {
      let depth = 0;
      let j = i + 3;
      for (; j < value.length; j++) {
        if (value[j] === "(") depth++;
        else if (value[j] === ")" && --depth === 0) break;
      }
      out += " ";
      i = j + 1;
    } else out += value[i++];
  }
  return out;
}
const withoutColours = (v) => v.replace(/(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix|color)\([^()]*(\([^()]*\)[^()]*)*\)/gi, " ").replace(/#[0-9a-f]{3,8}\b/gi, " ");
const clean = (value) => withoutVars(value.replace(/!important/i, "")).trim();

const UNIT = "px|rem|em|%|vw|vh|vmin|vmax|dvh|dvw|svh|svw|lvh|lvw|ch|ex|pt|pc|cm|mm|in|cqw|cqh";
const LENGTH = new RegExp(`(?<![\\w.#-])(-?\\d*\\.?\\d+)(${UNIT})(?![\\w%])`, "gi");
const BARE_NUMBER = /(?<![\w.#-])(-?\d*\.?\d+)(?![\w.%(-])/g;
const TIME = /(?<![\w.#-])(-?\d*\.?\d+)(ms|s)(?![\w])/gi;

/** Non-zero length literals of a cleaned value (`px`, `rem`, `%`…), optionally limited to some units. */
function lengths(v, units) {
  const out = [];
  for (const m of v.matchAll(LENGTH)) {
    if (Number(m[1]) === 0) continue;
    if (units && !units.includes(m[2].toLowerCase())) continue;
    out.push(`${m[1]}${m[2]}`);
  }
  return out;
}
const bareNumbers = (v) => [...v.matchAll(BARE_NUMBER)].map((m) => m[1]).filter((n) => Number(n) !== 0);

// ── which CSS properties belong to which kind ────────────────────────────────────────────
const SPACING = /^(padding|margin)(-(top|right|bottom|left|block|inline)(-(start|end))?)?$|^(gap|row-gap|column-gap)$/;
const BORDER_WIDTH = /^border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-width)?$/;
const MOTION_DURATION = /^(transition|transition-duration|animation|animation-duration)$/;
const MOTION_EASING = /^(transition|transition-timing-function|animation|animation-timing-function)$/;
const CONTROL_HEIGHT = /^(height|min-height|block-size|min-block-size)$/;
const MAX_WIDTH = /^(max-width|max-inline-size)$/;
const OUTLINE = /^(outline|outline-offset|outline-width|outline-style)$/;

const EASING_WORD = /(?<![\w-])(ease-in-out|ease-in|ease-out|ease|linear|step-start|step-end)(?![\w-])/gi;
const FOCUS_SELECTOR = /:focus(-visible|-within)?\b/;
const FOCUS_NAME = /focus/i;

/** Class / element names that make a rule a CONTROL (something a person presses, types in or picks from). */
const CONTROL_ELEMENTS = new Set(["button", "input", "select", "textarea", "summary"]);
const CONTROL_WORDS = new Set(["btn", "button", "input", "field", "select", "textarea", "tab", "chip", "toggle", "switch", "checkbox", "radio", "control", "menuitem", "pill", "stepper", "slider", "pressable"]);
/** A class with one of these words is a container of controls, not a control. */
const CONTAINER_WORDS = new Set(["bar", "panel", "list", "group", "wrap", "wrapper", "container", "row", "strip", "label", "text", "title", "header", "footer", "body", "content", "area", "section"]);
const CONTROL_ROLES = /\[\s*role\s*=\s*["']?(button|tab|menuitem|option|switch|checkbox|radio|combobox|textbox)\b/i;
const CONTROL_TYPES = /\[\s*type\s*=\s*["']?(button|submit|reset|text|search|email|password|number|checkbox|radio|url|tel|date)\b/i;

/** Whether ONE selector (no comma) ends in a control. Heuristic by name, on purpose: see appearance-rules.md §控制項高度. */
export function isControlSelector(selector) {
  for (const part of selector.split(",")) {
    if (part.includes("::")) continue; // ::before / ::after are not the control itself
    const last = part.trim().split(/\s*[>+~]\s*|\s+/).pop() ?? "";
    const compound = last.replace(/:[\w-]+(\([^)]*\))?/g, "");
    if (CONTROL_ROLES.test(compound) || CONTROL_TYPES.test(compound)) return true;
    const element = compound.match(/^[a-z][a-z0-9]*/i)?.[0]?.toLowerCase();
    if (element && CONTROL_ELEMENTS.has(element)) return true;
    for (const cls of compound.matchAll(/\.([\w-]+)/g)) {
      const words = cls[1].toLowerCase().split(/[-_]+/);
      if (words.some((w) => CONTAINER_WORDS.has(w))) continue;
      if (words.some((w) => CONTROL_WORDS.has(w))) return true;
    }
  }
  return false;
}

/**
 * The looks one declaration has, for every kind its property belongs to (an empty `raw` means "belongs to the kind,
 * and is written with tokens or allowed keywords"; the census counts those as token uses).
 * @param {string} prop @param {string} value
 * @param {{ selector?: string, inFontFace?: boolean }} [where] the rule's selector; whether it is an @font-face descriptor
 * @returns {Look[]}
 */
export function declarationLooks(prop, value, where = {}) {
  prop = prop.toLowerCase();
  if (prop.startsWith("--")) return [];
  const out = [];
  const add = (kind, rule, raw) => out.push({ kind, rule, raw });
  const v = clean(value);
  const keywords = /^(inherit|initial|unset|revert|revert-layer|none|auto|normal)?$/i;

  if (SPACING.test(prop)) add("spacing", "css-spacing", lengths(v));
  if (prop === "line-height") add("line-height", "css-line-height", keywords.test(v) ? [] : [...bareNumbers(v), ...lengths(v)]);
  if (prop === "font-weight" && !where.inFontFace) {
    add("font-weight", "css-font-weight", [...bareNumbers(v), ...(v.match(/\b(bold|bolder|lighter)\b/gi) ?? [])]);
  }
  if (prop === "letter-spacing") add("letter-spacing", "css-letter-spacing", lengths(v));
  if (prop === "font-family" && !where.inFontFace) {
    const first = v.split(",").map((s) => s.trim()).find(Boolean) ?? "";
    add("font-family", "css-font-family", keywords.test(first) ? [] : [first.replace(/["']/g, "").slice(0, 40)]);
  }
  if (BORDER_WIDTH.test(prop)) {
    const body = withoutColours(v);
    add("border-width", "css-border-width", [...lengths(body), ...(body.match(/\b(thin|medium|thick)\b/gi) ?? [])]);
  }
  if (prop === "opacity") add("opacity", "css-opacity", [...bareNumbers(v), ...lengths(v, ["%"])].filter((n) => !/^(0|1|100%)$/.test(n)));
  // A loop that never ends (spinner, progress) is not a transition between two states: no duration or easing rule.
  const looping = /\binfinite\b/i.test(v);
  if (MOTION_DURATION.test(prop)) {
    const times = [...v.matchAll(TIME)].filter((m) => Number(m[1]) !== 0).map((m) => `${m[1]}${m[2]}`);
    add("transition-ms", "css-duration", looping ? [] : times);
  }
  if (MOTION_EASING.test(prop)) {
    const FUNCTION = /(cubic-bezier|steps|linear)\([^()]*\)/gi;
    const functions = v.match(FUNCTION) ?? [];
    const words = [...v.replace(FUNCTION, " ").matchAll(EASING_WORD)].map((m) => m[1]);
    add("easing", "css-easing", looping ? [] : [...functions, ...words]);
  }
  if (CONTROL_HEIGHT.test(prop) && where.selector !== undefined && isControlSelector(where.selector)) {
    add("control-height", "css-control-height", lengths(v, ["px", "rem"]));
  }
  if (MAX_WIDTH.test(prop)) add("max-width", "css-max-width", lengths(v).filter((l) => !/(%|vw|vh|dvw|dvh|svw|svh|lvw|lvh|vmin|vmax|cqw|cqh)$/i.test(l)));
  if (OUTLINE.test(prop)) {
    add("focus-ring", "css-focus-ring", [...lengths(v), ...(v.match(/\b(solid|dashed|dotted|double|groove|ridge|inset|outset)\b/gi) ?? [])]);
  }
  // A shadow used as the focus indicator must be the focus token, not a ring of its own.
  if (prop === "box-shadow" && where.selector !== undefined && FOCUS_SELECTOR.test(where.selector)) {
    const names = [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);
    const isNone = /^\s*none\s*$/i.test(value);
    add("focus-ring", "css-focus-ring", isNone || names.some((n) => FOCUS_NAME.test(n)) ? [] : [value.trim().replace(/\s+/g, " ").slice(0, 40)]);
  }
  return out;
}

/** The context of a postcss declaration: its rule's selector, whether it sits in @font-face. */
export function declarationContext(decl) {
  const parent = decl.parent;
  if (parent?.type === "atrule") return { inFontFace: /^font-face$/i.test(parent.name) };
  const selector = parent?.type === "rule" ? parent.selector : undefined;
  return { selector };
}

/**
 * The rules a declaration is excused from, by the comment(s) right before it:
 *   /* appearance-ok css-control-height: .chip-cloud is a container, not a control *\/
 * The reason is required (at least 6 characters); a marker without one excuses nothing. It is for the cases a heuristic gets
 * wrong (a container whose name looks like a control); it is visible in the diff, one declaration at a time.
 */
export function exemptedRules(decl) {
  const out = new Set();
  for (let prev = decl.prev(); prev?.type === "comment"; prev = prev.prev()) {
    const m = prev.text.match(/^\s*appearance-ok\s+(css-[\w-]+)\s*:\s*(\S[\s\S]{5,})$/);
    if (m) out.add(m[1]);
  }
  return out;
}

/** Every look of every declaration in a stylesheet: `{ line, prop, kind, rule, raw }` (raw may be empty = tokens/keywords only). */
export function stylesheetLooks(source, from = "style.css") {
  const out = [];
  postcss.parse(source, { from }).walkDecls((decl) => {
    for (const look of declarationLooks(decl.prop, decl.value, declarationContext(decl))) {
      out.push({ ...look, prop: decl.prop.toLowerCase(), line: decl.source?.start?.line ?? 0, usesToken: /var\(/.test(decl.value) });
    }
  });
  return out;
}

// ── TSX: icons ───────────────────────────────────────────────────────────────────────────
// No constant exists yet for icon sizes (lib/iconSize.ts comes with the first batch that moves icons), so until it does
// the rule's contract is "a number that is not one of the levels", not "any number": a new size={18} fails, size={16} is
// still allowed. The batch that adds the constant tightens it to "any number" and starts a new, smaller baseline.
export const ICON_SIZE_LEVELS = [12, 16, 20, 24];
export const ICON_STROKE_LEVELS = [1.5];

/** Names imported from the icon library (`import { Plus, X as Close } from "lucide-react"`) → the local names. */
function iconNames(file) {
  const names = new Set();
  for (const st of file.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== "lucide-react") continue;
    const bindings = st.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) names.add(el.name.text);
  }
  return names;
}
const literalNumber = (init) => {
  if (!init) return null;
  const e = ts.isJsxExpression(init) ? init.expression : init;
  if (!e) return null;
  if (ts.isNumericLiteral(e)) return e.text;
  if (ts.isStringLiteral(e) && /^-?\d*\.?\d+$/.test(e.text)) return e.text;
  return null;
};

/** `size={14}` and `strokeWidth={2}` written as numbers on an icon from lucide-react: `{ rule, line, raw, off }`; `off`: not one of the levels. */
export function iconLooks(path, source) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const icons = iconNames(file);
  if (!icons.size) return [];
  const out = [];
  const visit = (node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName) && icons.has(node.tagName.text)) {
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr) || !ts.isIdentifier(attr.name)) continue;
        const rule = attr.name.text === "size" ? "icon-size" : attr.name.text === "strokeWidth" ? "icon-stroke" : null;
        const raw = rule ? literalNumber(attr.initializer) : null;
        if (rule && raw !== null) {
          const levels = rule === "icon-size" ? ICON_SIZE_LEVELS : ICON_STROKE_LEVELS;
          out.push({ kind: rule, rule, raw: [raw], off: !levels.includes(Number(raw)), line: file.getLineAndCharacterOfPosition(attr.getStart(file)).line + 1 });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}
