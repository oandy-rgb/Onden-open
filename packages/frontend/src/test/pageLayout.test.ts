import { describe, expect, it } from "vitest";
import { CORE_PAGES, pageLayout } from "../hooks/shellNavigation";
import { MODULE_SCREENS, READING_SECTIONS } from "../modules";

// Which pages show the note sidebar and the info panel: one answer, pageLayout.
describe("pageLayout", () => {
  it("keeps the note sidebar beside 筆記", () => {
    expect(pageLayout("notes")).toBe("sidebar");
  });

  it("gives 關係圖 the whole width", () => {
    expect(pageLayout("graph")).toBe("full");
  });

  it("gives 任務 the whole width: no note sidebar, no info panel", () => {
    expect(pageLayout("tasks")).toBe("full");
  });

  it("gives History the whole width", () => {
    expect(pageLayout("timeline")).toBe("full");
  });

  it("makes every module screen and reading section a full page", () => {
    const views = [...MODULE_SCREENS.keys(), ...READING_SECTIONS.map((s) => s.id)];
    expect(views.length).toBeGreaterThan(0);
    for (const view of views) expect(pageLayout(view)).toBe("full");
  });

  it("has a layout for every core page", () => {
    for (const page of CORE_PAGES) expect(["sidebar", "full"]).toContain(page.layout);
  });
});
