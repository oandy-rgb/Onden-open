// @vitest-environment node
// Self-test of the allowlist guards: every detector is fed a violating sample (must be caught) and a legal
// one (must pass), and the baseline ratchet is run against a temp baseline file. Without this a detector
// that silently stopped matching would make the guard green forever.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareToBaseline, lowerBaseline, RATCHET_RULES, readBaseline } from "../../../../../scripts/allowlistLib.mjs";
import { cssViolations, definedProperties, legacyTokenUses, offStandardMediaWidths } from "./allowlist/css";
import { appStoreInlineSelectorUses, appStoreReachUses, appStoreWriteUses, editorScrollMarginUses, literalApiWriteUses, windowEventNames, focusStealUses, intrinsicElementUses, keyboardStateUses, platformGlobalUses, searchInputSites, storeNodeFindUses, viewportClampUses } from "./allowlist/detect";
import { ownerCovered } from "../../../../../scripts/entrypointsCatalog.mjs";
import { COLOR_DATA_OWNERS, CSS_EXEMPT, ELEMENT_OWNERS, FIXED_POSITION_OWNERS, FLOATING_PLACEMENT_OWNERS, inOwners, PLATFORM_OWNERS, SEARCH_FIELD_OWNERS, TOKEN_DEFINITION_EXEMPT, TOKEN_PREFIX_OWNERS } from "./allowlist/owners";
import { CSS_RULES } from "./allowlist/css";
import { frontendViolations } from "./allowlist/fileRules";
import { PLATFORM_GLOBALS } from "./allowlist/detect";

describe("platform globals", () => {
  const uses = (code: string) => platformGlobalUses("x.ts", code);
  it("catches bare use and use through window / globalThis", () => {
    expect(uses(`window.addEventListener("resize", f); document.title = "a"; localStorage.getItem("k");`)).toEqual(["window", "document", "localStorage"]);
    expect(uses(`const w = globalThis.crypto; window.history.back(); const m = window.matchMedia("(a)");`)).toEqual(["crypto", "history", "window", "matchMedia", "window"]);
    expect(uses(`new ResizeObserver(f); el.setPointerCapture(1);`)).toEqual(["ResizeObserver", "setPointerCapture"]);
  });
  it("ignores property names, declarations, types and the file's own variables", () => {
    expect(uses(`const o = { history: 1 }; o.history; const { location } = props; location.x; function f(document: D) { return document.a; }`)).toEqual([]);
    expect(uses(`let x: ResizeObserver | null; type T = typeof window; import { crypto } from "./c"; crypto.x();`)).toEqual([]);
    expect(uses(`// window.alert()\nconst s = "document.cookie";`)).toEqual([]);
  });
});

describe("native elements", () => {
  it("counts lowercase JSX tags of the listed names", () => {
    expect(intrinsicElementUses("x.tsx", `const a = <div><button onClick={f}>x</button><input /><a href="/">l</a><img src="x" /></div>;`)).toEqual(["button", "input", "a", "img"]);
  });
  it("lets components, other tags and plain objects through", () => {
    expect(intrinsicElementUses("x.tsx", `const a = <Button><span>x</span><Input /></Button>; const b = { button: 1 };`)).toEqual([]);
  });
});

describe("search boxes", () => {
  const sites = (code: string) => searchInputSites("x.tsx", code).map((s) => s.name);
  it("catches type=search, a search-wording placeholder, and a hand-drawn magnifier wrapper", () => {
    expect(sites(`const a = <TextField type="search" value={q} />;`)).toEqual(["search-input"]);
    expect(sites(`const a = <TextField placeholder={t("Find a tag")} />;`)).toEqual(["search-input"]);
    expect(sites(`const a = <input placeholder="搜尋筆記" />;`)).toEqual(["search-input"]);
    expect(sites(`const a = <label><Search size={14} /><TextField value={q} /></label>;`)).toEqual(["search-wrapper"]);
  });
  it("lets other fields, SearchField itself and a lone magnifier icon through", () => {
    expect(sites(`const a = <TextField type="email" placeholder={t("Name")} />; const b = <SearchField label={t("Search notes…")} value="" onValueChange={f} />;`)).toEqual([]);
    expect(sites(`const a = <button><Search size={14} /></button>; const b = <TextField value={q} />;`)).toEqual([]);
  });
});

describe("store node lookup by id", () => {
  const uses = (code: string) => storeNodeFindUses("x.ts", code);
  it("catches a linear find / some by id over the store's nodes", () => {
    expect(uses(`getAppState().data.nodes.find((n) => n.id === id); getAppState().data.nodes.some(node => id === node.id); s.data.nodes.find((n) => n.id === a && !n.deleted_at);`)).toBe(3);
  });
  it("catches the same lookup over a DataCtx's data and a variable named data", () => {
    expect(uses(`ctx.data.nodes.find((n) => n.id === id); data.nodes.some((n) => n.id === id); data.nodes.find((n) => n.id === id && n.node_type === "content");`)).toBe(3);
  });
  it("lets other arrays, other predicates and getNode through", () => {
    expect(uses(`spaces.find((s) => s.id === id); nodes.find((n) => n.id === id); ctx.data.nodes.find((n) => n.slug === x); data.nodes.some((n) => n.title === x); nodeOf(data, id); getNode(id);`)).toBe(0);
  });
});

describe("whole-store reach (fe-app-store-reach)", () => {
  const uses = (code: string) => appStoreReachUses("x.ts", code);
  const imp = (names: string) => `import { ${names} } from "./lib/appStore";\n`;
  it("counts each whole-state entry, aliases and namespace use included", () => {
    expect(uses(imp("getAppState, useAppSelector, setAppState, setData, subscribeApp") + `getAppState(); useAppSelector((s) => s.online); setAppState({}); setData((d) => d); subscribeApp(f);`)).toBe(5);
    expect(uses(imp("useAppSelector as useSel") + `useSel((s) => s.online);`)).toBe(1);
    expect(uses(`import * as store from "../lib/appStore";\nstore.getAppState(); store.addToast("x"); store.setData(f);`)).toBe(2);
  });
  it("lets the narrow entries through", () => {
    expect(uses(imp("addToast, getNode, useNode, setSelectedId, selectOverviewNodes, dismissToast") + `addToast("x"); getNode(a); useNode(a); setSelectedId(null); selectOverviewNodes(s);`)).toBe(0);
  });
  it("does not count a same-named thing from another module, nor the import itself", () => {
    expect(uses(`import { getAppState } from "./other";\ngetAppState();`)).toBe(0);
    expect(uses(imp("getAppState"))).toBe(0);
  });
  it("exempts lib/appStore.ts and lib/data/**, and fails a new file elsewhere", () => {
    const code = imp("getAppState") + `getAppState();`;
    const hit = (rel: string) => frontendViolations(rel, code).filter((v) => v.rule === "fe-app-store-reach").length;
    expect(hit("lib/appStore.ts")).toBe(0);
    expect(hit("lib/data/noteWriter.ts")).toBe(0);
    expect(hit("components/NewThing.tsx")).toBe(1);
    expect(hit("lib/newHelper.ts")).toBe(1);
  });
  it("is a ratchet rule: the baseline may list files, only downward", () => {
    expect(RATCHET_RULES.has("fe-app-store-reach")).toBe(true);
    const result = compareToBaseline("fe-app-store-reach", { "components/NewThing.tsx": 1 }, { what: "x" }, { "fe-app-store-reach": {} });
    expect(result.ok).toBe(false);
  });
});

describe("the narrower store rules read the same store imports as fe-app-store-reach", () => {
  const imp = (names: string) => `import { ${names} } from "./lib/appStore";\n`;
  it("inline selectors: only a function written in place counts", () => {
    expect(appStoreInlineSelectorUses("x.ts", imp("useAppSelector, selectCanvases") + `useAppSelector((s) => s.data.nodes); useAppSelector(function (s) { return s.online; }); useAppSelector(selectCanvases);`)).toBe(2);
    expect(appStoreInlineSelectorUses("x.ts", imp("useAppSelector as useSel") + `useSel((s) => s.online);`)).toBe(1);
    expect(appStoreInlineSelectorUses("x.ts", `import * as store from "../lib/appStore";\nstore.useAppSelector((s) => s.online);`)).toBe(1);
    expect(appStoreInlineSelectorUses("x.ts", `import { useAppSelector } from "./other";\nuseAppSelector((s) => s.a);`)).toBe(0);
  });
  it("store writes: setData and setAppState, not the DOM's dataTransfer.setData nor a local state setter", () => {
    expect(appStoreWriteUses("x.ts", imp("setData, setAppState, getAppState") + `setData((d) => d); setAppState({}); getAppState();`)).toBe(2);
    expect(appStoreWriteUses("x.ts", `const [data, setData] = useState(0); setData(1); e.dataTransfer.setData("text/plain", "a");`)).toBe(0);
  });
  it("literal /api writes: a path spelled in the caller, string or template", () => {
    expect(literalApiWriteUses("x.ts", `sendWrite("POST", "/api/spaces", { name }); sendWrite("DELETE", \`/api/spaces/\${id}\`);`)).toBe(2);
    expect(literalApiWriteUses("x.ts", `sendWrite("POST", cardPath(id)); sendWrite("POST", path); other("POST", "/api/x");`)).toBe(0);
  });
  it("window event names: a …EVENT constant or a literal handed to the event helpers; storage keys and class names are not events", () => {
    const code = `export const OPEN_X_EVENT = "onden:open-x"; const EVENT = "onden-open-y"; onWindow("onden-z", f); emitWindowEvent("onden:w"); window.addEventListener("resize", f); localStorage.getItem("onden.sidebarWidth"); const c = "onden-zen";`;
    expect(windowEventNames("x.ts", code)).toEqual(["onden:open-x", "onden-open-y", "onden-z", "onden:w"]);
  });
});

describe("floating placement", () => {
  const clamps = (code: string) => viewportClampUses("x.tsx", code);
  it("catches the clamp each hand-made popup used to write", () => {
    expect(clamps(`const x = Math.max(8, Math.min(popup.x, window.innerWidth - 328));`)).toBe(1);
    expect(clamps(`const y = Math.min(below, visibleViewportBottom() - height - 8);`)).toBe(1);
    expect(clamps(`const l = document.documentElement.clientWidth - w; const t = (innerHeight) - h;`)).toBe(2);
    expect(clamps(`const t = window.visualViewport.height - h; const u = visualViewport.height - h;`)).toBe(2);
  });
  it("lets measuring an element, and plain reads of the window, through", () => {
    expect(clamps(`const budget = group.clientWidth - padding; const w = window.innerWidth; const narrow = window.innerWidth < 600;`)).toBe(0);
    expect(clamps(`const x = rect.right - window.innerWidth;`)).toBe(0);
  });
});

describe("css", () => {
  const rules = (css: string) => cssViolations(css).map((v) => v.rule);
  it("catches literals the tokens exist for", () => {
    expect(rules(`a { color: #fff; }`)).toEqual(["css-color"]);
    expect(rules(`a { background: rgba(0,0,0,.4); }`)).toEqual(["css-color"]);
    expect(rules(`a { border: 1px solid red; }`)).toEqual(["css-color"]);
    expect(rules(`a { --brand: #123456; }`)).toEqual(["css-color"]);
    expect(rules(`a { color: var(--fg, #fff); }`)).toEqual(["css-color"]);
    expect(rules(`a { border-radius: 4px; }`)).toEqual(["css-radius"]);
    expect(rules(`a { border-top-left-radius: 50%; }`)).toEqual(["css-radius"]);
    expect(rules(`a { box-shadow: 0 1px 2px var(--c); }`)).toEqual(["css-shadow"]);
    expect(rules(`a { z-index: 10; }`)).toEqual(["css-z-index"]);
    expect(rules(`a { font-size: 14px; }`)).toEqual(["css-font-size"]);
    expect(rules(`a { position: fixed; }`)).toEqual(["css-position-fixed"]);
  });
  it("lets token references and neutral values through", () => {
    expect(rules(`a { color: var(--fg); background: var(--bg-2); border: 1px solid var(--border); fill: currentColor; }`)).toEqual([]);
    expect(rules(`a { border-radius: var(--radius-md); box-shadow: var(--shadow-1); z-index: var(--z-modal); font-size: var(--text-sm); }`)).toEqual([]);
    expect(rules(`a { border-radius: 0; box-shadow: none; z-index: 0; font-size: inherit; border-radius: var(--r) var(--r) 0 0; position: sticky; }`)).toEqual([]);
    expect(rules(`a { font-size: 0.85em; } b { font-size: 120%; }`)).toEqual([]);
    expect(rules(`a { font-size: 0.85rem; } b { font-size: 0.9em 1px; }`)).toEqual(["css-font-size", "css-font-size"]);
    expect(rules(`a { font-family: Georgia, serif; width: 600px; content: "red"; }`)).toEqual([]);
  });
  it("allows only the three breakpoints in @media widths", () => {
    expect(offStandardMediaWidths("(max-width: 600px)")).toEqual([]);
    expect(offStandardMediaWidths("(min-width: 900px) and (max-width: 1280px)")).toEqual([]);
    expect(offStandardMediaWidths("(width >= 900px)")).toEqual([]);
    expect(offStandardMediaWidths("(prefers-color-scheme: dark)")).toEqual([]);
    expect(offStandardMediaWidths("(min-height: 700px)")).toEqual([]);
    expect(offStandardMediaWidths("(max-width: 768px)")).toEqual(["768px"]);
    expect(offStandardMediaWidths("(min-width: 601px) and (max-width: 1024px)")).toEqual(["601px", "1024px"]);
    expect(offStandardMediaWidths("(600px <= width <= 800px)")).toEqual(["800px"]);
    expect(rules(`@media (max-width: 700px) { a { color: var(--fg); } }`)).toEqual(["css-media-width"]);
    expect(rules(`@media (max-width: 600px) { a { color: var(--fg); } }`)).toEqual([]);
  });
});

describe("css-legacy-token", () => {
  const prefixes = TOKEN_PREFIX_OWNERS.map((o) => o.pattern);
  const uses = (code: string, locals: string[] = []) => legacyTokenUses(code, prefixes, new Set(locals));
  it("catches the older colour aliases in CSS and in TSX strings", () => {
    expect(uses(`a { color: var(--accent); border: 1px solid var(--line); background: var(--onden-bg-surface); }`)).toEqual(["--accent", "--line", "--onden-bg-surface"]);
    expect(uses(`const c = "var(--onden-text-muted)"; const d = { color: "var( --muted )" };`)).toEqual(["--onden-text-muted", "--muted"]);
    expect(uses(`a { color: var(--onden-text-strong, #000); }`)).toEqual(["--onden-text-strong"]);
  });
  it("lets --ac-*, layers, non-colour tokens and the component's own properties through", () => {
    expect(uses(`a { color: var(--ac-muted); z-index: var(--z-popover); font-size: var(--onden-text-sm); padding: var(--ac-space-4); }`)).toEqual([]);
    expect(uses(`a { width: var(--onden-sidebar-width); color: var(--section-color); } /* var(--accent) in a comment */`, ["--section-color"])).toEqual([]);
    expect(uses(`a { color: var(--section-color); }`)).toEqual(["--section-color"]);
  });
  it("sees the names a source defines itself", () => {
    expect(definedProperties(`.a { --depth: 2; } const s = { "--sb-x": 1 } as CSSProperties; el.style.setProperty("--pk-y", "1");`)).toEqual(new Set(["--depth", "--sb-x", "--pk-y"]));
  });
});

describe("owners", () => {
  it("a folder owner covers its files, a file owner only itself", () => {
    expect(inOwners("lib/a/b.ts", ["lib/"])).toBe(true);
    expect(inOwners("library.ts", ["lib/"])).toBe(false);
    expect(inOwners("lib/uuid.ts", ["lib/uuid.ts"])).toBe(true);
    expect(inOwners("lib/uuid.tsx", ["lib/uuid.ts"])).toBe(false);
  });
});

describe("strict mode: the committed baseline is empty", () => {
  it("lists no file for any rule", () => {
    const listed = Object.entries(readBaseline()).filter(([rule]) => !RATCHET_RULES.has(rule)).flatMap(([rule, files]) => Object.keys(files as object).map((file) => `${rule}: ${file}`));
    expect(listed).toEqual([]);
  });
});

describe("baseline ratchet", () => {
  const meta = { what: "window", owner: "hooks/useX.ts" };
  const baseline = { r: { "a.ts": 2, "b.ts": 1 } };
  it("fails on a higher count or a new file, naming the file, the thing and the owner", () => {
    const up = compareToBaseline("r", { "a.ts": 3, "b.ts": 1 }, meta, baseline);
    expect(up.ok).toBe(false);
    expect(up.errors[0]).toContain("a.ts：這個檔不准用 window");
    expect(up.errors[0]).toContain("請改用 hooks/useX.ts");
    expect(compareToBaseline("r", { "a.ts": 2, "c.ts": 1 }, meta, baseline).errors[0]).toContain("c.ts");
  });
  it("a rule in the catalog says what to use instead: its need, entry, call example and place in the catalog doc", () => {
    const result = compareToBaseline("fe-native-element:button", { "x.tsx": 1 }, { what: "<button>" }, { "fe-native-element:button": {} });
    const message = result.errors[0]!;
    expect(message).toContain("x.tsx：這個檔不准用 <button>");
    expect(message).toContain("需求：要放按鈕");
    expect(message).toContain("components/ui/index.ts");
    expect(message).toContain('import { Button } from "./components/ui";');
    expect(message).toContain("docs/agents/entrypoints-catalog.md › 介面零件 › 要放按鈕");
  });
  it("passes an equal or lower count and says the baseline can come down", () => {
    expect(compareToBaseline("r", { "a.ts": 2, "b.ts": 1 }, meta, baseline)).toMatchObject({ ok: true, notes: [] });
    const down = compareToBaseline("r", { "a.ts": 1 }, meta, baseline);
    expect(down.ok).toBe(true);
    expect(down.notes.join()).toContain("可以降基準");
  });
  it("a rule without a baseline fails until it is created", () => {
    expect(compareToBaseline("missing", {}, meta, baseline).ok).toBe(false);
  });
  it("writing refuses any rise, lowers counts, drops zeros, and only creates a rule with init", () => {
    const file = join(mkdtempSync(join(tmpdir(), "allowlist-")), "baseline.json");
    writeFileSync(file, JSON.stringify(baseline));
    expect(() => lowerBaseline("r", { "a.ts": 3 }, "lower", file)).toThrow(/只准往下/);
    expect(() => lowerBaseline("r", { "c.ts": 1 }, "lower", file)).toThrow(/只准往下/);
    expect(() => lowerBaseline("new", { "a.ts": 1 }, "lower", file)).toThrow(/--init/);
    lowerBaseline("r", { "a.ts": 1, "b.ts": 0 }, "lower", file);
    expect(JSON.parse(readFileSync(file, "utf8")).r).toEqual({ "a.ts": 1 });
    lowerBaseline("new", { "a.ts": 4 }, "init", file);
    expect(JSON.parse(readFileSync(file, "utf8")).new).toEqual({ "a.ts": 4 });
    expect(() => lowerBaseline("new", { "a.ts": 5 }, "init", file)).toThrow(/只准往下/);
  });
});

// 例外只能是唯一入口本身：owners.ts 的每個 owner 都要被 catalog 某個入口涵蓋（該入口的 rules 含這條規則，
// 且入口檔案就是這個 owner、或落在這個 owner 資料夾內）。（TOKEN_PREFIX_OWNERS 是變數名稱樣式，不是檔案，不在此列。）
describe("every owner is a catalog entry", () => {
  const FE = "packages/frontend/src/";
  const cssRules = CSS_RULES.map((r) => `fe-${r}`);
  const uncovered = (owners: readonly string[], rules: string[]) => owners.filter((o) => !ownerCovered(o, rules, FE));
  const explain = (table: string, owners: string[]) =>
    owners.length === 0 ? "" : `${table}：${owners.join("、")} 不是唯一入口。例外只能是唯一入口本身，請改成走入口，或把它登記成 scripts/entrypoints.catalog.json 的入口（rules 要含這條規則）。`;
  it("platform globals", () => {
    const bad = PLATFORM_GLOBALS.flatMap((g) => uncovered(PLATFORM_OWNERS[g]!.owners, [`fe-platform-global:${g}`]).map((o) => `${g} → ${o}`));
    expect(explain("PLATFORM_OWNERS", bad)).toBe("");
  });
  it("native elements, fixed position, floating placement", () => {
    expect(explain("ELEMENT_OWNERS", uncovered(ELEMENT_OWNERS, [...["button", "input", "select", "textarea", "dialog", "a", "img"].map((t) => `fe-native-element:${t}`)]))).toBe("");
    expect(explain("FIXED_POSITION_OWNERS", uncovered(FIXED_POSITION_OWNERS, ["fe-css-position-fixed"]))).toBe("");
    expect(explain("FLOATING_PLACEMENT_OWNERS", uncovered(FLOATING_PLACEMENT_OWNERS, ["fe-floating-clamp"]))).toBe("");
    expect(explain("SEARCH_FIELD_OWNERS", uncovered(SEARCH_FIELD_OWNERS, ["fe-search-input"]))).toBe("");
  });
  it("stylesheets that define tokens or hold data colours", () => {
    expect(explain("CSS_EXEMPT", uncovered(Object.keys(CSS_EXEMPT), cssRules))).toBe("");
    expect(explain("COLOR_DATA_OWNERS", uncovered(Object.keys(COLOR_DATA_OWNERS), ["fe-css-color"]))).toBe("");
    expect(explain("TOKEN_DEFINITION_EXEMPT", uncovered(TOKEN_DEFINITION_EXEMPT, ["fe-css-legacy-token"]))).toBe("");
  });
});

describe("the editor's keyboard owner (fe-keyboard-state, fe-editor-scroll-margin)", () => {
  const code = `import { useVirtualKeyboard } from "../hooks/useVirtualKeyboard";\nuseVirtualKeyboard(true);`;
  it("catches importing the keyboard state, by every spelling, and nothing else", () => {
    expect(keyboardStateUses("x.tsx", code)).toBe(1);
    expect(keyboardStateUses("x.tsx", `export { visibleViewportBottom } from "./useVirtualKeyboard";`)).toBe(1);
    expect(keyboardStateUses("x.tsx", `const m = await import("../hooks/useVirtualKeyboard");`)).toBe(1);
    expect(keyboardStateUses("x.tsx", `import { useEditorKeyboard } from "../hooks/useEditorKeyboard";`)).toBe(0);
  });
  it("catches EditorView.scrollMargins however it is used", () => {
    expect(editorScrollMarginUses("x.ts", `const e = EditorView.scrollMargins.of(() => ({ bottom: 8 }));`)).toBe(1);
    expect(editorScrollMarginUses("x.ts", `const { scrollMargins } = EditorView; view.state.facet(EditorView.scrollMargins);`)).toBe(1);
    expect(editorScrollMarginUses("x.ts", `EditorView.scrollIntoView(1, { y: "nearest" });`)).toBe(0);
  });
  it("lets only the owners through", () => {
    const hit = (rel: string, src: string, rule: string) => frontendViolations(rel, src).filter((v) => v.rule === rule).length;
    expect(hit("components/ui/Sheet.tsx", code, "fe-keyboard-state")).toBe(0);
    expect(hit("hooks/useEditorKeyboard.ts", code, "fe-keyboard-state")).toBe(0);
    expect(hit("components/MarkdownEditor.tsx", code, "fe-keyboard-state")).toBe(1);
    expect(hit("lib/newHelper.ts", code, "fe-keyboard-state")).toBe(1);
    const margins = `EditorView.scrollMargins.of(() => null);`;
    expect(hit("lib/editorKeyboard.ts", margins, "fe-editor-scroll-margin")).toBe(0);
    expect(hit("components/MarkdownEditor.tsx", margins, "fe-editor-scroll-margin")).toBe(1);
    expect(hit("lib/editorEndRoom.ts", margins, "fe-editor-scroll-margin")).toBe(1);
  });
});

describe("keeping the editor's focus (fe-focus-steal-guard)", () => {
  const hit = (rel: string, src: string) => frontendViolations(rel, src).filter((v) => v.rule === "fe-focus-steal-guard").length;
  it("catches a handler that only prevents the default, with or without one apply call, as attribute or property", () => {
    expect(focusStealUses("x.tsx", `<li onMouseDown={(e) => e.preventDefault()} />`)).toBe(1);
    expect(focusStealUses("x.tsx", `<li onMouseDown={(e) => { e.preventDefault(); pick(1); }} />`)).toBe(1);
    expect(focusStealUses("x.tsx", `<b onPointerDown={(e) => { if (e.target.tagName !== "TEXTAREA") e.preventDefault(); }} />`)).toBe(1);
    expect(focusStealUses("x.tsx", `const p = { onPointerDown: (e: Event) => e.preventDefault(), onClick };`)).toBe(1);
  });
  it("leaves gestures and the shared helper alone", () => {
    expect(focusStealUses("x.tsx", `<li onMouseDown={keepFocus} />`)).toBe(0);
    expect(focusStealUses("x.tsx", `<li onMouseDown={(e) => { keepFocus(e); pick(); }} />`)).toBe(0);
    expect(focusStealUses("x.tsx", `<d onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); capture(e); dragging.current = true; }} />`)).toBe(0);
    expect(focusStealUses("x.tsx", `<d onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.preventDefault()} />`)).toBe(0);
  });
  it("lets only components/ui and the editor's owner write one", () => {
    const code = `<li onMouseDown={(e) => e.preventDefault()} />`;
    expect(hit("components/ui/SearchField.tsx", code)).toBe(0);
    expect(hit("lib/editorKeyboard.ts", code)).toBe(0);
    expect(hit("components/MarkdownEditor.tsx", code)).toBe(1);
    expect(hit("modules/tasks/Row.tsx", code)).toBe(1);
  });
});
