import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "./helpers/propsConfig";

const uploadMedia = vi.hoisted(() => vi.fn(async () => { throw new Error("offline"); }));
const toasts = vi.hoisted(() => vi.fn());
vi.mock("../lib/data", async (original) => ({ ...(await original<typeof import("../lib/data")>()), uploadMedia }));
vi.mock("../lib/appStore", async (original) => ({ ...(await original<typeof import("../lib/appStore")>()), addToast: toasts }));
import { useCanvasActions } from "../hooks/useCanvasActions";
import type { Bootstrap, Canvas } from "../lib/api";

// Scan 08 #13: offline, a board action either goes through the same path as its twin (which reports)
// or says it needs a connection; it never does nothing.

const board = { id: "board", title: "Board", created_at: "", updated_at: "", data: { nodes: [{ nodeId: "n1", x: 0, y: 0 }] } } as Canvas;
// Named `use*` for the hooks lint rule; useCanvasActions holds no React state of its own.
const useOfflineActions = (selectCanvas: () => void) => useCanvasActions({
  data: { nodes: [] } as unknown as Bootstrap, online: false, selectedId: null, activeCanvas: board,
  saveCanvasData: vi.fn(), placeCanvasNode: async () => {}, placeExistingNote: async () => true,
  selectCanvas, createCanvas: async () => null, setCanvasNavStack: () => {}, display: {},
});

describe("board actions while offline", () => {
  it("a picture dropped on the board is uploaded like a pasted one, so a failure is reported", async () => {
    uploadMedia.mockClear(); toasts.mockClear();
    const actions = useOfflineActions(() => {});
    const file = new File(["x"], "a.png", { type: "image/png" });
    await actions.handleGraphDrop({ preventDefault() {}, dataTransfer: { getData: () => "", files: [file] } } as never);
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(toasts).toHaveBeenCalled();
  });

  it("opening a nested board says it needs a connection and does not navigate", async () => {
    toasts.mockClear();
    const select = vi.fn();
    await useOfflineActions(select).handleOpenSubCanvas("n1");
    expect(toasts).toHaveBeenCalledWith("Opening a nested board needs a connection.", "info");
    expect(select).not.toHaveBeenCalled();
  });

  it("random offline drops and opens: every picture is uploaded, every open is answered, none navigates", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.oneof(fc.integer({ min: 0, max: 3 }).map((n) => ({ drop: n })), fc.constant({ open: true })), { minLength: 1, maxLength: 8 }),
      async (steps) => {
        uploadMedia.mockClear(); toasts.mockClear();
        const select = vi.fn();
        const actions = useOfflineActions(select);
        let pictures = 0; let opens = 0;
        for (const step of steps) {
          if ("drop" in step) {
            pictures += step.drop;
            const files = Array.from({ length: step.drop }, () => new File(["x"], "a.png", { type: "image/png" }));
            await actions.handleGraphDrop({ preventDefault() {}, dataTransfer: { getData: () => "", files } } as never);
          } else {
            opens += 1;
            await actions.handleOpenSubCanvas("n1");
          }
        }
        expect(uploadMedia).toHaveBeenCalledTimes(pictures);
        expect(toasts).toHaveBeenCalledTimes(pictures + opens);
        expect(select).not.toHaveBeenCalled();
      },
    ), { seed: PROPS_SEED, numRuns: Math.min(PROPS_RUNS, 100) });
  });
});
