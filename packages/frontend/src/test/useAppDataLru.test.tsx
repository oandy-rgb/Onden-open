// ④ hydrated-body LRU: a slim session caps in-memory full bodies at
// HYDRATED_BODY_CAP; eviction returns rows to their slim shape (markdown ""
// with body_len kept → nodeNeedsBody stays true, re-open re-hydrates).
// Full-bootstrap sessions are NEVER evicted — emptying a full-mode row would
// read as the real body (the wipe hazard).
import { evenOrderKey } from "@onden/markdown/contract";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

vi.mock("../lib/localDb", () => ({
  initLocalDb: vi.fn(async () => null),
  loadBootstrapList: vi.fn(async () => null),
  loadBootstrapRelations: vi.fn(async () => ({ edges: [], pointers: [], tasks: [], suggestions: [], graph_positions: [] })),
  loadAttributePage: vi.fn(async () => ({ rows: [], next: null })),
  persistBootstrap: vi.fn(async (data) => data),
  persistRemoteNode: vi.fn(async (node) => node),
  getStoredBody: vi.fn(async () => null),
  applySync: vi.fn(async (delta) => delta),
  getLastEventId: vi.fn(async () => 0),
  getMembershipEpoch: vi.fn(async () => 0),
  setLastEventId: vi.fn(async () => {}),
  getPendingWrites: vi.fn(async () => []),
  clearPendingWrite: vi.fn(async () => {}),
  exportDatabase: vi.fn(),
  importDatabase: vi.fn(),
  installUnloadFlush: vi.fn(() => () => {}),
  flushLocalDbSync: vi.fn(async () => {}),
  loadCanvases: vi.fn(async () => []),
  upsertCanvas: vi.fn(async () => {}),
  removeCanvas: vi.fn(async () => {}),
  loadCanvas: vi.fn(async () => null),
}));
vi.mock("../lib/fileSystemStorage", () => ({
  getStoragePref: () => "opfs",
  getStoredDirHandle: vi.fn(async () => null),
  requestDirPermission: vi.fn(async () => false),
  readDbFromDir: vi.fn(async () => null),
  writeDbToDir: vi.fn(async () => {}),
}));
vi.mock("../lib/data/syncStatus", () => ({ refreshPendingCount: vi.fn(), bumpPending: vi.fn() }));

const apiMock = vi.fn();
vi.mock("../lib/api", async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, api: (...a: unknown[]) => apiMock(...a) };
});

import { useAppData } from "../lib/useAppData";
import { dataSync } from "../lib/data";

const { HYDRATED_BODY_CAP } = dataSync;
import { nodeNeedsBody } from "../lib/api";
import { resetDraftForNode, __resetDraftStateForTests } from "../lib/data/draftActions";

const N = HYDRATED_BODY_CAP + 2;
const slimNode = (i: number) => ({
  id: `n${i}`, title: `Note ${i}`, slug: `n-${i}`, markdown: "",
  body_len: 50, node_type: "content", source_type: "manual",
  parent_id: null, hidden: false, order_key: evenOrderKey(i),
});
const slimBoot = {
  bodies: "none",
  workspace: { id: "ws", name: "T", slug: "default", home_node_id: null },
  nodes: Array.from({ length: N }, (_, i) => slimNode(i)),
  edges: [], tasks: [], suggestions: [], events: [], actor_role: "admin",
  tags: [],
};

beforeEach(() => { apiMock.mockReset(); });

function mockApi(opts: { fullBootstrapFails: boolean }) {
  apiMock.mockImplementation(async (path: string) => {
    const p = String(path);
    if (p.startsWith("/api/bootstrap?bodies=none")) return structuredClone(slimBoot);
    if (p.startsWith("/api/bootstrap")) {
      if (opts.fullBootstrapFails) throw new Error("full blocked for test");
      return { ...structuredClone(slimBoot), bodies: "full", nodes: slimBoot.nodes.map((n) => ({ ...n, markdown: `full body ${n.id}` })) };
    }
    if (p.startsWith("/api/canvases")) return [];
    if (p.startsWith("/api/sync")) return { last_event_id: 0, nodes: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null };
    const m = p.match(/^\/api\/nodes\/(n\d+)$/);
    if (m) return { ...slimNode(Number(m[1].slice(1))), markdown: `hydrated ${m[1]}` };
    throw new Error("unexpected " + p);
  });
}

describe("hydrated-body LRU (④)", () => {
  it("slim session: oldest hydrated body evicts past the cap, needsBody survives", async () => {
    mockApi({ fullBootstrapFails: true });
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.data.nodes.length).toBe(N));

    await act(async () => {
      for (let i = 0; i < HYDRATED_BODY_CAP + 1; i++) await result.current.hydrateNode(`n${i}`);
    });

    const nodes = result.current.data.nodes;
    const first = nodes.find((n) => n.id === "n0")!;
    expect(first.markdown).toBe("");                 // evicted back to slim
    expect(nodeNeedsBody(first)).toBe(true);         // re-open re-hydrates
    const last = nodes.find((n) => n.id === `n${HYDRATED_BODY_CAP}`)!;
    expect(last.markdown).toBe(`hydrated n${HYDRATED_BODY_CAP}`); // newest kept
  }, 30_000);

  it("slim session: the note open in the editor is never evicted, however many others are hydrated", async () => {
    mockApi({ fullBootstrapFails: true });
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.data.nodes.length).toBe(N));

    await act(async () => { await result.current.hydrateNode("n0"); });
    act(() => { resetDraftForNode(result.current.data.nodes.find((n) => n.id === "n0")!); });
    await act(async () => {
      for (let i = 1; i < HYDRATED_BODY_CAP + 2; i++) await result.current.hydrateNode(`n${i}`);
    });

    const open = result.current.data.nodes.find((n) => n.id === "n0")!;
    expect(open.markdown).toBe("hydrated n0");
    expect(nodeNeedsBody(open)).toBe(false);
    __resetDraftStateForTests();
  }, 30_000);

  it("full-bootstrap session: hydration never evicts (wipe hazard guard)", async () => {
    mockApi({ fullBootstrapFails: false });
    const { result } = renderHook(() => useAppData());
    await waitFor(() => expect(result.current.data.bodies).toBe("full"));

    await act(async () => {
      for (let i = 0; i < HYDRATED_BODY_CAP + 1; i++) await result.current.hydrateNode(`n${i}`);
    });
    const emptied = result.current.data.nodes.filter((n) => n.markdown === "");
    expect(emptied).toEqual([]); // every body intact
  }, 30_000);
});
