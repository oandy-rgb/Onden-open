// Offline copy for large workspaces, main-thread side: opening a note whose
// body is not in memory reads the server, or — when the server cannot be
// reached — the body this device downloaded. A refusal never falls back. The
// background download fetches missing bodies in batches while online.
import { beforeEach, describe, expect, it, vi } from "vitest";

const local = vi.hoisted(() => ({
  stored: new Map<string, string>(),
  missing: [] as string[][],
  saved: [] as Array<Array<{ id: string; markdown: string }>>,
}));
vi.mock("../lib/localDb", () => ({
  persistRemoteNode: vi.fn(async (node) => node),
  getStoredBody: vi.fn(async (id: string) => local.stored.get(id) ?? null),
  missingBodyIds: vi.fn(async () => {
    const ids = local.missing.shift() ?? [];
    return { ids, next: local.missing.length ? "more" : null };
  }),
  storeDownloadedBodies: vi.fn(async (rows) => { local.saved.push(rows); return rows.length; }),
  forgetBody: vi.fn(async (id: string) => local.stored.delete(id)),
  getPendingWrites: vi.fn(async () => []),
}));
const apiMock = vi.fn();
vi.mock("../lib/api", async (orig) => ({ ...(await orig<typeof import("../lib/api")>()), api: (...a: unknown[]) => apiMock(...a) }));

import { dataSync } from "../lib/data";
import { ApiError, noWorkspaceData } from "../lib/api";
import { getAppState, resetAppState, setData } from "../lib/appStore";
import { optimisticFields } from "../lib/data/optimisticFields";

const { hydrateNode, downloadBodiesForOffline } = dataSync;

const slim = { id: "a", title: "A", slug: "a", markdown: "", body_len: 4, source_type: "manual", node_type: "content" } as const;
const row = () => getAppState().data.nodes.find((n) => n.id === "a")!;

beforeEach(() => {
  local.stored.clear(); local.missing = []; local.saved = [];
  apiMock.mockReset();
  resetAppState({ data: { ...noWorkspaceData, bodies: "none", nodes: [{ ...slim }] }, online: true });
});

describe("opening a note whose body is not in memory", () => {
  it("offline: opens the downloaded body", async () => {
    apiMock.mockRejectedValue(new TypeError("Failed to fetch"));
    local.stored.set("a", "body");
    await hydrateNode("a");
    expect(row().markdown).toBe("body");
  });

  it("offline without a downloaded body: stays not-loaded", async () => {
    apiMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await hydrateNode("a");
    expect(row()).toMatchObject({ markdown: "", body_len: 4 });
  });

  it("a refusal never falls back to the local copy", async () => {
    apiMock.mockRejectedValue(new ApiError(403, "{}"));
    local.stored.set("a", "body");
    await hydrateNode("a");
    expect(row().markdown).toBe("");
  });
});

describe("local first, then the server", () => {
  it("shows the stored body before the server answers, then adopts a newer server body", async () => {
    local.stored.set("a", "stored");
    let answer!: (row: unknown) => void;
    apiMock.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const opening = hydrateNode("a");
    await vi.waitFor(() => expect(row().markdown).toBe("stored"));
    answer({ ...slim, markdown: "newer from server" });
    await opening;
    expect(row()).toMatchObject({ markdown: "newer from server", body_len: 17 });
  });

  it("a save made while the server read was in flight is not overwritten", async () => {
    local.stored.set("a", "stored");
    let answer!: (row: unknown) => void;
    apiMock.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const opening = hydrateNode("a");
    await vi.waitFor(() => expect(row().markdown).toBe("stored"));
    setData((prev) => ({ ...prev, nodes: prev.nodes.map((n) => n.id === "a" ? { ...n, markdown: "my edit" } : n) }));
    answer({ ...slim, markdown: "read before the save" });
    await opening;
    expect(row().markdown).toBe("my edit");
  });

  it("a 404 takes back a stored body that was shown", async () => {
    local.stored.set("a", "stored");
    apiMock.mockRejectedValue(new ApiError(404, "{}"));
    await hydrateNode("a");
    expect(row()).toMatchObject({ markdown: "" });
    expect(row().body_len).toBeGreaterThan(0);
    // …and off this device, so going offline does not bring it back.
    await vi.waitFor(() => expect(local.stored.has("a")).toBe(false));
  });

  it("a 401 is the session, not the note: the stored body stays", async () => {
    local.stored.set("a", "stored");
    apiMock.mockRejectedValue(new ApiError(401, "{}"));
    await hydrateNode("a");
    expect(row().markdown).toBe("stored");
    expect(local.stored.get("a")).toBe("stored");
  });
});

describe("background download for offline use", () => {
  it("fetches missing bodies in batches and stores them locally", async () => {
    const [A, B, C] = ["a", "b", "c"].map((c) => `00000000-0000-4000-8000-00000000000${c}`);
    local.missing = [[A, B], [C]];
    apiMock.mockImplementation(async (_path: string, init: RequestInit) => ({
      bodies: (JSON.parse(String(init.body)).ids as string[]).map((id) => ({ id, markdown: `body ${id}` })),
    }));
    await downloadBodiesForOffline();
    expect(apiMock.mock.calls.map(([path]) => path)).toEqual(["/api/sync/bodies", "/api/sync/bodies"]);
    expect(local.saved.flat().map((r) => r.id)).toEqual([A, B, C]);
    expect(row().markdown).toBe(""); // the in-memory store stays slim
  });
  it("leaves a non-UUID (legacy local) id out of the request instead of stalling on the server's 400", async () => {
    const A = "00000000-0000-4000-8000-00000000000a";
    local.missing = [["legacy-id", A]];
    apiMock.mockImplementation(async (_path: string, init: RequestInit) => ({
      bodies: (JSON.parse(String(init.body)).ids as string[]).map((id) => ({ id, markdown: `body ${id}` })),
    }));
    await downloadBodiesForOffline();
    expect(apiMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)).ids)).toEqual([[A]]);
  });


  it("does nothing offline", async () => {
    resetAppState({ data: { ...noWorkspaceData, nodes: [] }, online: false });
    local.missing = [["a"]];
    await downloadBodiesForOffline();
    expect(apiMock).not.toHaveBeenCalled();
  });
});

// Owner report 2026-11-19: a server copy must not bring back a text from before this device's own save
// (storeOps.serverCopyOver, the same rule a sync answer goes through).
describe("a read that crosses this device's own save", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 19, 0, 0, s)).toISOString();
  const full = (markdown: string, updated_at: string) => ({ ...slim, markdown, body_len: undefined, updated_at });
  /** A save of "AB" on its way, the way noteWriter.change starts one: the optimistic row and its journal entry. */
  function saveOnItsWay() {
    const before = row();
    const settle = optimisticFields("node:a", before, { markdown: "AB" });
    setData((prev) => ({ ...prev, nodes: prev.nodes.map((n) => n.id === "a" ? { ...n, markdown: "AB" } : n) }));
    /** The save's answer, the way noteWriter.commit takes it: the field settles, the row gets the server's time. */
    return (updated_at: string) => {
      settle(true, { markdown: "AB" });
      setData((prev) => ({ ...prev, nodes: prev.nodes.map((n) => n.id === "a" ? { ...n, markdown: "AB", updated_at } : n) }));
    };
  }
  beforeEach(() => {
    resetAppState({ data: { ...noWorkspaceData, bodies: "full", nodes: [full("A", at(1)) as never] }, online: true });
  });

  it("read before the save reached the server, answered while it is on its way: the save's text stays", async () => {
    const answered = saveOnItsWay();
    apiMock.mockResolvedValueOnce(full("A", at(1)));
    await hydrateNode("a");
    expect(row().markdown).toBe("AB");
    apiMock.mockResolvedValue(full("AB", at(2)));
    answered(at(2));
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    expect(row()).toMatchObject({ markdown: "AB", updated_at: at(2) });
  });

  it("read before the save reached the server, answered after the save's answer: older, not taken", async () => {
    const answered = saveOnItsWay();
    let answer!: (row: unknown) => void;
    apiMock.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const reading = hydrateNode("a");
    answered(at(2));
    answer(full("A", at(1)));
    await reading;
    expect(row()).toMatchObject({ markdown: "AB", updated_at: at(2) });
  });

  it("another writer's newer text in a read kept under the save still arrives: the note is read again", async () => {
    const answered = saveOnItsWay();
    apiMock.mockResolvedValueOnce(full("C\nAB", at(3)));
    await hydrateNode("a");
    expect(row().markdown).toBe("AB");
    apiMock.mockResolvedValue(full("C\nAB", at(3)));
    answered(at(2));
    await vi.waitFor(() => expect(row()).toMatchObject({ markdown: "C\nAB", updated_at: at(3) }));
  });
});
