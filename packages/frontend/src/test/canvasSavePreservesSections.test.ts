import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import { PROPS_RUNS, PROPS_SEED } from "./helpers/propsConfig";
import type { DragEvent as ReactDragEvent } from "react";
const updateCanvasCard = vi.fn(async () => {});
vi.mock("../lib/data/domainWriters", async (original) => {
  const actual = await original<typeof import("../lib/data/domainWriters")>();
  return { ...actual, canvasWriter: { ...actual.canvasWriter, updateCard: (...args: unknown[]) => updateCanvasCard(...(args as [])) } };
});
const ensureTab = vi.fn(async (_id: string) => {});
vi.mock("../lib/whiteboardTab", () => ({ ensureWhiteboardTab: (id: string) => ensureTab(id) }));
import { useCanvasActions } from "../hooks/useCanvasActions";
import type { Bootstrap, Canvas, CanvasData, ContentNode } from "../lib/api";

// Regression for [canvas-section-wipe]: dragging a sidebar note onto a board
// (and the auto-rebuild path) used to save a payload that OMITTED
// `activeCanvas.data.sections`. The backend treats an absent `sections` as
// "sections deleted" (setSections(undefined) → DELETE), so every group/section
// on the board vanished. Also covers section-title edits never persisting.

const section = { id: "s1", x: 0, y: 0, width: 400, height: 300, title: "Group" };

function makeActiveCanvas(): Canvas {
  return {
    id: "canvas-1",
    title: "Board",
    created_at: "2026-06-13T00:00:00Z",
    updated_at: "2026-06-13T00:00:00Z",
    data: {
      nodes: [{ nodeId: "existing", x: 10, y: 10 }],
      sections: [section],
    },
  };
}

// Named `use*` so eslint's rules-of-hooks accepts the factory call; it is a
// plain test helper (useCanvasActions holds no React state of its own).
function useTestActions(activeCanvas: Canvas, saveCanvasData: (id: string, d: CanvasData) => void, placeCanvasNode = vi.fn(async () => {})) {
  const nodes = [{ id: "dragged", title: "Note" } as ContentNode];
  return useCanvasActions({
    data: { nodes } as unknown as Bootstrap,
    online: true,
    selectedId: null,
    activeCanvas,
    saveCanvasData,
    placeCanvasNode,
    placeExistingNote: async (...args: unknown[]) => { await (placeCanvasNode as (...a: unknown[]) => Promise<void>)(...args); return true; },
    selectCanvas: () => {},
    createCanvas: async () => null,
    setCanvasNavStack: () => {},
  });
}

function fakeDrop(nodeId: string): ReactDragEvent {
  return {
    preventDefault: () => {},
    dataTransfer: {
      getData: (k: string) => (k === "nodeId" ? nodeId : ""),
      files: [],
    },
  } as unknown as ReactDragEvent;
}

describe("canvas save preserves sections [canvas-section-wipe]", () => {
  it("scan 08 #10: a note payload dropped on the board is ignored (the sidebar drags by pointer); nothing is placed or saved", async () => {
    const save = vi.fn();
    const place = vi.fn(async () => {});
    const { handleGraphDrop } = useTestActions(makeActiveCanvas(), save, place);
    await handleGraphDrop(fakeDrop("dragged"), { x: 500, y: 200 });
    expect(place).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("random drops without a picture never place or save anything", async () => {
    await fc.assert(fc.asyncProperty(fc.string(), fc.array(fc.constantFrom("text/plain", "application/pdf", "audio/mp3")), async (nodeId, types) => {
      const save = vi.fn(); const place = vi.fn(async () => {});
      const { handleGraphDrop } = useTestActions(makeActiveCanvas(), save, place);
      const files = types.map((type) => new File(["x"], "f", { type }));
      await handleGraphDrop({ preventDefault: () => {}, dataTransfer: { getData: () => nodeId, files } } as unknown as ReactDragEvent, { x: 1, y: 2 });
      expect(place).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    }), { seed: PROPS_SEED, numRuns: Math.min(PROPS_RUNS, 100) });
  });

  it("editing a section title persists it (sections, not just local state)", async () => {
    const save = vi.fn();
    const canvas = makeActiveCanvas();
    const { handleSectionTitleChange } = useTestActions(canvas, save);

    await handleSectionTitleChange("s1", "Renamed");

    expect(save).toHaveBeenCalledTimes(1);
    const [, payload] = save.mock.calls[0] as [string, CanvasData];
    expect(payload.sections).toEqual([{ ...section, title: "Renamed" }]);
    // Cards are preserved alongside the section edit.
    expect(payload.nodes).toEqual(canvas.data.nodes);
  });
});


describe("remove only a canvas placement", () => {
  it("preserves sections and other cards and waits for the layout write", async () => {
    const canvas = makeActiveCanvas();
    canvas.data.nodes.push({ nodeId: "keep", x: 200, y: 300, color: "blue" });
    let finish!: () => void;
    const saved = new Promise<void>(resolve => { finish = resolve; });
    const save = vi.fn(() => saved);
    const { handleRemoveFromCanvas } = useTestActions(canvas, save);
    let done = false;
    const result = handleRemoveFromCanvas("existing").then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(save).toHaveBeenCalledExactlyOnceWith("canvas-1", {
      ...canvas.data, nodes: [canvas.data.nodes[1]],
    });
    expect(canvas.data.nodes).toHaveLength(2);
    finish(); await result; expect(done).toBe(true);
  });

  it("propagates refusal without claiming removal completed", async () => {
    const canvas = makeActiveCanvas(); const refusal = new Error("refused");
    const { handleRemoveFromCanvas } = useTestActions(canvas, async () => { throw refusal; });
    await expect(handleRemoveFromCanvas("existing")).rejects.toBe(refusal);
    expect(canvas.data.nodes).toHaveLength(1);
  });
});

describe("restore a group move in one save", () => {
  it("writes all selected groups and cards together, preserving other layout fields", async () => {
    const canvas = makeActiveCanvas(); const save = vi.fn();
    const other = { ...section, id: "s2", title: "Other", color: "blue" };
    canvas.data.sections!.push(other, { ...section, id: "untouched" });
    const { applyCanvasPositions } = useTestActions(canvas, save);
    await applyCanvasPositions([{ nodeId: "existing", x: 30, y: 40 }], [{ id: "s1", x: 20, y: 30 }, { id: "s2", x: 20, y: 30 }]);
    expect(save).toHaveBeenCalledExactlyOnceWith("canvas-1", {
      nodes: [{ nodeId: "existing", x: 30, y: 40 }],
      sections: [{ ...section, x: 20, y: 30 }, { ...other, x: 20, y: 30 }, { ...section, id: "untouched" }],
    });
  });
  it("restores only original member positions, preserving additions, removals and other fields", async () => {
    const canvas = makeActiveCanvas(); const save = vi.fn();
    canvas.data.nodes[0] = { ...canvas.data.nodes[0], width: 320, color: "blue" };
    canvas.data.nodes.push({ nodeId: "added-later", x: 50, y: 50 });
    const { applyCanvasPositions } = useTestActions(canvas, save);
    await applyCanvasPositions([{ nodeId: "existing", x: -20, y: -10 }, { nodeId: "removed", x: 10, y: 10 }], [{ id: "s1", x: -30, y: -40 }]);
    expect(save).toHaveBeenCalledExactlyOnceWith("canvas-1", {
      nodes: [{ nodeId: "existing", x: -20, y: -10, width: 320, color: "blue" }, canvas.data.nodes[1]],
      sections: [{ ...section, x: -30, y: -40 }],
    });
  });

  it("does not recreate a missing section or swallow a refused save", async () => {
    const canvas = makeActiveCanvas(); const save = vi.fn(async () => { throw new Error("denied"); });
    const { applyCanvasPositions } = useTestActions(canvas, save);
    await expect(applyCanvasPositions([], [{ id: "missing", x: 0, y: 0 }])).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
    await expect(applyCanvasPositions([], [{ id: "s1", x: 0, y: 0 }])).rejects.toThrow("denied");
  });
});

describe("resize saves the complete rectangle", () => {
  it("a top-left group resize preserves the opposite corner and leaves card positions alone", async () => {
    const canvas = makeActiveCanvas(); const save = vi.fn();
    const { handleSectionResized } = useTestActions(canvas, save);
    await handleSectionResized("s1", { x: -40, y: -20, width: 440, height: 320 });
    expect(save).toHaveBeenCalledExactlyOnceWith("canvas-1", {
      ...canvas.data, sections: [{ ...section, x: -40, y: -20, width: 440, height: 320 }],
    });
  });

  it("card resize includes the changed origin, keeps decoration and groups, and propagates rejection", async () => {
    const canvas = makeActiveCanvas();
    canvas.data.nodes[0] = { ...canvas.data.nodes[0], color: "blue", width: 300, height: 240 };
    const save = vi.fn(async () => { throw new Error("refused"); });
    const { handleNodeResized } = useTestActions(canvas, save);
    await expect(handleNodeResized("existing", { x: -9.6, y: -10.4, width: 320.2, height: 260.1 })).rejects.toThrow("refused");
    expect(save).toHaveBeenCalledExactlyOnceWith("canvas-1", {
      ...canvas.data, nodes: [{ ...canvas.data.nodes[0], x: -10, y: -10, width: 320, height: 260 }],
    });
    expect(canvas.data.nodes[0]).toMatchObject({ x: 10, y: 10 });
  });
});

// Scan finding #35: opening a card's sub-canvas saved the parent's layout from
// BEFORE an await, undoing changes made on the board meanwhile. It now writes no
// layout at all: the card note's own board is opened (no child note, no link).
describe("opening a card's sub-canvas", () => {
  it("opens the card's own board and leaves the parent's layout alone", async () => {
    const save = vi.fn();
    const select = vi.fn(async () => {});
    const canvas = makeActiveCanvas();
    const actions = useCanvasActions({
      data: { nodes: [{ id: "existing", title: "Card" } as ContentNode] } as unknown as Bootstrap,
      online: true, selectedId: null, activeCanvas: canvas, saveCanvasData: save,
      placeCanvasNode: vi.fn(async () => {}), placeExistingNote: vi.fn(async () => true), selectCanvas: select,
      createCanvas: vi.fn(async () => null),
      setCanvasNavStack: () => {},
    });
    await actions.handleOpenSubCanvas("existing");
    expect(ensureTab).toHaveBeenCalledExactlyOnceWith("existing");
    expect(select).toHaveBeenCalledExactlyOnceWith("existing");
    expect(updateCanvasCard).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});

describe("existing notes join a board through the one placement owner", () => {
  // The picker and the drop both place a note that already exists; the reminder about who can't
  // see it (lib/boardCardAudience) lives in placeExistingNote, so neither may call the raw placement.
  function useActionsWith(placeCanvasNode: () => Promise<void>, placeExistingNote: () => Promise<boolean>) {
    return useCanvasActions({
      data: { nodes: [{ id: "dragged", title: "Note" } as ContentNode] } as unknown as Bootstrap,
      online: true, selectedId: null, activeCanvas: makeActiveCanvas(), saveCanvasData: vi.fn(),
      placeCanvasNode, placeExistingNote, selectCanvas: () => {}, createCanvas: async () => null, setCanvasNavStack: () => {},
    });
  }
  it("the picker (addToActiveCanvas) goes through placeExistingNote", async () => {
    const raw = vi.fn(async () => {}); const owner = vi.fn(async () => true);
    const actions = useActionsWith(raw, owner);
    await actions.addToActiveCanvas("dragged");
    expect(owner).toHaveBeenCalledTimes(1);
    expect(raw).not.toHaveBeenCalled();
  });
});
