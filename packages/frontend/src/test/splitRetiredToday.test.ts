import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

const saved = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("../lib/accountPrefStore", () => ({
  createAccountPref: () => ({ bound: () => true, store: { save: saved.save }, useKeepInSync: () => {}, useValue: () => ({ value: null, settled: true }) }),
}));

import "../modules"; // registers the shell features the rule asks about
import { resetAppState, setData } from "../lib/appStore";
import { applySavedSplit, applyUrlRight, getSplit, setRight } from "../lib/splitViewStore";

// 「今天」 was a page until 2026-11-18. A side-by-side pane that still names it (the address's `right=page:today`, or the
// pane saved with the account) opens where `view=today` does (lib/retiredViews), never an empty pane called "today".
const withModules = (modules: string[] | null) => setData((data) => ({ ...data, workspace: { ...data.workspace, modules } as typeof data.workspace }));

beforeEach(() => { resetAppState(); saved.save.mockClear(); });
afterEach(() => { setRight(null); applyUrlRight(null); });

describe("a right pane that names the retired 今天 page", () => {
  it("the address: opens 任務, else 日記, else stays closed", () => {
    withModules(["tasks", "daily"]);
    applyUrlRight("page:today");
    expect(getSplit().right).toEqual({ kind: "page", mode: "tasks" });
    withModules(["daily"]);
    applyUrlRight(null); applyUrlRight("page:today");
    expect(getSplit().right).toEqual({ kind: "page", mode: "daily" });
    withModules([]);
    applyUrlRight(null); applyUrlRight("page:today");
    expect(getSplit().right).toBeNull();
  });

  it("the saved pane: the same rule", () => {
    withModules(["tasks"]);
    applySavedSplit({ right: "page:today", ratio: 0.5 });
    expect(getSplit().right).toEqual({ kind: "page", mode: "tasks" });
    withModules(["daily"]);
    applySavedSplit({ right: "page:today", ratio: 0.5 });
    expect(getSplit().right).toEqual({ kind: "page", mode: "daily" });
    withModules([]);
    applySavedSplit({ right: "page:today", ratio: 0.5 });
    expect(getSplit().right).toBeNull();
  });

  it("the saved pane is saved over with where it opened (or closed), so it is not resolved again at every start", () => {
    withModules(["tasks"]);
    applySavedSplit({ right: "page:today", ratio: 0.5 });
    expect(saved.save).toHaveBeenCalledWith({ right: "page:tasks", ratio: 0.5 });
    withModules([]);
    applySavedSplit({ right: "page:today", ratio: 0.5 });
    expect(saved.save).toHaveBeenLastCalledWith({ right: null, ratio: 0.5 });
    saved.save.mockClear();
    applySavedSplit({ right: "page:graph", ratio: 0.5 });
    expect(saved.save).not.toHaveBeenCalled();
  });

  it("other pages are read as before", () => {
    applyUrlRight("page:graph");
    expect(getSplit().right).toEqual({ kind: "page", mode: "graph" });
  });
});
