// The model behind the row of view tabs (lib/viewTabs): which tabs a page
// has, which one is open, how a tab maps to a location, how a drag reorders.
import { beforeEach, describe, expect, it } from "vitest";
import { CANVAS_TAB, CONTENT_TAB, activeTabKey, buildViewTabs, contentTabIn, defaultTabKey, freeViewName, locationOfTab, rememberTab, rememberedTab, reorderTabs } from "../lib/viewTabs";
import type { SavedView } from "../lib/ownerViews";
import { bindAccountStorage } from "../lib/accountStorage";
import { parseLocation, locationToSearch } from "../hooks/useUrlLocation";

const view = (id: string, layout: SavedView["layout"], extra: Partial<SavedView> = {}): SavedView =>
  ({ id, tag_id: "t", name: id, layout, filters: [], sorts: [], group_by: null, visible_fields: [], layout_config: {}, pin_order: 0, ...extra });
const base = { canvasImported: true, earnsWhiteboard: false, canManage: true, contentName: "內容", whiteboardName: "白板" };
const keys = (input: Partial<Parameters<typeof buildViewTabs>[0]>) => buildViewTabs({ views: [], ...base, ...input }).map((tab) => tab.key);

describe("buildViewTabs", () => {
  it("a plain note has only 內容", () => {
    expect(keys({})).toEqual([CONTENT_TAB]);
  });

  it("a tab of a layout the page hides (a note view whose feature is off) is left out, its record kept", () => {
    const views = [view("s", "slides"), view("a", "table")];
    expect(keys({ views })).toEqual([CONTENT_TAB, "a", "s"]);
    expect(keys({ views, hiddenLayouts: new Set(["slides"]) })).toEqual([CONTENT_TAB, "a"]);
  });

  it("saved views become tabs after 內容, in the order given", () => {
    expect(keys({ views: [view("a", "table"), view("b", "calendar")] })).toEqual([CONTENT_TAB, "a", "b"]);
  });

  it("a note with cards on its board lists 白板 first among the views", () => {
    expect(keys({ earnsWhiteboard: true, views: [view("a", "table")] })).toEqual([CONTENT_TAB, CANVAS_TAB, "a"]);
  });

  it("a whiteboard record the server made (named Canvas) shows under the person's own word for it", () => {
    const tabs = buildViewTabs({ views: [view("w", "canvas", { name: "Canvas", layout_config: { opens_first: true } })], ...base });
    expect(tabs.map((tab) => tab.name)).toEqual(["內容", "白板"]);
    const renamed = buildViewTabs({ views: [view("w", "canvas", { name: "地圖" })], ...base });
    expect(renamed.map((tab) => tab.name)).toEqual(["內容", "地圖"]);
  });

  it("no 白板 tab while the whiteboard module is off", () => {
    expect(keys({ canvasImported: false, earnsWhiteboard: true })).toEqual([CONTENT_TAB]);
  });

  it("a stored whiteboard record takes its own place and name; a hidden one is not a tab", () => {
    const stored = view("w", "canvas", { name: "My board", pin_order: 1 });
    const tabs = buildViewTabs({ views: [view("a", "table"), stored, view("b", "kanban")], ...base });
    expect(tabs.map((tab) => [tab.key, tab.name])).toEqual([[CONTENT_TAB, "內容"], ["a", "a"], ["b", "b"], [CANVAS_TAB, "My board"]]);
    expect(keys({ earnsWhiteboard: true, views: [view("w", "canvas", { layout_config: { hidden: true } })] })).toEqual([CONTENT_TAB]);
  });

  it("a stored whiteboard record shows its tab with no cards on the board yet; a converted note's removed tab stays removed", () => {
    expect(keys({ views: [view("w", "canvas", { layout_config: { opens_first: true } })] })).toEqual([CONTENT_TAB, CANVAS_TAB]);
    expect(keys({ views: [view("w", "canvas", { layout_config: { opens_first: true, hidden: true } })] })).toEqual([CONTENT_TAB]);
  });

  it("an inherited view is shown but not editable; the others follow canManage", () => {
    const tabs = buildViewTabs({ views: [view("i", "table", { inherited_from: "p", inherited_name: "Parent" }), view("o", "table")], ...base });
    expect(tabs.map((tab) => [tab.key, tab.editable, tab.inheritedName])).toEqual([[CONTENT_TAB, false, null], ["i", false, "Parent"], ["o", true, null]]);
    expect(buildViewTabs({ views: [view("o", "table")], ...base, canManage: false }).every((tab) => !tab.editable)).toBe(true);
  });
});

describe("active tab and location", () => {
  it("maps lens and view tab to a key and back", () => {
    expect(activeTabKey({ lens: "editor", viewTab: null })).toBe(CONTENT_TAB);
    expect(activeTabKey({ lens: "canvas", viewTab: null })).toBe(CANVAS_TAB);
    expect(activeTabKey({ lens: "editor", viewTab: "v1" })).toBe("v1");
    // Every page's whiteboard tab is the canvas lens, a converted board's too.
    expect(locationOfTab("v1")).toEqual({ lens: "editor", viewTab: "v1" });
    expect(locationOfTab(CANVAS_TAB)).toEqual({ lens: "canvas", viewTab: null });
    expect(locationOfTab(CONTENT_TAB)).toEqual({ lens: "editor", viewTab: null });
  });

  it("the URL carries the saved-view tab, only in the editor lens", () => {
    expect(locationToSearch({ view: "notes", nodeId: "n", lens: "editor", viewTab: "v1" })).toBe("?view=notes&node=n&lens=editor&tab=v1");
    expect(locationToSearch({ view: "notes", nodeId: "n", lens: "canvas", viewTab: "v1" })).toBe("?view=notes&node=n&lens=canvas");
    const fallback = { view: "notes", nodeId: null, lens: "editor" } as const;
    expect(parseLocation("?view=notes&node=n&lens=editor&tab=v1", fallback).viewTab).toBe("v1");
    expect(parseLocation("?view=notes&node=n&lens=canvas&tab=v1", fallback).viewTab ?? null).toBeNull();
    expect(parseLocation("?view=notes&node=n", fallback).viewTab ?? null).toBeNull();
  });
});

describe("reorderTabs", () => {
  const tabs = buildViewTabs({ views: [view("a", "table", { pin_order: 0 }), view("b", "table", { pin_order: 1 }), view("c", "table", { pin_order: 2 })], ...base });
  it("moves a tab and returns only the places that changed", () => {
    expect(reorderTabs(tabs, "c", 0).map((c) => [c.tab.key, c.pinOrder])).toEqual([["c", 0], ["a", 1], ["b", 2]]);
    expect(reorderTabs(tabs, "a", 0)).toEqual([]);
  });
  it("a whiteboard without a record is stored with its new place", () => {
    const withBoard = buildViewTabs({ views: [view("a", "table")], ...base, earnsWhiteboard: true });
    expect(reorderTabs(withBoard, CANVAS_TAB, 1).map((c) => [c.tab.key, c.pinOrder])).toEqual([[CANVAS_TAB, 1]]);
  });
});

describe("names and memory", () => {
  beforeEach(() => { localStorage.clear(); bindAccountStorage("view-tabs-test", ""); });
  it("a new view gets a free name", () => {
    expect(freeViewName("Table", [])).toBe("Table");
    expect(freeViewName("Table", ["Table", "Table 2"])).toBe("Table 3");
  });
  it("remembers the tab a note was left on; 內容 forgets it", () => {
    expect(rememberedTab("n1")).toBeNull();
    rememberTab("n1", "v1");
    expect(rememberedTab("n1")).toBe("v1");
    rememberTab("n1", CONTENT_TAB);
    expect(rememberedTab("n1")).toBeNull();
  });
  it("a page that opens on its whiteboard remembers 內容 like any other choice, and forgets the whiteboard", () => {
    rememberTab("w1", CONTENT_TAB, CANVAS_TAB);
    expect(rememberedTab("w1")).toBe(CONTENT_TAB);
    rememberTab("w1", CANVAS_TAB, CANVAS_TAB);
    expect(rememberedTab("w1")).toBeNull();
  });
});


describe("「內容」 that can be removed from the tabs (a record of layout content)", () => {
  const content = (extra: Partial<SavedView> = {}) => view("c", "content", { name: "Content", ...extra });
  const tabsOf = (views: SavedView[], more: Partial<Parameters<typeof buildViewTabs>[0]> = {}) => buildViewTabs({ views, ...base, ...more });

  it("a note with no record keeps 「內容」 fixed first, as every note made before did; it can be removed when another tab shows", () => {
    const alone = tabsOf([]);
    expect(alone.map((tab) => [tab.key, tab.view, tab.editable, tab.hideable])).toEqual([[CONTENT_TAB, null, false, false]]);
    const withViews = tabsOf([view("a", "table")]);
    expect(withViews.map((tab) => tab.key)).toEqual([CONTENT_TAB, "a"]);
    expect(withViews[0]).toMatchObject({ editable: false, hideable: true });
    // Read-only, and a tag's first tab (its list): not removable.
    expect(tabsOf([view("a", "table")], { canManage: false })[0]!.hideable).toBe(false);
    expect(tabsOf([view("a", "table")], { ownerKind: "tag" })[0]!.hideable).toBe(false);
  });

  it("a record that says hidden takes 「內容」 out of the row; the others keep their order", () => {
    const tabs = tabsOf([content({ layout_config: { hidden: true } }), view("a", "table"), view("b", "calendar", { pin_order: 1 })]);
    expect(tabs.map((tab) => tab.key)).toEqual(["a", "b"]);
  });

  it("a record that does not say hidden puts 「內容」 where its pin_order says, and it can be moved, renamed and hidden", () => {
    const tabs = tabsOf([view("a", "table"), content({ pin_order: 1 }), view("b", "calendar", { pin_order: 2 })]);
    expect(tabs.map((tab) => tab.key)).toEqual(["a", CONTENT_TAB, "b"]);
    expect(tabs[1]).toMatchObject({ editable: true, hideable: true, kind: "content", name: "內容" });
    // The stored name is only the English word; the row shows the person's own, and 「內容」 cannot be renamed.
    expect(buildViewTabs({ views: [content({ name: "Content 2" })], ...base })[0]!.name).toBe("內容");
    // It moves among the others like any tab: dropping it first puts the table second.
    expect(reorderTabs(tabs, CONTENT_TAB, 0).map(({ tab, pinOrder }) => [tab.key, pinOrder])).toEqual([[CONTENT_TAB, 0], ["a", 1]]);
  });

  it("the built-in 「內容」 is not part of a move; a 「內容」 with a record is", () => {
    const builtIn = tabsOf([view("a", "table"), view("b", "calendar", { pin_order: 1 })]);
    expect(reorderTabs(builtIn, "b", 0).map(({ tab }) => tab.key)).toEqual(["b", "a"]);
    expect(reorderTabs(builtIn, CONTENT_TAB, 1)).toEqual([]);
  });

  it("a page always shows one tab: with nothing else, a hidden 「內容」 still shows, and cannot be removed", () => {
    const tabs = tabsOf([content({ layout_config: { hidden: true } })]);
    expect(tabs.map((tab) => [tab.key, tab.hideable])).toEqual([[CONTENT_TAB, false]]);
    // A module that is off takes its tab out of the row; the last one left stays.
    expect(tabsOf([content({ layout_config: { hidden: true } }), view("s", "slides")], { hiddenLayouts: new Set(["slides"]) }).map((tab) => tab.key)).toEqual([CONTENT_TAB]);
  });

  it("the default tab: the built-in 「內容」; else the whiteboard that opens first; else the first tab showing", () => {
    expect(defaultTabKey(tabsOf([view("a", "table")]))).toBe(CONTENT_TAB);
    expect(defaultTabKey(tabsOf([content({ layout_config: { hidden: true } }), view("a", "table"), view("b", "calendar", { pin_order: 1 })]))).toBe("a");
    expect(defaultTabKey(tabsOf([content({ layout_config: { hidden: true } }), view("a", "table"), view("w", "canvas", { pin_order: 1, layout_config: { opens_first: true } })]))).toBe(CANVAS_TAB);
    // A hidden whiteboard does not open first; 「內容」 shown but not first: the first tab is the default, no flag needed.
    expect(defaultTabKey(tabsOf([view("a", "table"), content({ pin_order: 1 })]))).toBe("a");
    expect(defaultTabKey(tabsOf([content({ layout_config: { hidden: true } }), view("a", "table"), view("w", "canvas", { layout_config: { opens_first: true, hidden: true } })]))).toBe("a");
    expect(defaultTabKey([])).toBe(CONTENT_TAB);
  });

  it("the order is pin_order then name, whatever order the list came in (the note's own row lists by creation, /views by place)", () => {
    const created = [view("t", "table", { pin_order: 1 }), content({ pin_order: 0 }), view("k", "kanban", { pin_order: 1 })];
    expect(tabsOf(created).map((tab) => tab.key)).toEqual([CONTENT_TAB, "k", "t"]);
    expect(defaultTabKey(tabsOf(created))).toBe(CONTENT_TAB);
    // 「內容」 moved after the table, created first: the table is the default, as /views says.
    const moved = [content({ pin_order: 2 }), view("t", "table", { pin_order: 1 })];
    expect(defaultTabKey(tabsOf(moved))).toBe("t");
  });

  it("one default rule: an opens-first whiteboard wins over the built-in 「內容」 too, and so does a retired board with no record", () => {
    const board = view("w", "canvas", { layout_config: { opens_first: true } });
    expect(defaultTabKey(tabsOf([board, view("a", "table")]))).toBe(CANVAS_TAB);
    expect(defaultTabKey(tabsOf([view("a", "table")], { earnsWhiteboard: true }))).toBe(CONTENT_TAB);
    expect(defaultTabKey(tabsOf([view("a", "table")], { earnsWhiteboard: true, retiredBoard: true }))).toBe(CANVAS_TAB);
  });

  it("a view list finds the record whether it is hidden or not", () => {
    expect(contentTabIn([view("a", "table")])).toBeNull();
    expect(contentTabIn([view("a", "table"), content()])?.id).toBe("c");
  });
});
