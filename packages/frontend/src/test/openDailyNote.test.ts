import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// openDailyNote must start today's note through the note writer (the offline
// write-through queue, via lib/data/dayNotes.ts) so it works without a server
// and replays on reconnect — NOT via a raw fetch that silently fails offline
// (bug new-note-offline-fail).
const submit = vi.fn();
vi.mock("../lib/data/writeQueue", async (original) => ({
  ...await original<typeof import("../lib/data/writeQueue")>(),
  submitWrite: async (r: { method: string; path: string; body: string | null }) => {
    const value = await submit(r.method, r.path, r.body);
    return value === undefined ? { status: "queued" } : { status: "synced", value };
  },
}));
vi.mock("../lib/localDb", async (original) => ({
  ...await original<typeof import("../lib/localDb")>(),
  upsertNode: async () => {}, removeNode: async () => {},
}));

import { useNodeCreation } from "../hooks/useNodeCreation";
import { ApiError, type Bootstrap, type ContentNode } from "../lib/api";
import { getAppState, resetAppState, setData } from "../lib/appStore";
import { todayId } from "../lib/localDate";
import { knowPersonalSpace } from "./helpers/knownSpaces";

function makeParams() {
  return {
    data: getAppState().data as Bootstrap,
    createNodeRaw: vi.fn(),
    refresh: vi.fn(),
    draftTitle: "",
    setCreateOpen: vi.fn(),
    activeCanvas: null,
    addToActiveCanvas: vi.fn(),
    setSelectedId: vi.fn(),
    setMode: vi.fn(), openNote: vi.fn(), openNewTag: vi.fn(),
  };
}

describe("openDailyNote", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    resetAppState();
    await knowPersonalSpace();
    submit.mockReset().mockResolvedValue(undefined);
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts today's note through the note writer (offline-aware), not a raw fetch", async () => {
    const params = makeParams();
    const { openDailyNote } = useNodeCreation(params);

    const id = await openDailyNote();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(1);
    const [method, path, body] = submit.mock.calls[0]!;
    expect([method, path]).toEqual(["POST", "/api/nodes"]);
    expect(JSON.parse(body as string)).toMatchObject({ id, title: todayId(new Date()), markdown: "" });
    expect(getAppState().data.nodes.map((n) => n.id)).toEqual([id]);
    expect(params.setSelectedId).toHaveBeenCalledWith(id);
    expect(params.setMode).toHaveBeenCalledWith("notes");
  });

  it("opens an existing day node instead of creating a new one", async () => {
    const dateStr = todayId(new Date());
    setData((s) => ({ ...s, nodes: [{ id: "today", title: dateStr, slug: dateStr } as ContentNode] }));
    const params = makeParams();
    const { openDailyNote } = useNodeCreation(params);

    await openDailyNote();

    expect(submit).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(params.setSelectedId).toHaveBeenCalledWith("today");
    expect(params.setMode).toHaveBeenCalledWith("notes");
  });

  it("does not select/navigate when creation fails (returns null)", async () => {
    submit.mockRejectedValueOnce(new ApiError(403, "forbidden"));
    const params = makeParams();
    const { openDailyNote } = useNodeCreation(params);

    expect(await openDailyNote()).toBeNull();

    expect(params.setSelectedId).not.toHaveBeenCalled();
    expect(params.setMode).not.toHaveBeenCalled();
    expect(getAppState().data.nodes).toHaveLength(0);
  });
});
