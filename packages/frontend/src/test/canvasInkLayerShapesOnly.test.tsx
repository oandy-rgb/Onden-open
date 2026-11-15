// A board whose ink is only shapes (no strokes) still draws when it is opened, without the pen being picked.
import { idleBoardHistory } from "./helpers/boardHistory";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReactFlowProvider } from "@xyflow/react";
import type { InkDocument } from "@onden/markdown/ink";
import { INK_COLORS } from "../components/InkToolbar";
import { INK_SIZES } from "../lib/inkSizes";
import { useInkPen } from "../hooks/useInkPen";

const stored = vi.hoisted(() => ({ doc: null as unknown }));
vi.mock("../lib/ink/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ink/store")>()),
  loadInkPage: vi.fn(async () => stored.doc),
}));

const base: InkDocument = { version: 1, strokes: [], erased: {}, page: { width: 1000 } };

async function openBoard() {
  const { default: CanvasInkLayer } = await import("../components/CanvasInkLayer");
  function Host() {
    const pen = useInkPen({ color: INK_COLORS[0].value, sizeId: INK_SIZES[1].id });
    return <ReactFlowProvider><CanvasInkLayer boardHistory={idleBoardHistory} canvasId="c1" penActive={false} spaceHeld={false} pen={pen} /></ReactFlowProvider>;
  }
  return render(<Host />);
}

describe("CanvasInkLayer on open", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("draws a board that holds only shapes", async () => {
    stored.doc = { ...base, shapes: [{ id: "r1", kind: "rect", start: [0, 0], end: [100, 80], color: "#d33", size: 4 }] };
    const view = await openBoard();
    await waitFor(() => expect(view.container.querySelector("[data-ink-renderer]")?.getAttribute("data-ink-renderer")).toBeTruthy());
  });

  it("leaves an empty board unbooted until the pen is picked", async () => {
    stored.doc = base;
    const view = await openBoard();
    await new Promise((r) => setTimeout(r, 0));
    expect(view.container.querySelector("[data-ink-renderer]")?.getAttribute("data-ink-renderer") ?? "").toBe("");
  });
});
