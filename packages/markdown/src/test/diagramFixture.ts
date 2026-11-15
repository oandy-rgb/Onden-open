// A valid flowchart block and its layout, for the diagram tests.
import type { DiagramLayout } from "../diagramLayout.js";

export const SOURCE = "flowchart TD\n  A[Start] --> B{Ready?}\n  B -->|yes| C[Go]";
export const GOOD: DiagramLayout = {
  version: 1, kind: "flowchart", width: 300, height: 300, groups: [],
  nodes: [
    { id: "A", shape: "rect", x: 50, y: 20, w: 80, h: 30, label: "Start" },
    { id: "B", shape: "diamond", x: 50, y: 100, w: 90, h: 60, label: "Ready?" },
    { id: "C", shape: "round", x: 50, y: 200, w: 80, h: 30, label: "Go" },
  ],
  edges: [
    { id: "A_B", from: "A", to: "B", path: "M50,35L50,70", line: "solid", arrow_start: "none", arrow_end: "arrow", label: "", label_x: 0, label_y: 0 },
    { id: "B_C", from: "B", to: "C", path: "M50,130C50,150 50,170 50,185", line: "dashed", arrow_start: "none", arrow_end: "arrow", label: "yes", label_x: 60, label_y: 160 },
  ],
};
