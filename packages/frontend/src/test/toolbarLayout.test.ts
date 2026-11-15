import { describe, expect, it } from "vitest";
import {
  BAR_TOOLS, DEFAULT_TOOLBAR_LAYOUT, SELECTION_TOOLS, TOUCH_LABELED_LIMIT, isDefaultToolbar, moveTool, parseToolbarLayout, placeTool,
  resetToolbar, resolveToolbar, setToolShown, toolbarRows, PARAGRAPH_TOOLS, type ToolbarLayout,
} from "../lib/toolbarLayout";
import { TOOL_ICONS } from "../components/toolbarIcons";

const ids = (tools: Array<{ id: string }>) => tools.map((tool) => tool.id);
const all = (surface: "bar" | "selection") => new Set((surface === "bar" ? BAR_TOOLS : SELECTION_TOOLS).map((tool) => tool.id));

describe("the default toolbars", () => {
  it("the phone bar shows everything, the paragraph tools first (加標籤, 複製段落連結, 交給 AI…); there is no 「這段」 button; nothing waits in 更多", () => {
    const { shown, more } = resolveToolbar(null, "bar");
    expect(ids(shown).slice(0, 7)).toEqual(["tag", "copyLink", "ai", "toChild", "history", "convertTask", "expand"]);
    expect(ids(shown)).not.toContain("paragraph");
    expect(ids(shown)).toHaveLength(BAR_TOOLS.length);
    expect(more).toEqual([]);
  });

  it("the selection bar shows 變成子筆記 and 加標籤 first, then the formats; the contextual and less used wait in 更多", () => {
    const { shown, more } = resolveToolbar(null, "selection");
    expect(ids(shown)).toEqual(["toChild", "tag", "ai", "bold", "italic", "strike", "underline", "highlight", "code", "link", "quote", "h1", "h2", "h3"]);
    expect(ids(more)).toEqual(["copyLink", "history", "convertTask", "expand"]);
  });

  it("only Onden actions carry words: a general format never does", () => {
    const withWords = [...BAR_TOOLS, ...SELECTION_TOOLS].filter((tool) => tool.onden).map((tool) => tool.id);
    expect(new Set(withWords)).toEqual(new Set(["tag", "toChild", "copyLink", "history", "convertTask", "expand"]));
    for (const id of ["bold", "italic", "h1", "quote", "link", "wikilink", "insertFile", "bullet"]) {
      expect([...BAR_TOOLS, ...SELECTION_TOOLS].find((tool) => tool.id === id)?.onden).toBe(false);
    }
  });

  it("the four actions that used to hide in the 「這段」 menu are buttons of both toolbars, and 「複製段落連結」 does not share the link icon", () => {
    for (const id of ["ai", "copyLink", "history", "toChild"]) {
      expect(ids([...BAR_TOOLS]), id).toContain(id);
      expect(ids([...SELECTION_TOOLS]), id).toContain(id);
    }
    expect(TOOL_ICONS.copyLink).not.toBe(TOOL_ICONS.wikilink);
    expect(TOOL_ICONS.copyLink).not.toBe(TOOL_ICONS.link);
    expect(PARAGRAPH_TOOLS.every((id) => TOOL_ICONS[id])).toBe(true);
  });

  it("ids are unique within a surface", () => {
    for (const tools of [BAR_TOOLS, SELECTION_TOOLS]) expect(new Set(ids([...tools])).size).toBe(tools.length);
  });
});

describe("editing a toolbar", () => {
  it("turning a button off puts it in 更多, and on again joins the end", () => {
    const off = setToolShown(null, "bar", "bold", false)!;
    const { shown, more } = resolveToolbar(off, "bar");
    expect(ids(shown)).not.toContain("bold");
    expect(ids(more)).toEqual(["bold"]);
    const on = setToolShown(off, "bar", "bold", true)!;
    expect(ids(resolveToolbar(on, "bar").shown).at(-1)).toBe("bold");
    expect(ids(resolveToolbar(on, "bar").more)).toEqual([]);
  });

  it("each surface is edited on its own", () => {
    const off = setToolShown(null, "selection", "bold", false)!;
    expect(off.bar).toBeNull();
    expect(ids(resolveToolbar(off, "bar").shown)).toContain("bold");
    expect(isDefaultToolbar(off, "bar")).toBe(true);
    expect(isDefaultToolbar(off, "selection")).toBe(false);
  });

  it("moves a shown button up or down, and stops at the ends", () => {
    const up = moveTool(null, "bar", "tag", -1)!;
    expect(ids(resolveToolbar(up, "bar").shown).slice(0, 2)).toEqual(["tag", "copyLink"]);
    expect(moveTool(up, "bar", "tag", -1)).toBe(up);
    const last = BAR_TOOLS.at(-1)!.id;
    expect(moveTool(null, "bar", last, 1)).toBeNull();
    expect(moveTool(null, "bar", "no-such-button", 1)).toBeNull();
  });

  it("drag-to-reorder puts a button before the row at the index", () => {
    const placed = placeTool(null, "bar", "quote", 0)!;
    expect(ids(resolveToolbar(placed, "bar").shown).slice(0, 2)).toEqual(["quote", "tag"]);
    const later = placeTool(null, "bar", "tag", 3)!;
    expect(ids(resolveToolbar(later, "bar").shown).slice(0, 3)).toEqual(["copyLink", "ai", "tag"]);
  });

  it("「恢復預設」 returns one surface to the default, and everything default is null again", () => {
    const edited = setToolShown(setToolShown(null, "bar", "bold", false), "selection", "bold", false)!;
    const barBack = resetToolbar(edited, "bar")!;
    expect(isDefaultToolbar(barBack, "bar")).toBe(true);
    expect(isDefaultToolbar(barBack, "selection")).toBe(false);
    expect(resetToolbar(barBack, "selection")).toBeNull();
  });

  it("ignores an id that isn't on the surface", () => {
    expect(setToolShown(null, "bar", "strike", true)).toBeNull();
  });
});

describe("a stored layout over today's buttons", () => {
  it("drops unknown and repeated ids, and a button added later starts in 更多", () => {
    const stored: ToolbarLayout = { bar: ["gone", "bold", "bold", "tag"], selection: null };
    const { shown, more } = resolveToolbar(stored, "bar");
    expect(ids(shown)).toEqual(["bold", "tag"]);
    expect(ids(more)).toContain("copyLink");
    expect(ids(more)).toHaveLength(BAR_TOOLS.length - 2);
  });

  it("a layout that hides everything still leaves 更多 holding every button", () => {
    const { shown, more } = resolveToolbar({ bar: [], selection: null }, "bar");
    expect(shown).toEqual([]);
    expect(ids(more)).toEqual(BAR_TOOLS.map((tool) => tool.id));
  });
});

describe("what a bar draws", () => {
  it("leaves out buttons that don't apply now, from both lists", () => {
    const available = all("selection");
    available.delete("history"); available.delete("tag");
    const { shown, more } = toolbarRows(null, "selection", available, false);
    expect(ids(shown)).not.toContain("tag");
    expect(ids(more)).not.toContain("history");
    expect(ids(more)).toContain("copyLink");
  });

  it("a touch bar keeps the first two Onden buttons in words; later ones join 更多, first", () => {
    const layout = setToolShown(setToolShown(DEFAULT_TOOLBAR_LAYOUT, "selection", "copyLink", true), "selection", "history", true);
    const touch = toolbarRows(layout, "selection", all("selection"), true);
    expect(TOUCH_LABELED_LIMIT).toBe(2);
    expect(ids(touch.shown.filter((tool) => tool.onden))).toEqual(["toChild", "tag"]);
    expect(ids(touch.more).slice(0, 2)).toEqual(["copyLink", "history"]);
    // A mouse has room for all of them.
    const mouse = toolbarRows(layout, "selection", all("selection"), false);
    expect(ids(mouse.shown.filter((tool) => tool.onden))).toEqual(["toChild", "tag", "copyLink", "history"]);
  });
});

describe("parseToolbarLayout", () => {
  it("reads what it stores, and null per surface for the default", () => {
    expect(parseToolbarLayout({ bar: ["bold"], selection: null })).toEqual({ bar: ["bold"], selection: null });
    expect(parseToolbarLayout({ bar: null, selection: ["tag", "tag"] })).toEqual({ bar: null, selection: ["tag"] });
  });

  it("refuses anything else", () => {
    for (const value of [null, "x", 3, [], {}, { bar: ["a"] }, { bar: [1], selection: null }, { bar: [""], selection: null }, { bar: "a", selection: null }]) {
      expect(parseToolbarLayout(value)).toBeNull();
    }
  });
});
