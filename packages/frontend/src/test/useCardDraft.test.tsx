import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCardDraft } from "../hooks/useCardDraft";
import { ApiError } from "../lib/api";
import { addToast, getAppState, resetAppState } from "../lib/appStore";
import { reportWriteFailure } from "../lib/data/writeErrors";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => { vi.useFakeTimers(); resetAppState(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("debounces typing but flushes synchronously before navigation, with no leftover timer", async () => {
  const response = deferred();
  const save = vi.fn(() => response.promise);
  const { result, rerender } = renderHook(({ content }) => useCardDraft("a", content, save), { initialProps: { content: "before" } });
  act(() => { result.current.edit("first"); vi.advanceTimersByTime(600); result.current.edit("latest"); });
  expect(save).not.toHaveBeenCalled();
  let saving!: Promise<boolean>;
  act(() => { saving = result.current.flush(); });
  expect(save).toHaveBeenCalledExactlyOnceWith("a", "latest", { keepalive: false, base: expect.any(String) });
  expect(result.current.content).toBe("latest");
  expect(result.current.status).toBe("saving");
  act(() => vi.advanceTimersByTime(2000));
  expect(save).toHaveBeenCalledTimes(1);
  rerender({ content: "latest" });
  await act(async () => { response.resolve(); expect(await saving).toBe(true); });
  expect(result.current.status).toBe("idle");
});

it("uses the latest writer callback when the debounce fires", async () => {
  const oldSave = vi.fn(), newSave = vi.fn();
  const { result, rerender } = renderHook(({ save }) => useCardDraft("a", "before", save), { initialProps: { save: oldSave } });
  act(() => result.current.edit("new input"));
  rerender({ save: newSave });
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(newSave).toHaveBeenCalledWith("a", "new input", { keepalive: false, base: expect.any(String) });
  expect(oldSave).not.toHaveBeenCalled();
});

it.each(["resolved", "rejected"])("a late %s save cannot replace newer input or its unsaved status", async outcome => {
  const old = deferred();
  const save = vi.fn(() => old.promise);
  const { result } = renderHook(() => useCardDraft("a", "before", save));
  let saving!: Promise<boolean>;
  act(() => { result.current.edit("first"); saving = result.current.flush(); result.current.edit("newer"); });
  await act(async () => {
    if (outcome === "resolved") old.resolve(); else old.reject(new ApiError(403, '{}'));
    await saving;
  });
  expect(result.current.content).toBe("newer");
  expect(result.current.status).toBe("unsaved");
  save.mockResolvedValue();
  await act(async () => { await result.current.flush(); });
  expect(save).toHaveBeenLastCalledWith("a", "newer", { keepalive: false, base: expect.any(String) });
});

it("keeps refused input visible through external updates, reports once, and retries only explicitly", async () => {
  const failure = new ApiError(403, '{}');
  const save = vi.fn().mockImplementationOnce(async () => { reportWriteFailure(failure, addToast); throw failure; }).mockResolvedValue(undefined);
  const { result, rerender } = renderHook(({ content }) => useCardDraft("a", content, save), { initialProps: { content: "before" } });
  act(() => result.current.edit("refused draft"));
  await act(async () => { expect(await result.current.flush()).toBe(false); });
  rerender({ content: "remote update" });
  expect(result.current.content).toBe("refused draft");
  expect(result.current.status).toBe("rejected");
  expect(getAppState().toasts).toHaveLength(1);
  await act(async () => { vi.advanceTimersByTime(5000); expect(await result.current.flush()).toBe(false); });
  expect(save).toHaveBeenCalledTimes(1);
  await act(async () => { expect(await result.current.retry()).toBe(true); });
  expect(save).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenLastCalledWith("a", "refused draft", { keepalive: false, base: expect.any(String) });
});

it("pagehide uses the existing keepalive save path exactly once", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  const { result, unmount } = renderHook(() => useCardDraft("a", "before", save));
  act(() => result.current.edit("exit input"));
  await act(async () => window.dispatchEvent(new Event("pagehide")));
  expect(save).toHaveBeenCalledExactlyOnceWith("a", "exit input", { keepalive: true, base: expect.any(String) });
  unmount();
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(save).toHaveBeenCalledTimes(1);
});

it("unmount hands off pending text for the original note and consumes a late rejection", async () => {
  const response = deferred();
  const save = vi.fn(() => response.promise);
  const old = renderHook(() => useCardDraft("old-note", "before", save));
  act(() => old.result.current.edit("leaving draft"));
  old.unmount();
  expect(save).toHaveBeenCalledExactlyOnceWith("old-note", "leaving draft", { keepalive: false, base: expect.any(String) });
  const next = renderHook(() => useCardDraft("new-note", "other body", save));
  await act(async () => { response.reject(new ApiError(403, '{}')); });
  expect(next.result.current.content).toBe("other body");
  expect(next.result.current.status).toBe("idle");
  // The writer reports a refusal; the hook adds no second report.
  expect(getAppState().toasts).toHaveLength(0);
});

it("sends each input on the text it was typed onto: the shown body, then the previous send", async () => {
  const first = deferred();
  const save = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
  const { result } = renderHook(() => useCardDraft("a", "shown body", save));
  act(() => result.current.edit("first input"));
  act(() => { void result.current.flush(); });
  act(() => result.current.edit("second input"));
  act(() => { void result.current.flush(); });
  expect(save.mock.calls.map(([, content, options]) => [content, options.base])).toEqual([
    ["first input", "shown body"],
    ["second input", "first input"],
  ]);
  await act(async () => { first.resolve(); });
});

it("after a refused send, the next input builds on the text the refused one started from", async () => {
  const save = vi.fn().mockRejectedValueOnce(new ApiError(403, "{}")).mockResolvedValue(undefined);
  const { result } = renderHook(() => useCardDraft("a", "shown body", save));
  act(() => result.current.edit("refused"));
  await act(async () => { await result.current.flush(); });
  act(() => result.current.edit("next"));
  await act(async () => { await result.current.flush(); });
  expect(save.mock.calls.map(([, content, options]) => [content, options.base])).toEqual([
    ["refused", "shown body"],
    ["next", "shown body"],
  ]);
});

it("an unchanged card does not write on pagehide or unmount", () => {
  const save = vi.fn();
  const { unmount } = renderHook(() => useCardDraft("a", "before", save));
  act(() => window.dispatchEvent(new Event("pagehide")));
  unmount();
  expect(save).not.toHaveBeenCalled();
});

it("typing and typing back to the shown content sends nothing", async () => {
  const save = vi.fn();
  const { result } = renderHook(() => useCardDraft("a", "before", save));
  act(() => { result.current.edit("before!"); result.current.edit("before"); });
  await act(async () => { expect(await result.current.flush()).toBe(true); });
  expect(save).not.toHaveBeenCalled();
  expect(result.current.status).toBe("idle");
  expect(result.current.content).toBe("before");
});
