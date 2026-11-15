// The whiteboard's pen toolbar is the shared InkToolbar and exists only while the pen is in hand.
import { idleBoardHistory } from "./helpers/boardHistory";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReactFlowProvider } from "@xyflow/react";
import { INK_COLORS } from "../components/InkToolbar";
import { INK_SIZES } from "../lib/inkSizes";
import { useInkPen } from "../hooks/useInkPen";

vi.mock("../lib/ink/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ink/store")>()),
  loadInkPage: vi.fn(async () => null),
}));

async function mountLayer(penActive: boolean) {
  const { default: CanvasInkLayer } = await import("../components/CanvasInkLayer");
  function Host() {
    const pen = useInkPen({ color: INK_COLORS[0].value, sizeId: INK_SIZES[1].id });
    return <ReactFlowProvider><CanvasInkLayer boardHistory={idleBoardHistory} canvasId="c1" penActive={penActive} spaceHeld={false} pen={pen} /></ReactFlowProvider>;
  }
  const view = render(<Host />);
  if (penActive) await waitFor(() => expect(view.container.querySelector("[data-ink-renderer]")?.getAttribute("data-ink-renderer")).toBeTruthy());
  return view;
}

describe("CanvasInkLayer's toolbar", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("shows the shared InkToolbar with the pen in hand, docked in the layer, and none otherwise", async () => {
    const drawing = await mountLayer(true);
    const bar = drawing.container.querySelector(".ink-note-toolbar");
    expect(bar).not.toBeNull();
    expect(bar).toHaveClass("canvas-ink-toolbar");
    expect(bar!.querySelector('[data-ink-tool="pen"]')).toHaveAttribute("aria-pressed", "true");
    drawing.unmount();
    const idle = await mountLayer(false);
    expect(idle.container.querySelector(".ink-note-toolbar")).toBeNull();
  });
});
