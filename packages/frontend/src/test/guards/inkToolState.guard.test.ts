// The pen in hand (pen / highlighter / eraser / hand / shape) is state of the shared useInkPen
// (hooks/useInkPen.ts) on the whiteboard, as it is for the note and PDF hosts. A host that keeps its
// own `useState<InkActiveTool>` grows a second source of truth for the tool the shortcuts and the
// toolbar must agree on (the whiteboard once did, in useCanvasTools). A failure names the file: take
// the tool from useInkPen. Hosts with extra tools keep a superset type (NoteTool, PdfTool) of their own.
import { describe, expect, it } from "vitest";
import { findUses, sourceFiles } from "./sources";

const OWNER = ["hooks/useInkPen.ts"];
const INK_TOOL_STATE = /useState<\s*InkActiveTool\s*>/;

describe("the pen's tool is held by useInkPen alone", () => {
  it("no other source keeps an InkActiveTool as state", () => {
    expect(findUses(sourceFiles("."), INK_TOOL_STATE, OWNER)).toEqual([]);
  });
  it("useInkPen does keep it, so the allow-list is not empty", () => {
    expect(findUses(sourceFiles("hooks"), INK_TOOL_STATE)).toEqual([expect.stringContaining("hooks/useInkPen.ts:")]);
  });
  it("the pattern catches the violation it is meant to", () => {
    expect(INK_TOOL_STATE.test('const [penTool, setPenTool] = useState<InkActiveTool>("pen");')).toBe(true);
    expect(INK_TOOL_STATE.test("const [tool, setTool] = useState<NoteTool>(\"pen\");")).toBe(false);
  });
});
