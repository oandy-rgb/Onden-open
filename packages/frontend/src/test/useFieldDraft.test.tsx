import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useFieldDraft } from "../hooks/useFieldDraft";

afterEach(cleanup);
const hide = () => act(() => { window.dispatchEvent(new Event("pagehide")); });
type Props = { key: string; target: string; committed: string };
const setup = (commit = vi.fn()) => ({
  commit,
  ...renderHook((p: Props) => useFieldDraft({ target: p.target, targetKey: p.key, committed: p.committed, commit }), { initialProps: { key: "a", target: "note A", committed: "saved A" } as Props }),
});

it("commits on blur / Enter as before, once, and not when the text is unchanged", async () => {
  const { result, commit } = setup();
  await act(async () => { await result.current.flush(); });
  expect(commit).not.toHaveBeenCalled();
  act(() => result.current.edit("typed"));
  await act(async () => { await result.current.flush(); await result.current.flush(); });
  expect(commit).toHaveBeenCalledExactlyOnceWith("note A", "typed", { keepalive: false, base: "saved A" });
  act(() => result.current.edit("saved A")); // typed back to what is saved
  await act(async () => { await result.current.flush(); });
  expect(commit).toHaveBeenCalledTimes(1);
});

it("commits unsent text when the field unmounts", () => {
  const { result, commit, unmount } = setup();
  act(() => result.current.edit("typed"));
  unmount();
  expect(commit).toHaveBeenCalledExactlyOnceWith("note A", "typed", { keepalive: false, base: "saved A" });
});

it("commits unsent text when the page is hidden, with keepalive, and not again on unmount", () => {
  const { result, commit, unmount } = setup();
  act(() => result.current.edit("typed"));
  hide();
  expect(commit).toHaveBeenCalledExactlyOnceWith("note A", "typed", { keepalive: true, base: "saved A" });
  unmount();
  expect(commit).toHaveBeenCalledTimes(1);
});

it("commits when the app goes to the background (visibilitychange to hidden)", () => {
  const { result, commit } = setup();
  act(() => result.current.edit("typed"));
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  expect(commit).toHaveBeenCalledExactlyOnceWith("note A", "typed", { keepalive: true, base: "saved A" });
});

it("does not send autosaves while typing", () => {
  vi.useFakeTimers();
  const { result, commit } = setup();
  act(() => result.current.edit("typed"));
  act(() => vi.advanceTimersByTime(10_000));
  expect(commit).not.toHaveBeenCalled();
  vi.useRealTimers();
});

it("Escape (discard) drops the draft: nothing is sent on unmount or hide", () => {
  const { result, commit, unmount } = setup();
  act(() => result.current.edit("typed"));
  act(() => result.current.discard());
  expect(result.current.text).toBe("saved A");
  hide();
  unmount();
  expect(commit).not.toHaveBeenCalled();
});

it("wrong note: text typed on note A goes to note A when the field now points at note B, and B never shows or gets it", () => {
  const { result, commit, rerender } = setup();
  act(() => result.current.edit("typed on A"));
  rerender({ key: "b", target: "note B", committed: "saved B" }); // a keyboard note switch with the same field instance
  expect(commit).toHaveBeenCalledExactlyOnceWith("note A", "typed on A", { keepalive: false, base: "saved A" });
  expect(result.current.text).toBe("saved B");
  // A blur now (focus was kept) has nothing of A's to write into B.
  act(() => { void result.current.flush(); });
  hide();
  expect(commit).toHaveBeenCalledTimes(1);
  // New typing on B is B's own, with B's base.
  act(() => result.current.edit("typed on B"));
  act(() => { void result.current.flush(); });
  expect(commit).toHaveBeenLastCalledWith("note B", "typed on B", { keepalive: false, base: "saved B" });
});

it("a refused commit keeps the text in the field and does not retry by itself", async () => {
  const commit = vi.fn().mockRejectedValue(new Error("refused"));
  const { result } = setup(commit);
  act(() => result.current.edit("typed"));
  await act(async () => { await result.current.flush(); });
  expect(result.current.text).toBe("typed");
  expect(result.current.status).toBe("rejected");
  hide();
  expect(commit).toHaveBeenCalledTimes(1);
});
