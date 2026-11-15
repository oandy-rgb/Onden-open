// @vitest-environment jsdom
// lib/prefs — the one owner of localStorage (depth audit D19): device keys keep
// their exact names, account keys live under the bound account, nothing throws,
// and the node-id stores move their old unscoped value onto the first account.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

beforeEach(() => { vi.resetModules(); vi.stubEnv("VITE_NATIVE", "false"); localStorage.clear(); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

/** A fresh page: new module instances, optionally bound to an account. */
async function page(user?: string) {
  vi.resetModules();
  const account = await import("../lib/accountStorage");
  if (user) expect(account.bindAccountStorage(user, "")).toBe(true);
  return { prefs: await import("../lib/prefs"), account };
}

function blockStorage() {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
}

describe("prefs", () => {
  it("keeps device keys under their exact names", async () => {
    const { prefs: { PREFS, getPref, setPref, removePref } } = await page();
    expect(setPref(PREFS.focusMode, "1")).toBe(true);
    expect(localStorage.getItem("onden.focusMode")).toBe("1");
    expect(getPref(PREFS.focusMode)).toBe("1");
    expect(removePref(PREFS.focusMode)).toBe(true);
    expect(getPref(PREFS.focusMode)).toBeNull();
  });

  it("every registry key is unique and declares a scope", async () => {
    const { prefs: { PREFS } } = await page();
    const keys = Object.values(PREFS).map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of Object.values(PREFS)) expect(["device", "account"]).toContain(p.scope);
  });

  it("never throws when storage is blocked or full", async () => {
    const { prefs: { PREFS, getPref, setPref, removePref, getPrefJson, setPrefJson, prefsAvailable } } = await page("a");
    blockStorage();
    expect(getPref(PREFS.focusMode)).toBeNull();
    expect(setPref(PREFS.focusMode, "1")).toBe(false);
    expect(removePref(PREFS.focusMode)).toBe(false);
    expect(getPrefJson(PREFS.frecency)).toBeNull();
    expect(setPrefJson(PREFS.frecency, {})).toBe(false);
    expect(prefsAvailable(PREFS.frecency)).toBe(false);
  });

  it("reads unparsable JSON as missing", async () => {
    const { prefs: { PREFS, getPrefJson } } = await page();
    localStorage.setItem("onden.palette.lastRun", "{not json");
    expect(getPrefJson(PREFS.paletteLastRun)).toBeNull();
  });

  it("an account key is missing before the page is bound, and per account after", async () => {
    let { prefs } = await page();
    expect(prefs.prefsAvailable(prefs.PREFS.pinnedTagViews)).toBe(false);
    expect(prefs.setPref(prefs.PREFS.pinnedTagViews, "t1")).toBe(false);
    expect(prefs.getPref(prefs.PREFS.pinnedTagViews)).toBeNull();
    expect(prefs.prefKey(prefs.PREFS.pinnedTagViews)).toBeNull();

    ({ prefs } = await page("a"));
    expect(prefs.setPref(prefs.PREFS.pinnedTagViews, "t1")).toBe(true);
    expect(prefs.prefKey(prefs.PREFS.pinnedTagViews)).toMatch(/^onden\.pinnedTagViews:account-v1:/);
    expect(localStorage.getItem("onden.pinnedTagViews")).toBeNull();

    ({ prefs } = await page("b"));
    expect(prefs.getPref(prefs.PREFS.pinnedTagViews)).toBeNull();

    ({ prefs } = await page("a"));
    expect(prefs.getPref(prefs.PREFS.pinnedTagViews)).toBe("t1");
  });

  it("the native app scopes account keys too; the account that adopts its old store takes the unscoped values", async () => {
    vi.stubEnv("VITE_NATIVE", "true");
    localStorage.setItem("onden.lostWrites", "[1]");
    localStorage.setItem("onden-storage-pref", "opfs");
    // First start of this build, pointed at server A: the old store is A's.
    (await page()).account.stampLegacyNativeStore("https://a.example");
    // Another server's account does not see them, and they stay put.
    vi.resetModules();
    let account = await import("../lib/accountStorage");
    expect(account.bindAccountStorage("u", "https://b.example")).toBe(true);
    let prefs = await import("../lib/prefs");
    expect(prefs.getPref(prefs.PREFS.lostWrites)).toBeNull();
    expect(localStorage.getItem("onden.lostWrites")).toBe("[1]");
    // The first account on A adopts them under its own keys.
    vi.resetModules();
    account = await import("../lib/accountStorage");
    expect(account.bindAccountStorage("u", "https://a.example")).toBe(true);
    prefs = await import("../lib/prefs");
    expect(prefs.getPref(prefs.PREFS.lostWrites)).toBe("[1]");
    expect(localStorage.getItem("onden.lostWrites")).toBeNull();
    expect(localStorage.getItem(account.accountStorageKey("onden.lostWrites"))).toBe("[1]");
    // A second account on A starts empty: the store was claimed once.
    localStorage.setItem("onden-storage-pref", "opfs");
    vi.resetModules();
    account = await import("../lib/accountStorage");
    expect(account.bindAccountStorage("v", "https://a.example")).toBe(true);
    prefs = await import("../lib/prefs");
    expect(account.adoptsLegacyNativeStore()).toBe(false);
    expect(prefs.getPref(prefs.PREFS.storagePref)).toBeNull();
  });
});

describe("migrating the unscoped node-id stores", () => {
  const legacy = {
    "onden.frecency": JSON.stringify({ n1: { n: 3, t: 1 } }),
    "onden.pinnedTagViews": "tag1,tag2",
    "onden.lastLocation": "?view=notes&node=n1&lens=editor",
    "onden.dueSoon.fired": JSON.stringify(["due:n1"]),
    "onden.expandedGroups": JSON.stringify(["g1"]),
  };

  it("moves each old value onto the first account and deletes the old key", async () => {
    for (const [k, v] of Object.entries(legacy)) localStorage.setItem(k, v);
    let { prefs } = await page("a");
    const { PREFS } = prefs;
    const stores = [PREFS.frecency, PREFS.pinnedTagViews, PREFS.lastLocation, PREFS.dueSoonFired, PREFS.expandedGroups];
    for (const p of stores) {
      expect(prefs.getPref(p)).toBe(legacy[p.key as keyof typeof legacy]);
      expect(localStorage.getItem(p.key)).toBeNull();
    }
    // Another account on the same browser starts empty.
    ({ prefs } = await page("b"));
    for (const p of stores) expect(prefs.getPref(p)).toBeNull();
    // The first account keeps its values.
    ({ prefs } = await page("a"));
    for (const p of stores) expect(prefs.getPref(p)).toBe(legacy[p.key as keyof typeof legacy]);
  });

  it("an account's own value wins over a leftover old one, which is still deleted", async () => {
    let { prefs } = await page("a");
    prefs.setPref(prefs.PREFS.pinnedTagViews, "mine");
    localStorage.setItem("onden.pinnedTagViews", "stale");
    ({ prefs } = await page("a"));
    expect(prefs.getPref(prefs.PREFS.pinnedTagViews)).toBe("mine");
    expect(localStorage.getItem("onden.pinnedTagViews")).toBeNull();
  });

  it("a write migrates first, so the old value cannot reach a later account", async () => {
    localStorage.setItem("onden.lastLocation", "?view=notes&node=old");
    let { prefs } = await page("a");
    prefs.setPref(prefs.PREFS.lastLocation, "?view=tasks");
    expect(localStorage.getItem("onden.lastLocation")).toBeNull();
    ({ prefs } = await page("b"));
    expect(prefs.getPref(prefs.PREFS.lastLocation)).toBeNull();
  });

  it("keys that never adopted unowned data do not migrate", async () => {
    localStorage.setItem("onden.lostWrites", "[]");
    const { prefs } = await page("a");
    expect(prefs.getPref(prefs.PREFS.lostWrites)).toBeNull();
    expect(localStorage.getItem("onden.lostWrites")).toBe("[]");
  });

  it("frecency read through lib/frecency picks up the migrated history", async () => {
    localStorage.setItem("onden.frecency", legacy["onden.frecency"]);
    await page("a");
    const { getFrecency } = await import("../lib/frecency");
    expect(getFrecency()).toEqual({ n1: { n: 3, t: 1 } });
  });
});

describe("usePersistedFlag", () => {
  it("starts from the default and persists changes as 1/0", async () => {
    const { prefs: { PREFS, usePersistedFlag } } = await page();
    const { result } = renderHook(() => usePersistedFlag(PREFS.focusMode, false));
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    expect(localStorage.getItem("onden.focusMode")).toBe("1");
    act(() => result.current[1]((v) => !v));
    expect(localStorage.getItem("onden.focusMode")).toBe("0");
  });

  it("reads a stored value on mount; an unknown value is the default", async () => {
    const { prefs: { PREFS, usePersistedFlag } } = await page();
    localStorage.setItem("onden.inspectorOpen", "0");
    expect(renderHook(() => usePersistedFlag(PREFS.inspectorOpen, true)).result.current[0]).toBe(false);
    localStorage.setItem("onden.inspectorOpen", "garbage");
    expect(renderHook(() => usePersistedFlag(PREFS.inspectorOpen, true)).result.current[0]).toBe(true);
    localStorage.setItem("onden.canvasMinimap", "1");
    expect(renderHook(() => usePersistedFlag(PREFS.canvasMinimap, true)).result.current[0]).toBe(true);
  });

  it("keeps working for the page when storage is blocked", async () => {
    const { prefs: { PREFS, usePersistedFlag } } = await page();
    blockStorage();
    const { result } = renderHook(() => usePersistedFlag(PREFS.inspectorCollapsed, false));
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
  });
});

describe("usePersistedChoice", () => {
  const SORTS = ["natural", "modified", "title", "created"] as const;

  it("remembers the chosen option across a reload", async () => {
    const { prefs: { PREFS, usePersistedChoice } } = await page();
    const { result } = renderHook(() => usePersistedChoice(PREFS.sidebarSort, SORTS, "natural"));
    expect(result.current[0]).toBe("natural");
    act(() => result.current[1]("modified"));
    expect(localStorage.getItem("onden.sidebar.sort")).toBe("modified");
    const { prefs: reloaded } = await page();
    expect(renderHook(() => reloaded.usePersistedChoice(reloaded.PREFS.sidebarSort, SORTS, "natural")).result.current[0]).toBe("modified");
  });

  it("an unknown stored value is the default", async () => {
    const { prefs: { PREFS, usePersistedChoice } } = await page();
    localStorage.setItem("onden.sidebar.sort", "size");
    expect(renderHook(() => usePersistedChoice(PREFS.sidebarSort, SORTS, "natural")).result.current[0]).toBe("natural");
  });
});
