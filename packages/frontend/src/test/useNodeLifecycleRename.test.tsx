import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useNodeLifecycle } from "../hooks/useNodeLifecycle";
import { nodeActions } from "../lib/data";

// Spies are restored after every test (test/setup.ts): each test gets its own.
let rename = vi.spyOn(nodeActions, "rename");
beforeEach(() => { rename = vi.spyOn(nodeActions, "rename").mockResolvedValue(true); });

function props(): Parameters<typeof useNodeLifecycle>[0] {
  return {
    selectedNode: null,
    
    taskTitle: "", setTaskTitle: vi.fn(), renamingNodeId: "a", renameDraft: "Draft", setRenamingNodeId: vi.fn(), setCtxMenu: vi.fn(),
  };
}
describe("sidebar rename acknowledgement", () => {
  it("keeps the form open on refusal, and closes after an accepted correction", async () => {
    const p = props();
    rename.mockResolvedValueOnce(false);
    const { result } = renderHook(() => useNodeLifecycle(p));
    await act(async () => { await result.current.renameNode("a", "Draft"); });
    expect(p.setRenamingNodeId).not.toHaveBeenCalled();
    await act(async () => { await result.current.renameNode("a", "Draft"); });
    expect(p.setRenamingNodeId).toHaveBeenCalledExactlyOnceWith(null);
  });

  for (const changed of [{ renameDraft: "Newer input" }, { renamingNodeId: "b" }]) {
    it(`does not close a changed form: ${JSON.stringify(changed)}`, async () => {
      const p = props();
      let accept!: (value: boolean) => void;
      rename.mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }));
      const { result, rerender } = renderHook(useNodeLifecycle, { initialProps: p });
      let saving!: Promise<void>;
      act(() => { saving = result.current.renameNode("a", "Draft"); });
      rerender({ ...p, ...changed });
      await act(async () => { accept(true); await saving; });
      expect(p.setRenamingNodeId).not.toHaveBeenCalled();
    });
  }

  it("coalesces Enter and blur while the same rename is pending", async () => {
    const p = props();
    let accept!: (value: boolean) => void;
    rename.mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }));
    const { result } = renderHook(() => useNodeLifecycle(p));
    await act(async () => {
      const saving = result.current.renameNode("a", "Draft");
      await result.current.renameNode("a", "Draft");
      expect(rename).toHaveBeenCalledOnce();
      accept(true);
      await saving;
    });
  });
});
