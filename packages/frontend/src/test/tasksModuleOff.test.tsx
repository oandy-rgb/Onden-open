// With the tasks module off the Tasks page has no entry: not in the nav, not in
// 更多, not in the palette or the quick-add overlay (the module supplies the
// "tasks" shell feature, lib/shellFeatures); the page itself points at the module
// library. Turning it off keeps the tasks (modules/tasks).
import { describe, expect, it, vi } from "vitest";
import { arrangeNavigation, getMoreNavigationGroups, getNavDestinations } from "../hooks/shellNavigation";
import { moduleFilterFor, MODULES } from "../modules";
import { shellFeatureModule, shellFeatureOnIn } from "../lib/shellFeatures";

const actions = { setMode: vi.fn(), onOpenModule: vi.fn(), onOpenFeature: vi.fn() };

describe("tasks module off", () => {
  it("names the module that supplies the tasks feature", () => {
    expect(shellFeatureModule("tasks")).toBe("tasks");
    expect(MODULES.find((m) => m.shellFeature === "tasks")?.id).toBe("tasks");
  });

  it("reads the feature from the workspace's module list", () => {
    expect(shellFeatureOnIn(["daily"], "tasks")).toBe(false);
    expect(shellFeatureOnIn(["tasks"], "tasks")).toBe(true);
    expect(shellFeatureOnIn(null, "tasks")).toBe(true);
  });

  it("keeps the Tasks page out of the nav and the 更多 sheet", () => {
    const on = (modules: string[]) => (feature: Parameters<typeof shellFeatureOnIn>[1]) => shellFeatureOnIn(modules, feature);
    const ids = (modules: string[]) => getNavDestinations({ mode: "notes" }, actions, [], on(modules)).core.map((d) => d.id);
    expect(ids(["tasks"])).toContain("tasks");
    expect(ids(["daily"])).not.toContain("tasks");
    const more = (modules: string[]) => getMoreNavigationGroups({}, arrangeNavigation({ mode: "notes" }, actions, [], { order: [], phone: 0 }, on(modules)).phoneMore)
      .flatMap((g) => g.items.map((i) => i.id));
    expect(more(["tasks"])).toContain("tasks");
    expect(more(["daily"])).not.toContain("tasks");
  });

  it("an unfiltered nav still shows every page (tests, older servers)", () => {
    expect(getNavDestinations({ mode: "notes" }, actions, []).core.map((d) => d.id)).toContain("tasks");
    expect(moduleFilterFor(null)("tasks")).toBe(true);
  });
});
