// Capture is a built-in module (docs/agents/decisions-modules.md): always on, no
// switch, not in Settings › Modules, with a page of its own (not a nav
// destination: the phone's 筆記 tab and the desktop sidebar open it) and a mark
// that counts what waits.
import { describe, expect, it, vi } from "vitest";
import { BUILT_IN_MODULES, MODULES, MODULE_SCREENS, isModuleScreen, moduleEntry, moduleFilterFor, moduleStatusFor } from "../modules";
import { arrangeNavigation, getMoreNavigationGroups } from "../hooks/shellNavigation";
import { importedFeatures } from "../hooks/useImportedFeatures";
import type { NavLayout } from "../lib/navLayout";
import { ZH_TW } from "../lib/i18n.zh-TW";

const actions = { setMode: vi.fn(), onOpenModule: vi.fn(), onOpenFeature: vi.fn() };
const navFor = (modules: string[] | null, stored: NavLayout | null = null) => {
  const features = importedFeatures(moduleFilterFor(modules), [], { nodes: [], tags: [] });
  return { features, nav: arrangeNavigation({ mode: "notes" }, actions, features, stored) };
};

describe("the capture module", () => {
  it("is a built-in module with a backend twin, not a library module", () => {
    expect(BUILT_IN_MODULES.map((m) => m.id)).toContain("capture");
    expect(MODULES.map((m) => m.id)).not.toContain("capture");
    expect(BUILT_IN_MODULES.find((m) => m.id === "capture")?.frontendOnly).toBeUndefined();
  });

  it("is always on, whatever the workspace's module list says", () => {
    expect(moduleFilterFor([])("capture")).toBe(true);
    expect(moduleFilterFor(["canvas"])("capture")).toBe(true);
    expect(moduleStatusFor([], [])("capture")).toBe("on");
  });

  it("has a page at ?view=capture", () => {
    expect(MODULE_SCREENS.has("capture")).toBe(true);
    expect(isModuleScreen("capture")).toBe(true);
    expect(moduleEntry("capture")).toEqual({ view: "capture" });
    expect(MODULE_SCREENS.get("capture")?.label).toBe("Inbox");
  });

  it("is no nav destination: not pinnable, not in 更多, not in the editor's lists, and an old stored pin drops out", () => {
    const { features, nav } = navFor(null);
    expect(nav.candidates.map((d) => d.id)).not.toContain("capture");
    expect([...nav.pinned, ...nav.unpinned, ...nav.phoneMore].map((d) => d.id)).not.toContain("capture");
    expect(features.map((f) => f.mod.id)).not.toContain("capture");
    expect(getMoreNavigationGroups({}, nav.phoneMore).flatMap((g) => g.items.map((i) => i.id))).not.toContain("capture");
    const old = navFor(null, { order: ["tasks", "capture", "graph"], phone: 2 }).nav;
    expect(old.layout).toEqual({ order: ["tasks", "graph"], phone: 1 });
    expect(old.phoneBar.map((d) => d.id)).toEqual(["tasks"]);
  });

  it("the inbox page is where decisions wait: no sentence still says 待審, and the ones that point there say 收件匣", () => {
    expect(ZH_TW["Inbox"]).toBe("收件匣");
    expect(ZH_TW["Review queue"]).toBeUndefined();
    expect(ZH_TW["Go to the inbox"]).toBe("前往收件匣");
    expect(Object.values(ZH_TW).filter((zh) => zh.includes("待審") && !zh.includes("待審核") && !zh.includes("待審查"))).toEqual([]);
    const pointers = Object.entries(ZH_TW).filter(([key]) => /both of you changed/.test(key) && /inbox/i.test(key));
    expect(pointers.length).toBeGreaterThan(2);
    for (const [, zh] of pointers) expect(zh).toContain("收件匣「等你決定」");
  });

});
