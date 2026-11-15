import { useRef } from "react";
import { t } from "../../lib/i18n";
import { PANE_LIMITS, collapsePane, maxPaneWidth, setPaneWidth, usePaneWidthState, type PaneSide } from "../../lib/paneWidths";
import PaneHandle from "./PaneHandle";

/**
 * The drag handle on the inner edge of a desktop side pane (`sidebar` = the
 * notes list, `inspector` = the info pane). Everything ends in `setPaneWidth`;
 * where the handle sits is CSS (`.pane-resizer`), and below the desktop width it
 * is not rendered at all. A drag past the minimum folds the pane away (the
 * stored width is untouched, so opening it again restores that width).
 */
export default function PaneResizer({ side }: { side: PaneSide }) {
  const { stored, fitted, viewport, shown, desktop } = usePaneWidthState();
  const before = useRef<number | null>(null);
  if (!desktop) return null;
  const { min, fallback } = PANE_LIMITS[side];
  return (
    <PaneHandle
      className={`pane-resizer--${side}`}
      label={side === "sidebar" ? t("Resize sidebar") : t("Resize info pane")}
      width={fitted[side]} min={min} max={maxPaneWidth(side, fitted, viewport, shown)} fallback={fallback}
      grows={side === "sidebar" ? 1 : -1}
      onResize={(px) => setPaneWidth(side, px)}
      onReset={() => setPaneWidth(side, null)}
      onDragStart={() => { before.current = stored[side]; }}
      // The width from before this drag comes back when the pane opens.
      onFold={() => { setPaneWidth(side, before.current); collapsePane(side); }}
    />
  );
}
