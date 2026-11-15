// The S Pen side button / a native shell's pen shortcut on the two hosts that
// inkPenShortcutHosts.test.tsx does not cover: the whiteboard ink layer and the
// PDF view. Both hand the engine the hook's callback (usePenShortcutTool), and
// the tool must follow through the host's own tool state.
import { idleBoardHistory } from "./helpers/boardHistory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import type { InkActiveTool } from "../lib/ink/types";
import { emitPenShortcut } from "../lib/penShortcutBridge";
import { INK_COLORS } from "../components/InkToolbar";
import { INK_SIZES } from "../lib/inkSizes";
import { useInkPen } from "../hooks/useInkPen";

vi.mock("../lib/ink/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ink/store")>()),
  loadInkPage: vi.fn(async () => null),
}));

// Each press well after the last: a random stamp could land before the previous
// one, and a contextmenu that close counts as the same press still held.
let clock = performance.now();
const sideButton = (el: Element) => {
  clock += 10_000;
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "timeStamp", { value: clock });
  fireEvent(el, e);
};

describe("CanvasInkLayer", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  async function mountLayer() {
    const { default: CanvasInkLayer } = await import("../components/CanvasInkLayer");
    const seen: InkActiveTool[] = [];
    function Host() {
      const pen = useInkPen({ color: INK_COLORS[0].value, sizeId: INK_SIZES[1].id });
      useEffect(() => { seen.push(pen.tool); }, [pen.tool]);
      return (
        <ReactFlowProvider>
          <CanvasInkLayer boardHistory={idleBoardHistory} canvasId="c1" penActive spaceHeld={false} pen={pen} />
        </ReactFlowProvider>
      );
    }
    const view = render(<Host />);
    await waitFor(() => expect(view.container.querySelector("[data-ink-renderer]")?.getAttribute("data-ink-renderer")).toBeTruthy());
    return { view, seen };
  }

  it("the side button on the capture surface flips pen ↔ eraser through the host's tool state", async () => {
    const { view, seen } = await mountLayer();
    const capture = view.container.querySelector(".canvas-ink-capture") as HTMLElement;
    sideButton(capture);
    await waitFor(() => expect(seen[seen.length - 1]).toBe("eraser"));
    sideButton(capture);
    await waitFor(() => expect(seen[seen.length - 1]).toBe("pen"));
  });

  it("a native shell's shortcut flips the tool too", async () => {
    const { seen } = await mountLayer();
    act(() => { expect(emitPenShortcut("apple-pencil-double-tap")).toBe(true); });
    expect(seen[seen.length - 1]).toBe("eraser");
  });
});
