// Class names for an element pinned to the window (ui.css `.ui-layer`). The caller's stylesheet keeps its
// own left/right/bottom and z-index; only `position: fixed` lives in ui.css, so the rule that keeps
// `position: fixed` inside components/ui stays true.
import "./ui.css";

export const layerClass = {
  /** Pinned at every width (a corner notice, a drag shadow, a floating hint). */
  fixed: "ui-layer",
  /** Pinned and covering the whole window (the error page, an expanded pane). */
  fill: "ui-layer ui-layer--fill",
  /** Pinned only at phone and tablet widths (a bottom bar, a pinned action row). */
  narrow: "ui-layer--narrow",
} as const;
