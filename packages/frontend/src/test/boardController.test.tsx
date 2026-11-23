import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boardController, useBoardControllerReady } from "../hooks/boardController";
import type { BoardWorkspace } from "../hooks/useBoardWorkspace";

const fakeBoard = (tidy = vi.fn(async () => {})) => ({ tidyActiveCanvas: tidy }) as unknown as BoardWorkspace;

describe("boardController", () => {
  afterEach(() => { boardController.clear(); });

  it("a command asked before the board's code has loaded runs once it is published", async () => {
    const tidy = vi.fn(async () => {});
    let done = false;
    const run = boardController.whenReady().then((ready) => ready.tidyActiveCanvas()).then(() => { done = true; });
    await Promise.resolve();
    expect(tidy).not.toHaveBeenCalled();
    boardController.publish(fakeBoard(tidy));
    await run;
    expect(tidy).toHaveBeenCalledTimes(1);
    expect(done).toBe(true);
  });

  it("answers at once when the board is already published, and waits again after it is cleared", async () => {
    const board = fakeBoard();
    boardController.publish(board);
    await expect(boardController.whenReady()).resolves.toBe(board);
    boardController.clear();
    let settled = false;
    void boardController.whenReady().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("a screen that reads the board gets the latest published state", async () => {
    const first = fakeBoard();
    boardController.publish(first);
    const { result } = renderHook(() => useBoardControllerReady());
    expect(result.current).toBe(first);
    const second = fakeBoard();
    act(() => boardController.publish(second));
    expect(result.current).toBe(second);
  });
});
