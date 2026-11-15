// What a right-click / long-press menu was opened on.
export type CtxMenu =
  | { kind: "graph-node"; nodeId: string; x: number; y: number }
  | { kind: "graph-edge"; edgeId: string; edgeType: string; x: number; y: number }
  | { kind: "graph-canvas"; x: number; y: number; flowX: number; flowY: number }
  | { kind: "sidebar-node"; nodeId: string; x: number; y: number }
  | { kind: "sidebar-pointer"; pointerId: string; targetId: string; x: number; y: number };
