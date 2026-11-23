// Two storage steps of the sync engine whose failure used to be swallowed (lib/data/storageSteps.ts; docs/agents/
// mistakes.md「儲存失敗被吞掉」):
//   - the copy in the person's folder: a failed write is said in Settings, never "saved to this folder", until a write
//     succeeds again;
//   - a refused answer's cursor rewind: when it fails, the rows that answer carried still reach the screen (the next
//     pass reads the whole state).
// lib/api and lib/localDb are fake. The folder itself is a fake browser directory handle (its write fails the way a
// full disk or a moved folder does); only the two lookups that need IndexedDB and a permission prompt are stubbed.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";

const copy = vi.hoisted(() => ({ cursor: 100, rewind: vi.fn(async (_to: string) => {}), onApply: (() => {}) as () => void }));

vi.mock("../lib/localDb", () => ({
  getWatermark: vi.fn(async () => ({ position: null, server: null, rebuildOwed: false })),
  raiseWatermark: vi.fn(async () => {}),
  rewindCursor: (to: string) => copy.rewind(to),
  forgetCopyWatermark: vi.fn(async () => ({ alreadyOwed: false })),
  initLocalDb: vi.fn(async () => null),
  useMemoryOnlyLocalCopy: vi.fn(),
  loadBootstrapList: vi.fn(async () => null),
  loadBootstrapRelations: vi.fn(async () => ({ edges: [], pointers: [], tasks: [], suggestions: [], graph_positions: [] })),
  loadAttributePage: vi.fn(async () => ({ rows: [], next: null })),
  persistBootstrap: vi.fn(async (data: { last_event_id: string }) => { copy.cursor = Number(data.last_event_id); return data; }),
  persistRemoteNode: vi.fn(async (node: unknown) => node),
  getStoredBody: vi.fn(async () => null),
  applySync: vi.fn(async (delta: { last_event_id: number }) => { copy.cursor = delta.last_event_id; copy.onApply(); return delta; }),
  getLastEventId: vi.fn(async () => copy.cursor),
  setLastEventId: vi.fn(async (id: number | string) => { copy.cursor = Number(id); }),
  getAllMembershipIds: vi.fn(async () => [] as string[]),
  getMembershipEpoch: vi.fn(async () => 0),
  setMembershipEpoch: vi.fn(async () => {}),
  getPendingWrites: vi.fn(async () => []),
  getLastFullRefresh: vi.fn(async () => Date.now()),
  clearPendingWrite: vi.fn(async () => {}),
  exportDatabase: vi.fn(async () => new File(["db"], "onden.sqlite3")),
  importDatabase: vi.fn(async () => {}),
  installUnloadFlush: vi.fn(() => () => {}),
  flushLocalDbSync: vi.fn(async () => {}),
  loadCanvases: vi.fn(async () => []),
  upsertCanvas: vi.fn(async () => {}),
  removeCanvas: vi.fn(async () => {}),
  loadCanvas: vi.fn(async () => null),
  planDrawings: vi.fn(async () => ({ missing: [], stale: [] })),
  takeInLeftWrites: vi.fn(async () => {}),
  catchUpWithOtherTabs: vi.fn(async () => {}),
  missingBodyIds: vi.fn(async () => []),
}));

const folder = vi.hoisted(() => ({ handle: null as unknown, granted: true }));
vi.mock("../lib/fileSystemStorage", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/fileSystemStorage")>();
  return { ...real, getStoredDirHandle: vi.fn(async () => folder.handle), requestDirPermission: vi.fn(async () => folder.granted) };
});

const apiMock = vi.fn();
vi.mock("../lib/api", async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, api: (...a: unknown[]) => apiMock(...a) };
});

import { dataSync } from "../lib/data";
import { scheduleUserFolderSync, __resetSyncEngineForTests } from "../lib/data/syncEngine";
import { forgetWatermark, startWatermarkFrom, syncPassEnded } from "../lib/data/writePositions";
import { settleStorageStep } from "../lib/data/storageSteps";
import { SETTINGS } from "../settings/registry";
import type { SettingContext } from "../lib/settingsTypes";
import { getAppState, resetAppState } from "../lib/appStore";
import { bindAccountStorage } from "../lib/accountStorage";
import { setStoragePref } from "../lib/fileSystemStorage";
import { _resetLocalCopyForTests } from "../lib/localCopyState";
import type { Bootstrap, ContentNode } from "../lib/api";

const node = (id: string): ContentNode => ({ id, title: id, markdown: "x", source_type: "manual", node_type: "content", slug: id });
const remote = (nodes: ContentNode[], last: string): Bootstrap => ({
  workspace: { id: "w", name: "Test", slug: "test", home_node_id: null }, actor_role: "editor",
  nodes, edges: [], tasks: [], suggestions: [], events: [], last_event_id: last,
});
const delta = (last: number, nodes: ContentNode[] = []) => ({
  last_event_id: last, head_event_id: String(last),
  nodes: { upsert: nodes, delete: [] }, edges: { upsert: [], delete: [] },
  tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null,
});

/** A browser directory handle whose file writes fail with `failure` (null: they succeed). */
function folderHandle(failure: () => DOMException | null) {
  const written: string[] = [];
  return {
    written, name: "Onden copy",
    getFileHandle: async () => ({
      createWritable: async () => ({
        write: async (data: File) => { const error = failure(); if (error) throw error; written.push(await data.text()); },
        close: async () => {}, abort: async () => {},
      }),
      getFile: async () => { throw new DOMException("not there", "NotFoundError"); },
    }),
  };
}

/** Settings › "Where your notes are kept": where the folder's copy is already described (offline, the line says the copy is saved there). */
function FolderStatus() {
  const row = SETTINGS.find((setting) => setting.id === "data.location")!;
  const Widget = (row as { component: (props: { ctx: SettingContext }) => ReactElement }).component;
  return <Widget ctx={{ online: false, onClose() {}, onImportDone() {}, onConnect() {} }} />;
}
const SAVED_THERE = /A local database copy is saved to this folder/;
const NOT_UPDATED = /The copy in this folder couldn't be updated/;
const folderSaysCurrent = () => { expect(screen.queryByText(SAVED_THERE)).not.toBeNull(); expect(screen.queryByText(NOT_UPDATED)).toBeNull(); };
const folderSaysBehind = () => { expect(screen.queryByText(NOT_UPDATED)).not.toBeNull(); expect(screen.queryByText(SAVED_THERE)).toBeNull(); };

beforeEach(async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  bindAccountStorage("u-steps", "");
  await __resetSyncEngineForTests();
  forgetWatermark();
  syncPassEnded();
  resetAppState();
  _resetLocalCopyForTests();
  settleStorageStep("folderCopy"); // each test is another page: nothing owed yet
  settleStorageStep("copyCursor");
  apiMock.mockReset();
  copy.cursor = 100;
  copy.rewind.mockReset().mockImplementation(async () => {});
  copy.onApply = () => {};
  folder.granted = true;
  folder.handle = null;
});
afterEach(() => { vi.useRealTimers(); vi.mocked(console.warn).mockRestore(); });

describe("the copy in the person's folder", () => {
  async function bootWithFolder(handle: unknown) {
    setStoragePref("fs-access");
    folder.handle = handle;
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/bootstrap")) return remote([node("n1")], "100");
      if (path === "/api/sync") return delta(100);
      if (path.startsWith("/api/sync/drawings")) return { drawings: [] };
      if (path.startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
    await dataSync.boot();
  }

  it("a failed write is said, and stays said until a write succeeds", async () => {
    let failure: DOMException | null = new DOMException("The disk is full", "QuotaExceededError");
    const handle = folderHandle(() => failure);
    await bootWithFolder(handle);
    await act(async () => { render(<FolderStatus />); });
    folderSaysCurrent();

    vi.useFakeTimers();
    scheduleUserFolderSync();
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    folderSaysBehind();

    // Still failing: still said.
    scheduleUserFolderSync();
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    folderSaysBehind();

    failure = null;
    scheduleUserFolderSync();
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(handle.written).toEqual(["db"]);
    folderSaysCurrent();
  });

  it("a folder whose permission was taken back is said at boot", async () => {
    folder.granted = false;
    await bootWithFolder(folderHandle(() => null));
    await act(async () => { render(<FolderStatus />); });
    folderSaysBehind();
  });
});

describe("a refused answer whose cursor rewind fails", () => {
  it("the rows it carried still reach the screen on the next pass", async () => {
    resetAppState({ data: { ...remote([], "100") } as Bootstrap });
    let served = 0;
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/sync") {
        const since = Number(JSON.parse(String(init?.body)).since);
        served++;
        if (served === 1) return delta(110, [node("missed")]); // taken by the copy, refused by the page (below)
        if (served === 2) throw new TypeError("Failed to fetch"); // the ask-again is lost: the pass ends
        return since >= 110 ? delta(120) : delta(120, [node("missed")]);
      }
      if (path.startsWith("/api/bootstrap")) return remote([node("missed")], "120");
      if (path.startsWith("/api/canvases")) return [];
      throw new Error("unexpected " + path);
    });
    // A write acknowledged at 115 arrives while the copy applies the first answer: the page refuses it, and the copy's
    // cursor must go back to 100. The local copy cannot (it is restarting).
    copy.onApply = () => { copy.onApply = () => {}; startWatermarkFrom({ position: "115" }); };
    copy.rewind.mockRejectedValue(new Error("the local copy is restarting"));

    expect(await dataSync.sync()).toMatchObject({ ok: false });
    expect(getAppState().data.nodes.map((n) => n.id)).toEqual([]);

    expect(await dataSync.sync()).toMatchObject({ ok: true });
    expect(getAppState().data.nodes.map((n) => n.id)).toEqual(["missed"]);
  });
});
