import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ previewMove: vi.fn(), move: vi.fn(), refresh: vi.fn(async () => {}) }));
vi.mock("../lib/spaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/spaces")>()),
  spaceApi: { previewMove: api.previewMove, move: api.move },
  refreshSpaces: api.refresh,
  loadedSpaces: () => [{ id: "s2", name: "Team", kind: "shared", is_default: false }],
}));
import { moveToSpace } from "../lib/moveToSpace";
import { getAppState, resetAppState } from "../lib/appStore";
import type { MovePreviewNumericEpoch } from "../lib/spaces";

const preview = (id: string, epoch: number): MovePreviewNumericEpoch => ({
  node_id: id, from: { id: "s1", name: "Me", kind: "personal" }, to: { id: "s2", name: "Team", kind: "shared" },
  notes: 1, gain: [], lose: [], membership_epoch: epoch,
});
const toasts = () => getAppState().toasts.map((toast) => toast.message);

beforeEach(() => { vi.clearAllMocks(); resetAppState(); });

describe("moveToSpace", () => {
  it("moves one note on the preview the person confirmed, refreshes the spaces and says so", async () => {
    api.move.mockResolvedValue({ moved: 1 });
    const outcome = await moveToSpace("n1", "s2", preview("n1", 7));
    expect(api.previewMove).not.toHaveBeenCalled();
    expect(api.move).toHaveBeenCalledExactlyOnceWith("n1", "s2", 7);
    expect(api.refresh).toHaveBeenCalledOnce();
    expect(outcome).toEqual({ moved: 1 });
    expect(toasts()).toEqual(["Moved to Team"]);
  });

  it("previews each note of a batch right before it moves, and counts them", async () => {
    api.previewMove.mockImplementation(async (id: string) => preview(id, id === "a" ? 1 : 2));
    api.move.mockResolvedValue({ moved: 1 });
    expect(await moveToSpace(["a", "b"], "s2")).toEqual({ moved: 2 });
    expect(api.move.mock.calls).toEqual([["a", "s2", 1], ["b", "s2", 2]]);
    expect(toasts()).toEqual(["Moved 2 notes to Team"]);
  });

  it("a refused move hands back a fresh preview to confirm again, and moves nothing", async () => {
    api.move.mockRejectedValue(new Error("changed"));
    api.previewMove.mockResolvedValue(preview("n1", 9));
    const outcome = await moveToSpace("n1", "s2", preview("n1", 7));
    expect(outcome).toEqual({ moved: 0, freshPreview: preview("n1", 9) });
    expect(api.refresh).not.toHaveBeenCalled();
    expect(toasts()).not.toContain("Moved to Team");
  });

  it("a batch stops at the first failure but still reports the notes that moved", async () => {
    api.previewMove.mockImplementation(async (id: string) => preview(id, 1));
    api.move.mockResolvedValueOnce({ moved: 1 }).mockRejectedValueOnce(new Error("no"));
    const outcome = await moveToSpace(["a", "b", "c"], "s2");
    expect(outcome).toEqual({ moved: 1 });
    expect(api.move).toHaveBeenCalledTimes(2);
    expect(api.refresh).toHaveBeenCalledOnce();
  });
});
