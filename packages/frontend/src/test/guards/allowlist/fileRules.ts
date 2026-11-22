// The frontend allowlist rules applied to ONE file: which detector runs on it, which owners exempt it, and
// what to tell the author. allowlist.guard.test.ts (every file, against the baseline) and
// scripts/checkEditedFile.mjs (the file an agent just wrote) both call frontendViolations, so a rule added
// here is enforced in both places.
import { iconLooks } from "../../../../scripts/appearanceLook.mjs";
import { CSS_RULES, cssViolations, type CssRule } from "./css";
import { appStoreInlineSelectorLines, appStoreReachLines, appStoreWriteLines, editorScrollMarginLines, focusStealLines, keyboardStateLines, intrinsicElementSites, literalApiWriteLines, PLATFORM_GLOBALS, platformGlobalSites, searchInputSites, storeNodeFindLines, UI_ELEMENTS, viewportClampLines } from "./detect";
import { COLOR_DATA_OWNERS, CSS_EXEMPT, ELEMENT_OWNERS, FIXED_POSITION_OWNERS, FLOATING_PLACEMENT_OWNERS, inOwners, PLATFORM_OWNERS, SEARCH_FIELD_OWNERS } from "./owners";

export interface Violation { rule: string; line: number; what: string; owner: string }
export interface RuleMeta { what: string; owner: string }

const ELEMENT_USE: Record<(typeof UI_ELEMENTS)[number], string> = {
  button: "<Button> (components/ui/Button)", input: "an input from components/ui", select: "a select from components/ui",
  textarea: "a text field from components/ui", dialog: "<Modal> (components/ui/Modal)", a: "a link component from components/ui", img: "an image component from components/ui",
};

const CSS_META: Record<CssRule, RuleMeta> = {
  "css-color": { what: "a literal color", owner: "a color token, var(--*) (styles/tokens.css, theme-tokens.css)" },
  "css-radius": { what: "a literal border-radius", owner: "a --ac-radius-* token, or 0" },
  "css-shadow": { what: "a literal box-shadow", owner: "a --ac-shadow-* token, or none" },
  "css-z-index": { what: "a literal z-index", owner: "a layer token, var(--z-*), or 0" },
  "css-font-size": { what: "a literal font-size", owner: "an --ac-fs-* token, an em/% size, or inherit" },
  "css-media-width": { what: "a @media width other than 600 / 900 / 1280px", owner: "one of the three breakpoints (600, 900, 1280px)" },
  "css-position-fixed": { what: "position: fixed", owner: "an overlay from components/ui (Modal, Sheet, Popover, Toast)" },
  "css-spacing": { what: "a literal padding / margin / gap", owner: "a --ac-space-* token, or 0 / auto" },
  "css-line-height": { what: "a literal line-height", owner: "an --ac-lh-* token, or normal / inherit" },
  "css-font-weight": { what: "a literal font-weight", owner: "an --ac-fw-* token (outside @font-face)" },
  "css-letter-spacing": { what: "a literal letter-spacing", owner: "an --onden-tracking-* token, or 0 / normal" },
  "css-font-family": { what: "a literal font-family", owner: "an --ac-font-* token (outside @font-face)" },
  "css-border-width": { what: "a literal border width", owner: "an --ac-border-* token, or 0 / none" },
  "css-opacity": { what: "a literal opacity other than 0 and 1", owner: "an --ac-opacity-* token" },
  "css-duration": { what: "a literal transition / animation duration", owner: "a motion token (--onden-motion-*, --ac-duration-*); a looping animation is exempt" },
  "css-easing": { what: "a literal transition / animation easing", owner: "--onden-motion-ease or --onden-ease-leave; a looping animation is exempt" },
  "css-control-height": { what: "a literal height / min-height on a button, input or other control", owner: "an --ac-control-* / --ac-tap / --ac-row* token" },
  "css-max-width": { what: "a literal max-width (px / rem / ch)", owner: "an --ac-prose-max / --ac-list-max / --ac-width-* token, or a % / vw size" },
  "css-focus-ring": { what: "a literal outline, or a box-shadow that is not the focus token used as a focus ring", owner: "outline: var(--ac-focus-outline) with --ac-focus-offset / --ac-focus-inset" },
};

const ICON_META: Record<string, RuleMeta> = {
  "fe-icon-size": { what: "an icon size={n} that is not 12, 16, 20 or 24", owner: "one of the four icon sizes in docs/agents/appearance-rules.md (12, 16, 20, 24)" },
  "fe-icon-stroke": { what: "an icon strokeWidth={n} that is not 1.5", owner: "strokeWidth 1.5, the one icon line weight in docs/agents/appearance-rules.md" },
};

/** Every rule id with its message, in the order the guard reports them (a rule with no violation still gets a test). */
export const RULE_META: Record<string, RuleMeta> = {
  ...Object.fromEntries(PLATFORM_GLOBALS.map((g) => [`fe-platform-global:${g}`, { what: g, owner: `the owner file listed for ${g} in allowlist/owners.ts` }])),
  ...Object.fromEntries(UI_ELEMENTS.map((t) => [`fe-native-element:${t}`, { what: `<${t}>`, owner: ELEMENT_USE[t] }])),
  "fe-search-input": { what: "a hand-made search / filter box (type=\"search\", a Search… placeholder, or a magnifier drawn beside an input)", owner: "<SearchField> (components/ui/SearchField)" },
  "fe-floating-clamp": { what: "keeping a layer inside the window (innerWidth - width)", owner: "usePopover / <Popover> from components/ui (an anchor, or `at` for a point)" },
  "fe-store-node-find": { what: "a linear find / some over an AppData's nodes by id (the store's, a DataCtx's `ctx.data`, a `data`)", owner: "nodeOf(data, id) from lib/nodeIndex; for the store itself getNode(id) / useNode(id) from lib/appStore" },
  "fe-app-store-reach": { what: "reading or writing the whole store state (getAppState, useAppSelector, setAppState, setData, subscribeApp from lib/appStore)", owner: "a named hook / selector exported by lib/appStore (useNode(id), getNode(id), useSelectedId()…); when none fits, add a NAMED narrow hook to appStore instead of `useAppSelector((s) => …)` in the new file; writes go through lib/data" },
  "fe-store-inline-selector": { what: "`useAppSelector((s) => …)` written in place (the caller learns the shape of the store; a subset of fe-app-store-reach)", owner: "a named hook / selector exported by lib/appStore or lib/data (useNode(id), useSelectedId(), selectCanvases…); when none fits, add one there" },
  "fe-store-write": { what: "writing the store's state directly (setData, setAppState from lib/appStore; a subset of fe-app-store-reach)", owner: "the domain writer in lib/data for that action (rename, complete, save, undo…)" },
  "fe-literal-api-write": { what: "`sendWrite(method, \"/api/…\")` with the server path spelled out outside lib/data", owner: "a named writer in lib/data for that user action (it owns the path, the body, the idempotency key and the error mapping)" },
  "fe-keyboard-state": { what: "reading the on-screen keyboard's state (importing hooks/useVirtualKeyboard)", owner: "components/ui (Sheet, Popover) for overlays; hooks/useEditorKeyboard (with lib/editorKeyboard) for the editor's bar and caret" },
  "fe-focus-steal-guard": { what: "a hand-written onMouseDown/onPointerDown that only calls preventDefault() to keep the editor's focus", owner: "keepFocus from components/ui (onMouseDown={keepFocus}); a popover opened beside text is useInlinePopover, which does it for its whole surface" },
  "fe-editor-scroll-margin": { what: "EditorView.scrollMargins (how far the caret stays from the edges while writing)", owner: "lib/editorKeyboard (the one owner of \"the caret stays above the keyboard and the bar\")" },
  ...Object.fromEntries(CSS_RULES.map((r) => [`fe-${r}`, CSS_META[r]])),
  ...ICON_META,
};

/** Whether the allowlist guards look at this file at all (`rel` is the path under src/). Tests and test helpers are not app code. */
export function isGuardedSource(rel: string): boolean {
  if (rel.split("/").includes("test")) return false;
  if (/\.test\.tsx?$/.test(rel)) return false;
  return /\.(ts|tsx|css)$/.test(rel);
}

/** Violations in one file (`rel` is its path under src/). Counting against the baseline is the caller's job. */
export function frontendViolations(rel: string, source: string): Violation[] {
  if (!isGuardedSource(rel)) return [];
  const make = (rule: string, line: number): Violation => ({ rule, line, ...RULE_META[rule]! });
  if (rel.endsWith(".css")) {
    if (inOwners(rel, Object.keys(CSS_EXEMPT))) return [];
    return cssViolations(source, rel)
      .filter(({ rule }) => !(rule === "css-position-fixed" && inOwners(rel, FIXED_POSITION_OWNERS)) && !(rule === "css-color" && inOwners(rel, Object.keys(COLOR_DATA_OWNERS))))
      .map(({ rule, line }) => make(`fe-${rule}`, line));
  }
  const out = rel.endsWith(".tsx") && !inOwners(rel, Object.keys(CSS_EXEMPT))
    ? iconLooks(rel, source).filter((look) => look.off).map((look) => make(`fe-${look.rule}`, look.line))
    : [];
  out.push(...platformGlobalSites(rel, source)
    .filter(({ name }) => !inOwners(rel, PLATFORM_OWNERS[name]!.owners))
    .map(({ name, line }) => make(`fe-platform-global:${name}`, line)));
  if (rel.endsWith(".tsx") && !inOwners(rel, ELEMENT_OWNERS)) {
    for (const { name, line } of intrinsicElementSites(rel, source)) out.push(make(`fe-native-element:${name}`, line));
  }
  // The published site's own frame (components/siteFrame/) is visitor-facing markup with its own frozen look and script; CSS_EXEMPT already names it.
  if (rel.endsWith(".tsx") && !inOwners(rel, SEARCH_FIELD_OWNERS) && !inOwners(rel, Object.keys(CSS_EXEMPT))) {
    for (const { line } of searchInputSites(rel, source)) out.push(make("fe-search-input", line));
  }
  if (!inOwners(rel, FLOATING_PLACEMENT_OWNERS)) {
    for (const line of viewportClampLines(rel, source)) out.push(make("fe-floating-clamp", line));
  }
  if (rel !== "lib/appStore.ts" && rel !== "lib/nodeIndex.ts") for (const line of storeNodeFindLines(rel, source)) out.push(make("fe-store-node-find", line));
  if (rel !== "lib/appStore.ts" && !rel.startsWith("lib/data/")) for (const line of appStoreReachLines(rel, source)) out.push(make("fe-app-store-reach", line));
  if (rel !== "lib/appStore.ts" && !rel.startsWith("lib/data/")) {
    for (const line of appStoreInlineSelectorLines(rel, source)) out.push(make("fe-store-inline-selector", line));
    for (const line of appStoreWriteLines(rel, source)) out.push(make("fe-store-write", line));
  }
  if (!rel.startsWith("lib/data/")) for (const line of literalApiWriteLines(rel, source)) out.push(make("fe-literal-api-write", line));
  if (!rel.startsWith("components/ui/") && rel !== "hooks/useEditorKeyboard.ts") for (const line of keyboardStateLines(rel, source)) out.push(make("fe-keyboard-state", line));
  if (rel !== "lib/editorKeyboard.ts") for (const line of editorScrollMarginLines(rel, source)) out.push(make("fe-editor-scroll-margin", line));
  if (!rel.startsWith("components/ui/") && rel !== "lib/editorKeyboard.ts" && rel !== "lib/editorTouch.ts") for (const line of focusStealLines(rel, source)) out.push(make("fe-focus-steal-guard", line));
  return out;
}
