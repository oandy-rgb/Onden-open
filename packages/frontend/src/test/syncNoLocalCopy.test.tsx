// A device with no local copy (IndexedDB blocked) runs from server data alone. Unlike syncLiveness.test.tsx, the REAL
// lib/localDb is used here (state `none` makes every operation reject with local_copy_unavailable), so a sync step that
// forgets "nothing to persist" shows up as a note that never lands.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/fileSystemStorage", () => ({
  getStoragePref: vi.fn(() => "opfs"),
  getStoredDirHandle: vi.fn(async () => null),
  requestDirPermission: vi.fn(async () => false),
  readDbFromDir: vi.fn(async () => null),
  writeDbToDir: vi.fn(async () => {}),
}));
vi.mock("../lib/data/syncStatus", () => ({ refreshPendingCount: vi.fn() }));
const apiMock = vi.fn();
vi.mock("../lib/api", async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, api: (...a: unknown[]) => apiMock(...a) };
});

import { dataSync } from "../lib/data";
import { getAppState, resetAppState } from "../lib/appStore";
import { _resetLocalCopyForTests, setLocalCopy, getLocalCopyState } from "../lib/localCopyState";
import { _resetLocalDbForTests } from "../lib/localDb";
import { bindAccountStorage } from "../lib/accountStorage";
import type { Bootstrap, ContentNode } from "../lib/api";

const slimNote: ContentNode = { id: "n1", title: "a note", markdown: "", body_len: 5, source_type: "manual", node_type: "content", slug: "n1" };
const fullNote: ContentNode = { ...slimNote, markdown: "hello" };
const remote = (): Bootstrap => ({
  workspace: { id: "w", name: "Test", slug: "test", home_node_id: null }, actor_role: "editor",
  nodes: [slimNote], edges: [], tasks: [], suggestions: [], events: [], last_event_id: "120",
});

beforeEach(() => {
  bindAccountStorage("u", "");
  resetAppState();
  _resetLocalCopyForTests();
  _resetLocalDbForTests();
  setLocalCopy("none");
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/bootstrap")) return remote();
    if (path === "/api/nodes/n1") return fullNote;
    if (path.startsWith("/api/canvases")) return [];
    throw new Error("unexpected " + path);
  });
});

describe("no local copy, real localDb", () => {
  it("a whole bootstrap lands in memory", async () => {
    expect(await dataSync.sync()).toEqual({ ok: true });
    expect(getAppState().data.nodes.map((n) => n.id)).toEqual(["n1"]);
  });

  it("opening a note brings its body from the server", async () => {
    await dataSync.sync();
    await dataSync.hydrateNode("n1");
    expect(getAppState().data.nodes.find((n) => n.id === "n1")?.markdown).toBe("hello");
    expect(getLocalCopyState()).toBe("none");
  });

  it("boot (the copy cannot be opened) shows the server's notes and goes online", async () => {
    _resetLocalCopyForTests(); // boot itself finds out: no worker here, so initLocalDb fails and it gives up on the copy
    await dataSync.boot();
    expect(getLocalCopyState()).toBe("none");
    expect(getAppState().data.nodes.map((n) => n.id)).toEqual(["n1"]);
    expect(getAppState().online).toBe(true);
  });
});
