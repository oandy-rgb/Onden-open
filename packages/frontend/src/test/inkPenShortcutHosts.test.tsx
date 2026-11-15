// Host side of the S Pen side button: the tool follows pen ↔ eraser through the
// host's own setTool (toolbar included).
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubPagesNearScreen } from "./helpers/nearScreen";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { useState } from "react";
import { usePenShortcutTool } from "../lib/ink";
import type { InkActiveTool } from "../lib/ink/types";

function useHost(initial: InkActiveTool = "pen") {
  const [tool, setTool] = useState<InkActiveTool>(initial);
  return { tool, setTool, press: usePenShortcutTool(tool, setTool) };
}

describe("usePenShortcutTool", () => {
  it("pen → eraser → pen, with one stable callback", () => {
    const { result } = renderHook(() => useHost());
    const press = result.current.press;
    act(() => press());
    expect(result.current.tool).toBe("eraser");
    act(() => press());
    expect(result.current.tool).toBe("pen");
    expect(result.current.press).toBe(press);
  });

  it("highlighter and hand come back after the eraser", () => {
    const { result } = renderHook(() => useHost());
    act(() => result.current.setTool("highlighter"));
    act(() => result.current.press());
    expect(result.current.tool).toBe("eraser");
    act(() => result.current.press());
    expect(result.current.tool).toBe("highlighter");
    act(() => result.current.setTool("hand"));
    act(() => result.current.press());
    act(() => result.current.press());
    expect(result.current.tool).toBe("hand");
  });

  it("an eraser picked from the toolbar returns to the previous tool; a fresh eraser start returns to pen", () => {
    const { result } = renderHook(() => useHost());
    act(() => result.current.setTool("highlighter"));
    act(() => result.current.setTool("eraser"));
    act(() => result.current.press());
    expect(result.current.tool).toBe("highlighter");
    const fresh = renderHook(() => useHost("eraser"));
    act(() => fresh.result.current.press());
    expect(fresh.result.current.tool).toBe("pen");
  });
});

describe("InkNodeView", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("the side button (contextmenu on the stage) moves the toolbar selection pen ↔ eraser", async () => {
    stubPagesNearScreen();
  vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const { default: InkNodeView } = await import("../components/InkNodeView");
    const { container } = render(<InkNodeView />);
    const stage = container.querySelector(".page-ink-surface") as HTMLElement;
    expect(stage).toBeTruthy();
    const selected = () => container.querySelector('[aria-pressed="true"], [aria-checked="true"]')?.textContent
      ?? container.querySelector(".ink-note")?.className;
    const before = selected();
    // Two separate presses (one held press repeats its menu, see penShortcut.ts).
    const press = (t: number) => {
      const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      Object.defineProperty(e, "timeStamp", { value: t });
      fireEvent(stage, e);
    };
    press(10_000);
    expect(container.querySelector(".ink-note")!.className).toContain("ink-note--eraser");
    press(12_000);
    expect(container.querySelector(".ink-note")!.className).toContain("ink-note--pen");
    void before; void screen;
  });
});
