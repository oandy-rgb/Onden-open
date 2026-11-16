// A saved view's layout may be a view module's or the whiteboard's (a tab
// that keeps its name and place; services/viewLayouts.ts). No database.
import { beforeAll, describe, expect, it } from "vitest";
import { assertLayoutForTag, viewCreateSchema, viewPatchSchema } from "../services/tagViews.js";
import { CONTENT_LAYOUT } from "@onden/markdown/contract";
import { isNoteOnlyViewLayout, isStoredViewLayout, isViewLayout, viewLayouts, WHITEBOARD_LAYOUT } from "../services/viewLayouts.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

beforeAll(() => registerShippedModules());

describe("stored view layouts", () => {
  it("are the view modules and the whiteboard; only the modules make module tags", () => {
    for (const layout of viewLayouts()) expect(isStoredViewLayout(layout)).toBe(true);
    expect(isStoredViewLayout(WHITEBOARD_LAYOUT)).toBe(true);
    expect(isViewLayout(WHITEBOARD_LAYOUT)).toBe(false);
  });

  it("a canvas view can be created and patched with its place and hidden flag", () => {
    expect(viewCreateSchema.parse({ name: "Canvas", layout: "canvas", pin_order: 2 })).toMatchObject({ layout: "canvas", pin_order: 2, visible_fields: [] });
    expect(viewPatchSchema.parse({ layout_config: { hidden: true } })).toEqual({ layout_config: { hidden: true } });
    expect(viewPatchSchema.parse({ pin_order: 0 })).toEqual({ pin_order: 0 });
  });

  it("the slides' 「簡報」 is a stored layout of a note's views, not a view module (no module tag)", () => {
    expect(isStoredViewLayout("slides")).toBe(true);
    expect(isViewLayout("slides")).toBe(false);
    expect(viewCreateSchema.parse({ name: "Slides", layout: "slides" })).toMatchObject({ layout: "slides", visible_fields: [] });
  });

  it("only a note's tab row takes the slides view: a tag's views refuse it, with every other layout allowed", () => {
    expect(isNoteOnlyViewLayout("slides")).toBe(true);
    for (const layout of [...viewLayouts(), WHITEBOARD_LAYOUT, undefined]) expect(isNoteOnlyViewLayout(layout)).toBe(false);
    expect(() => assertLayoutForTag("slides")).toThrowError(expect.objectContaining({ status: 422, code: "view_layout_not_for_tags" }));
    expect(() => assertLayoutForTag("canvas")).not.toThrow();
    expect(() => assertLayoutForTag(undefined)).not.toThrow();
  });

  it("a note's own 「內容」 tab is a stored layout of a note's views: not a view module, and a tag's views refuse it", () => {
    expect(CONTENT_LAYOUT).toBe("content");
    expect(isStoredViewLayout(CONTENT_LAYOUT)).toBe(true);
    expect(isViewLayout(CONTENT_LAYOUT)).toBe(false);
    expect(isNoteOnlyViewLayout(CONTENT_LAYOUT)).toBe(true);
    expect(viewCreateSchema.parse({ name: "Content", layout: "content", pin_order: 3 })).toMatchObject({ layout: "content", pin_order: 3, visible_fields: [] });
    expect(() => assertLayoutForTag(CONTENT_LAYOUT)).toThrowError(expect.objectContaining({ status: 422, code: "view_layout_not_for_tags" }));
  });

  it("an unknown layout is still refused, and the old list layout is a table", () => {
    expect(viewCreateSchema.safeParse({ name: "x", layout: "timeline" }).success).toBe(false);
    expect(viewCreateSchema.parse({ name: "x", layout: "list" }).layout).toBe("table");
  });
});
