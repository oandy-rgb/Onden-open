import { act, renderHook } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { useVersionRestore, type VersionRestoreOutcome } from "../hooks/useVersionRestore";
import { nodeMutations } from "../lib/data";
import { ApiError, noWorkspaceData, type ContentNode } from "../lib/api";
import { getAppState, resetAppState } from "../lib/appStore";
import { resetDraftForNode, __resetDraftStateForTests } from "../lib/data/draftActions";
import { setLocalePref } from "../lib/i18n";

vi.mock("../lib/data", async (original) => ({ ...await original<typeof import("../lib/data")>(), nodeMutations: { restoreVersion: vi.fn() } }));

const note: ContentNode = {
  id: "a", title: "Current note", markdown: "Current body", slug: "a", node_type: "content", source_type: "manual",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(nodeMutations.restoreVersion).mockReset();
  setLocalePref("en");
  __resetDraftStateForTests();
  resetAppState({ data: { ...noWorkspaceData, nodes: [note] }, selectedId: "a", online: true });
  resetDraftForNode(note);
});
afterEach(() => {
  __resetDraftStateForTests();
  resetAppState();
  setLocalePref("system");
});

describe("shared saved-version restore", () => {
  it("updates the active editor and excludes a second request until the writer settles", async () => {
    const pending = deferred<ContentNode>();
    vi.mocked(nodeMutations.restoreVersion).mockReturnValue(pending.promise);
    const { result } = renderHook(useVersionRestore);
    let attempt!: Promise<VersionRestoreOutcome>;
    act(() => { attempt = result.current.restore("a", "version-1", { restoreTitle: false }); });
    await act(async () => { expect((await result.current.restore("a", "version-2", { restoreTitle: false })).status).toBe("refused"); });
    expect(result.current.restoringVersionId).toBe("version-1");
    expect(nodeMutations.restoreVersion).toHaveBeenCalledExactlyOnceWith("a", "version-1", { restoreTitle: false });
    await act(async () => { pending.resolve({ ...note, markdown: "Old body" }); expect((await attempt).status).toBe("applied"); });
    expect(getAppState().overviewDraft).toBe("Old body");
    expect(result.current.restoringVersionId).toBeNull();
  });

  it("treats acknowledgement without a readable result as applied while retaining the draft", async () => {
    vi.mocked(nodeMutations.restoreVersion).mockResolvedValue(undefined);
    const { result } = renderHook(useVersionRestore);
    await act(async () => {
      expect(await result.current.restore("a", "version-1", { restoreTitle: false })).toEqual({ status: "applied", message: "The change is saved. Refresh to load the latest details." });
    });
    expect(getAppState().overviewDraft).toBe("Current body");
  });

  it("returns common refusal feedback and permits a retry without adding another toast", async () => {
    vi.mocked(nodeMutations.restoreVersion).mockRejectedValueOnce(new ApiError(503, "Unavailable"))
      .mockResolvedValueOnce({ ...note, markdown: "Old body" });
    const { result } = renderHook(useVersionRestore);
    await act(async () => { expect((await result.current.restore("a", "version-1", { restoreTitle: false })).status).toBe("refused"); });
    expect(getAppState().overviewDraft).toBe("Current body");
    expect(getAppState().toasts).toHaveLength(0);
    expect(result.current.feedback?.nodeId).toBe("a");
    await act(async () => { expect((await result.current.restore("a", "version-1", { restoreTitle: false })).status).toBe("applied"); });
    expect(getAppState().overviewDraft).toBe("Old body");
  });
});
