import { ChevronLeft, Maximize, Minus, Plus, Redo2, Undo2 } from "lucide-react";
import { t } from "../lib/i18n";
import { Button } from "./ui";
import { BoardNoteTitle, useBoardPhoneNav } from "./BoardPhoneNav";
import "./BoardCornerControls.css";

/** Undo / redo of card moves, zoom, and "fit everything". Wide boards keep them together in the bottom-left
 *  corner. A phone keeps one bar at the bottom (the tool bar): undo / redo go to the top-left, level with 「顯示」,
 *  "fit everything" lives in the tool bar's ⋯ menu, and the − / + buttons are left out when a finger zooms.
 *  While the pen is in hand its own toolbar (InkToolbar) has undo / redo, and they are the same two: the board has one
 *  history (hooks/useBoardHistory) that strokes and card moves both register in, so the corner's pair is left out then
 *  rather than showing two 復原 buttons that do the same thing.
 *  A phone's board is full screen for good, so its top-left row starts with ‹ (the way out) and the note's
 *  title ⌄ (its view tabs) sits between that row and 「顯示」 (BoardPhoneNav). */
export type BoardCornerControlsProps = {
  /** A phone-width board. */
  phone: boolean;
  /** Show the − / + buttons (a phone zooms with two fingers instead). */
  zoomButtons: boolean;
  /** The pen is the tool in hand: its toolbar carries undo / redo. */
  penInHand: boolean;
  canUndo: boolean; canRedo: boolean;
  onUndo: () => void; onRedo: () => void;
  zoom: number;
  onZoomIn: () => void; onZoomOut: () => void;
  onFit: () => void;
};

export default function BoardCornerControls({ phone, zoomButtons, penInHand, canUndo, canRedo, onUndo, onRedo, zoom, onZoomIn, onZoomOut, onFit }: BoardCornerControlsProps) {
  const history = penInHand ? null : <>
    <Button variant="icon" size="sm" disabled={!canUndo} onClick={onUndo} aria-label={t("Undo")} title={t("Undo canvas move")}><Undo2 size={16} /></Button>
    <Button variant="icon" size="sm" disabled={!canRedo} onClick={onRedo} aria-label={t("Redo")} title={t("Redo")}><Redo2 size={16} /></Button>
  </>;
  const zoomOut = <Button variant="icon" size="sm" onClick={onZoomOut} aria-label={t("Zoom out")}><Minus size={16} /></Button>;
  const zoomIn = <Button variant="icon" size="sm" onClick={onZoomIn} aria-label={t("Zoom in")}><Plus size={16} /></Button>;
  const phoneNav = useBoardPhoneNav();
  if (phone) {
    return <>
      <div className="board-history" role="group" aria-label={t("Undo and redo")}>
        {phoneNav && <Button variant="icon" size="sm" onClick={phoneNav.back.onBack} aria-label={phoneNav.back.label} title={phoneNav.back.label}><ChevronLeft size={18} /></Button>}
        {history}
      </div>
      {phoneNav && <BoardNoteTitle title={phoneNav.title} sheet={phoneNav.sheet} />}
      {zoomButtons && <div className="board-corner" role="group" aria-label={t("Canvas controls")}>{zoomOut}{zoomIn}</div>}
    </>;
  }
  return (
    <div className="board-corner" role="group" aria-label={t("Canvas controls")}>
      {history}
      {history && <span className="board-corner-sep" aria-hidden="true" />}
      {zoomOut}
      <span className="board-corner-zoom" title={t("Zoom")}>{Math.round(zoom * 100)}%</span>
      {zoomIn}
      <Button variant="icon" size="sm" onClick={onFit} aria-label={t("Fit view")} title={t("Fit view")}><Maximize size={16} /></Button>
    </div>
  );
}
