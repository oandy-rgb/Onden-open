// The day-note parent setting kept per account (lib/data/dayNoteParentStore,
// lib/accountPrefStore legacy): the old this-device value moves to the server
// once, the server's own value wins, and openToday reads the saved value.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

let serverPrefs: Record<string, unknown> = {};
const sendWrite = vi.hoisted(() => vi.fn());
vi.mock("../lib/data/onlineWrite", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/data/onlineWrite")>(), sendWrite }));
vi.mock("../lib/data/reads", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/data/reads")>();
  return { ...real, reads: { ...real.reads, people: { ...real.reads.people, myPref: vi.fn(async (key: string) => ({ value: serverPrefs[key] ?? null })) } } };
});

import { dayNoteParentPref, dayNoteParentSetting, dayNoteParentStore, parseDayNoteParent } from "../lib/data";
import { makeDayNotes } from "../lib/data/dayNotes";
import { bindAccountStorage } from "../lib/accountStorage";
import { noWorkspaceData } from "../lib/api";
import { getPref, PREFS, setPref } from "../lib/prefs";
import type { DataCtx } from "../lib/data/types";

const SPACE = "11111111-2222-4333-8444-555555555555";
vi.mock("../lib/spaces", async (original) => ({
  ...await original<typeof import("../lib/spaces")>(),
  personalSpaceId: () => SPACE,
}));
const created = vi.hoisted(() => vi.fn());
vi.mock("../lib/data/noteWriter", async (original) => ({
  ...await original<typeof import("../lib/data/noteWriter")>(),
  makeNoteWriter: () => ({ create: async (n: { id: string }) => { created(n); return { node: n, deduped: false, status: "synced" }; } }),
}));

beforeEach(async () => {
  localStorage.clear();
  serverPrefs = {};
  sendWrite.mockReset().mockImplementation(async (_m: string, path: string, body: { value: unknown }) => { serverPrefs[path.split("/").pop()!] = body.value; return { value: body.value }; });
  bindAccountStorage("parent-test-account", "");
  created.mockClear();
  // The store lives as long as the page: start each test from an empty account
  // that the page has already asked (settled).
  dayNoteParentStore.save(null);
  await dayNoteParentStore.sync();
  serverPrefs = {};
  sendWrite.mockClear();
});

describe("parseDayNoteParent", () => {
  it("keeps a note id and refuses anything else", () => {
    expect(parseDayNoteParent("abc")).toBe("abc");
    for (const bad of [null, "", 3, {}, "x".repeat(65)]) expect(parseDayNoteParent(bad)).toBeNull();
  });
});

describe("moving the old this-device value into the account", () => {
  it("sends it once when the server has none, then forgets the old key", async () => {
    setPref(PREFS.dayNoteParent, "Journal");
    renderHook(() => dayNoteParentPref.useKeepInSync());
    await waitFor(() => expect(serverPrefs.dayNoteParent).toBe("Journal"));
    expect(dayNoteParentSetting.get()).toBe("Journal");
    expect(getPref(PREFS.dayNoteParent)).toBeNull();
    expect(sendWrite).toHaveBeenCalledTimes(1);
  });

  it("keeps the server's value when it has one, and still drops the old key", async () => {
    serverPrefs.dayNoteParent = "FromServer";
    await dayNoteParentStore.sync(); // the page has taken the server's value
    setPref(PREFS.dayNoteParent, "Journal");
    renderHook(() => dayNoteParentPref.useKeepInSync());
    await waitFor(() => expect(getPref(PREFS.dayNoteParent)).toBeNull());
    expect(dayNoteParentSetting.get()).toBe("FromServer");
    expect(serverPrefs.dayNoteParent).toBe("FromServer");
    expect(sendWrite).not.toHaveBeenCalled();
  });

  it("never reads the old key again after the move", async () => {
    setPref(PREFS.dayNoteParent, "Journal");
    const hook = renderHook(() => dayNoteParentPref.useKeepInSync());
    await waitFor(() => expect(getPref(PREFS.dayNoteParent)).toBeNull());
    hook.unmount();
    setPref(PREFS.dayNoteParent, "Again");
    await dayNoteParentStore.sync();
    expect(dayNoteParentSetting.get()).toBe("Journal");
  });
});

describe("openToday", () => {
  it("starts today's note under the saved parent", async () => {
    let state = { ...noWorkspaceData, nodes: [{ id: "Journal", title: "Journal", slug: "Journal", markdown: "", source_type: "manual", node_type: "content", space_id: SPACE }] } as typeof noWorkspaceData;
    const ctx: DataCtx = {
      get data() { return state; }, online: true,
      setData: (u) => { state = typeof u === "function" ? u(state) : u; },
      addToast: vi.fn(), scheduleUserFolderSync: vi.fn(), refresh: vi.fn(async () => {}),
    };
    dayNoteParentSetting.set("Journal");
    await makeDayNotes(ctx).openToday();
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ parent_id: "Journal" }));
  });
});
