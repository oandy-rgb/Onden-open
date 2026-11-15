import { useState, type RefObject } from "react";
import { Download, Ellipsis, FilePlus2, Upload, Hand, LayoutGrid, ListTree, MousePointer2, PenLine, Square, StickyNote, Grid2x2, Network, Hash, GitFork, Maximize } from "lucide-react";
import type { CanvasTool } from "../hooks/useCanvasTools";
import { t } from "../lib/i18n";
import { Button, Menu, MenuItem, MenuLabel, MenuSeparator, usePopover } from "./ui";
import "./BoardToolbar.css";

/** The board's one tool bar, at the bottom and centred (the pen's own toolbar
 *  sits right above it). Exactly one of the five tools is lit; adding a note
 *  and the ⋯ menu are actions, not tools. */
export type BoardToolbarProps = {
  tool: CanvasTool;
  onTool: (tool: CanvasTool) => void;
  /** The board can hold ink (a note's board, not a tag's). */
  penAvailable: boolean;
  /** A board is open: without one there is nothing to draw on or add to. */
  boardOpen: boolean;
  addNote: { open: boolean; onToggle: () => void; buttonRef: RefObject<HTMLButtonElement | null> };
  /** The rarely used switches and arrangements. */
  more: {
    snapToGrid: boolean; onSnapToGrid: () => void;
    graphLocalMode: boolean; onGraphLocalMode: () => void;
    showTagEdges: boolean; onShowTagEdges: () => void;
    parentMode: boolean; onParentMode: () => void;
    onTidy: () => void;
    onArrangeTree: () => void;
    /** "Fit everything" lives here on a phone, where the corner's buttons are gone. */
    onFit?: () => void;
    exporting: boolean;
    onExport: () => void;
    onImport: () => void;
  };
};

export default function BoardToolbar({ tool, onTool, penAvailable, boardOpen, addNote, more }: BoardToolbarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const pop = usePopover<HTMLButtonElement>({ open: moreOpen, onClose: () => setMoreOpen(false), placement: "top-end" });
  const lit = (id: CanvasTool) => ({ "aria-pressed": tool === id, className: tool === id ? "board-tool board-tool--lit" : "board-tool" });
  return (
    <div className="board-toolbar" role="toolbar" aria-label={t("Board tools")}>
      <Button variant="icon" {...lit("select")} onClick={() => onTool("select")} aria-label={t("Select")} title={t("Select (V)")}><MousePointer2 size={18} /></Button>
      <Button variant="icon" {...lit("hand")} onClick={() => onTool("hand")} aria-label={t("Move")} title={t("Move the board by dragging")}><Hand size={18} /></Button>
      {penAvailable && (
        <Button variant="icon" {...lit("pen")} aria-disabled={!boardOpen} onClick={() => { if (boardOpen) onTool("pen"); }}
          aria-label={t("Pen")} title={boardOpen ? t("Draw ink (P) — E for eraser") : t("Open a canvas to draw")}><PenLine size={18} /></Button>
      )}
      <Button variant="icon" {...lit("card")} onClick={() => onTool("card")} aria-label={t("Sticky note")} title={t("New card — click canvas (C)")}><StickyNote size={18} /></Button>
      <Button variant="icon" {...lit("section")} onClick={() => onTool("section")} aria-label={t("Frame")} title={t("New section — click canvas (S)")}><Square size={18} /></Button>
      <span className="board-toolbar-sep" aria-hidden="true" />
      <Button variant="icon" className="board-tool" ref={addNote.buttonRef} aria-disabled={!boardOpen} aria-expanded={addNote.open}
        onClick={() => { if (boardOpen) addNote.onToggle(); }} aria-label={t("Add card")}
        title={boardOpen ? t("Add existing note") : t("Open a canvas to add notes")}><FilePlus2 size={18} /></Button>
      <Button variant="icon" className="board-tool" ref={pop.anchor} aria-haspopup="menu" aria-expanded={moreOpen}
        onClick={() => setMoreOpen((open) => !open)} aria-label={t("More tools")} title={t("More tools")}><Ellipsis size={18} /></Button>
      {moreOpen && (
        <Menu popover={pop} label={t("More tools")}>
          <MenuLabel>{t("Switches")}</MenuLabel>
          <MenuItem keepOpen checked={more.snapToGrid} onSelect={more.onSnapToGrid}><Grid2x2 size={15} /> {t("Snap to grid")}</MenuItem>
          <MenuItem keepOpen checked={more.graphLocalMode} onSelect={more.onGraphLocalMode} title={t("Focus on this card and its connections")}><Network size={15} /> {t("Focus on this card and its connections")}</MenuItem>
          <MenuItem keepOpen checked={more.showTagEdges} onSelect={more.onShowTagEdges} title={t("Shared tags — select a card to see its peers")}><Hash size={15} /> {t("Shared tags")}</MenuItem>
          <MenuItem keepOpen checked={more.parentMode} onSelect={more.onParentMode} title={t("Parent mode — connect to set hierarchy")}><GitFork size={15} /> {t("Parent mode")}</MenuItem>
          <MenuSeparator />
          <MenuItem disabled={!boardOpen} onSelect={more.onTidy}><LayoutGrid size={15} /> {t("Tidy up (grid)")}</MenuItem>
          <MenuItem disabled={!boardOpen} onSelect={more.onArrangeTree}><ListTree size={15} /> {t("Arrange as tree")}</MenuItem>
          {more.onFit && <MenuItem disabled={!boardOpen} onSelect={more.onFit}><Maximize size={15} /> {t("Fit view")}</MenuItem>}
          <MenuSeparator />
          <MenuItem disabled={!boardOpen || more.exporting} onSelect={more.onExport}>
            <Download size={15} /> {more.exporting ? t("Preparing export…") : t("Export board (.canvas)")}
          </MenuItem>
          <MenuItem onSelect={more.onImport}><Upload size={15} /> {t("Import .canvas file")}</MenuItem>
        </Menu>
      )}
    </div>
  );
}
