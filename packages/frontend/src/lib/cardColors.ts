// The canvas card colour palette — one source for the right-click colour menu
// (ContextMenu) and the multi-select align bar (KnowledgeWorkspace), so both
// offer the same swatches and an imported JSON Canvas preset maps onto a real
// swatch ([[jsonCanvas]] normalizeJsonCanvasColor). `value: null` clears.
export type CardColor = { label: string; value: string | null };

export const CARD_COLORS: CardColor[] = [
  { label: "Default", value: null },
  { label: "Red",    value: "#ef4444" },
  { label: "Orange", value: "#f97316" },
  { label: "Yellow", value: "#eab308" },
  { label: "Green",  value: "#22c55e" },
  { label: "Blue",   value: "#3b82f6" },
  { label: "Purple", value: "#a855f7" },
  { label: "Pink",   value: "#ec4899" },
];
