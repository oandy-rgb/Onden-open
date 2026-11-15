// A move or delete is drawn before the server answers. When the server refuses it (or answers with another place)
// the device must show what the server has: no sync delta comes later for a row whose server value never changed.
// Fake server (the api seam) and a fake local copy; no database needed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn(), queue: [] as Array<Record<string, unknown>> }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: mocks.api }));
vi.mock("../lib/localDb", () => ({
  upsertNode: vi.fn(), removeNode: vi.fn(async () => {}), upsertAttribute: vi.fn(), persistRemoteNode: vi.fn(async (row: unknown) => row),
  catchUpWithOtherTabs: vi.fn(async () => {}),
  addPendingWrite: vi.fn(async (method: string, path: string, body: string | null, idem_key: string) => {
    mocks.queue.push({ id: mocks.queue.length + 1, method, path, body, idem_key, attempts: 0, targets: [{ kind: "node", id: /nodes\/([^/]+)/.exec(path)![1] }] });
  }),
  getPendingWrites: vi.fn(async () => [...mocks.queue]),
  clearPendingWrite: vi.fn(async (id: number) => { mocks.queue = mocks.queue.filter((w) => w.id !== id); }),
  bumpPendingWriteAttempt: vi.fn(async () => 1),
  storeRejectedWrite: vi.fn(async (request, rejection) => ({ ...request, id: 301, attempts: 0, rejection })),
}));

import { ApiError, type ContentNode } from "../lib/api";
import { getAppState, resetAppState, setData } from "../lib/appStore";
import { makeNoteWriter } from "../lib/data/noteWriter";
import { flushPendingWrites } from "../lib/data/writeQueue";
import type { DataCtx } from "../lib/data/types";
import { setLocalePref } from "../lib/i18n";
import { ownerData } from "./ownerData";

const row = (id: string, parent_id: string | null = null): ContentNode => ({ id, title: id, markdown: "", slug: id, source_type: "manual", node_type: "content", parent_id });
const server = new Map<string, ContentNode>();

function harness(online: boolean) {
  const addToast = vi.fn();
  const ctx: DataCtx = { get data() { return getAppState().data; }, online, setData, addToast, scheduleUserFolderSync: vi.fn(), refresh: vi.fn(async () => {}) };
  return { writer: makeNoteWriter(ctx), addToast };
}
const shown = (id: string) => getAppState().data.nodes.find((n) => n.id === id);

beforeEach(() => {
  mocks.api.mockReset();
  mocks.queue = [];
  server.clear();
  setLocalePref("en");
  resetAppState({ data: { ...ownerData, nodes: [row("a"), row("b")] } });
  server.set("a", row("a")); server.set("b", row("b"));
  // The fake server: a read answers with its row or 404; moves and deletes are answered by the cases.
  mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
    const id = /nodes\/([^/?]+)/.exec(path)![1]!;
    if (!init?.method || init.method === "GET") {
      const found = server.get(id);
      if (!found) throw new ApiError(404, "not_found");
      return found;
    }
    throw new Error(`unscripted ${init.method} ${path}`);
  });
});

describe("a refused structural write leaves nothing of itself on the device", () => {
  it("a queued move the server refuses on replay goes back to where the server has the note", async () => {
    const { writer } = harness(false);
    await writer.patch("a", { parent_id: "b" });
    expect(shown("a")?.parent_id).toBe("b");
    expect(mocks.queue).toHaveLength(1);
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") throw new ApiError(400, "parent_cycle");
      return server.get(/nodes\/([^/?]+)/.exec(path)![1]!)!;
    });
    await flushPendingWrites();
    expect(mocks.queue).toHaveLength(0);
    expect(shown("a")?.parent_id).toBeNull();
  });

  it("a move the server refuses while online goes back to where the server has the note", async () => {
    const { writer } = harness(true);
    server.set("a", row("a", "elsewhere"));
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") throw new ApiError(400, "parent_cycle");
      return server.get(/nodes\/([^/?]+)/.exec(path)![1]!)!;
    });
    await expect(writer.patch("a", { parent_id: "b" })).rejects.toMatchObject({ status: 400 });
    expect(shown("a")?.parent_id).toBe("elsewhere");
  });

  it("a delete refused because the server already deleted the note keeps it off the screen", async () => {
    const { writer } = harness(true);
    server.delete("a");
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") throw new ApiError(404, "not_found");
      throw new ApiError(404, "not_found");
    });
    await expect(writer.remove("a")).rejects.toMatchObject({ status: 404 });
    expect(shown("a")).toBeUndefined();
  });

  it("a delete refused for a note the server still has puts it back", async () => {
    const { writer } = harness(true);
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") throw new ApiError(403, "forbidden");
      return server.get(/nodes\/([^/?]+)/.exec(path)![1]!)!;
    });
    await expect(writer.remove("a")).rejects.toMatchObject({ status: 403 });
    expect(shown("a")).toBeDefined();
  });

  it("a replayed move the server answers as 'top level' shows the answer", async () => {
    const { writer } = harness(false);
    await writer.patch("a", { parent_id: "b" });
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return { ...row("a"), parent_id: null, noop: true };
      return server.get(/nodes\/([^/?]+)/.exec(path)![1]!)!;
    });
    await flushPendingWrites();
    expect(shown("a")?.parent_id).toBeNull();
  });

  it("a note cannot be moved under itself: nothing is drawn or sent", async () => {
    const { writer, addToast } = harness(false);
    await expect(writer.patch("a", { parent_id: "a" })).rejects.toThrow();
    expect(shown("a")?.parent_id).toBeNull();
    expect(mocks.queue).toHaveLength(0);
    expect(mocks.api).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith("A note can't go under one of its own sub-notes.", "error");
  });

  it("keeps the drawn move while the server cannot be asked (offline), as before", async () => {
    const { writer } = harness(true);
    mocks.api.mockImplementation(async (_path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") throw new ApiError(400, "parent_cycle");
      throw new TypeError("offline");
    });
    await expect(writer.patch("a", { parent_id: "b" })).rejects.toMatchObject({ status: 400 });
    expect(shown("a")?.parent_id).toBeNull(); // rolled back to what it remembered
  });
});
