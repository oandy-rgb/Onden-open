import { MIN_CENTER_WIDTH, usePaneWidthState, type PaneColumn } from "../../lib/paneWidths";
import PaneHandle from "./PaneHandle";

type Props = {
  column: PaneColumn;
  /** From useColumnWidth: the chosen width, null = the stylesheet's. */
  width: number | null;
  onResize: (px: number | null) => void;
  label: string;
};

/** The drag handle on the right edge of a list column inside a page (the
 *  reader's), the same handle as the shell's side panes. It cannot fold the
 *  column, and the column beside it keeps MIN_CENTER_WIDTH. Desktop only. */
export default function ColumnResizer({ column, width, onResize, label }: Props) {
  const { desktop } = usePaneWidthState();
  if (!desktop) return null;
  return (
    <PaneHandle className="pane-resizer--column" label={label} width={width} min={column.min} max={column.max} fallback={column.fallback}
      grows={1} keepBeside={MIN_CENTER_WIDTH} onResize={onResize} onReset={() => onResize(null)} />
  );
}
