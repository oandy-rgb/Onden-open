import { useState } from "react";
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Crosshair, Ellipsis, ExternalLink, Maximize, Palette } from "lucide-react";
import { t } from "../lib/i18n";
import CardColorSwatches from "./CardColorSwatches";
import { Button, Popover, usePopover } from "./ui";
import "./BoardSelectionBar.css";

/** What the floating bar over the one selected card offers. */
export type BoardSelectionBarProps = {
  onOpen: () => void;
  onColor: (color: string | null) => void;
  /** 以此為中心: only on a board that follows its sub-notes. */
  onCenter?: () => void;
  /** 收合／展開子層: only on a card with sub-notes. */
  branch?: { expanded: boolean; onToggle: () => void };
  /** 摺起來／展開 the card's body (the card's own choice). */
  fold: { folded: boolean; onToggle: () => void };
  /** 重設大小: only on a card that has a size of its own. */
  onResetSize?: () => void;
  /** The card's full menu (what right-click opens), anchored at the button. */
  onMore: (anchor: { x: number; y: number }) => void;
};

export default function BoardSelectionBar({ onOpen, onColor, onCenter, branch, fold, onResetSize, onMore }: BoardSelectionBarProps) {
  const [colorOpen, setColorOpen] = useState(false);
  const pop = usePopover<HTMLButtonElement>({ open: colorOpen, onClose: () => setColorOpen(false), placement: "bottom-start" });
  const branchLabel = branch?.expanded ? t("Collapse sub-notes") : t("Expand sub-notes");
  const foldLabel = fold.folded ? t("Expand card") : t("Fold card");
  return (
    // nodrag / nopan: a press on the bar is not a drag of the card or a pan of the board.
    <div className="board-selection-bar nodrag nopan" role="toolbar" aria-label={t("Selected card")}>
      <Button variant="ghost" size="sm" aria-label={t("Open card")} title={t("Open card")} onClick={onOpen}><ExternalLink size={15} /> <span className="board-selection-label">{t("Open card")}</span></Button>
      <Button variant="ghost" size="sm" ref={pop.anchor} aria-haspopup="dialog" aria-expanded={colorOpen} aria-label={t("Colour")} title={t("Colour")} onClick={() => setColorOpen((open) => !open)}>
        <Palette size={15} /> <span className="board-selection-label">{t("Colour")}</span>
      </Button>
      {colorOpen && (
        <Popover popover={pop} label={t("Colour")} className="board-selection-colors" role="group">
          <CardColorSwatches onPick={(color) => { onColor(color); setColorOpen(false); }} />
        </Popover>
      )}
      <Button variant="ghost" size="sm" aria-label={foldLabel} title={foldLabel} onClick={fold.onToggle}>
        {fold.folded ? <ChevronRight size={15} /> : <ChevronDown size={15} />} <span className="board-selection-label">{foldLabel}</span>
      </Button>
      {onResetSize && <Button variant="ghost" size="sm" aria-label={t("Reset size")} title={t("Reset size")} onClick={onResetSize}><Maximize size={15} /> <span className="board-selection-label">{t("Reset size")}</span></Button>}
      {onCenter && <Button variant="ghost" size="sm" aria-label={t("Centre here")} title={t("Centre here")} onClick={onCenter}><Crosshair size={15} /> <span className="board-selection-label">{t("Centre here")}</span></Button>}
      {branch && (
        <Button variant="ghost" size="sm" aria-label={branchLabel} title={branchLabel} onClick={branch.onToggle}>
          {branch.expanded ? <ChevronsDownUp size={15} /> : <ChevronsUpDown size={15} />} <span className="board-selection-label">{branchLabel}</span>
        </Button>
      )}
      <Button variant="icon" size="sm" aria-label={t("Card actions")} aria-haspopup="menu"
        onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onMore({ x: rect.left, y: rect.bottom + 6 }); }}>
        <Ellipsis size={16} />
      </Button>
    </div>
  );
}
