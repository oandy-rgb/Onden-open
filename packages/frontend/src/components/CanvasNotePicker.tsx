import { useEffect, useRef, useState } from "react";
import { addToast, useAppSelector, useAllNodes } from "../lib/appStore";
import { writeErrors } from "../lib/data";
import { t } from "../lib/i18n";
import { Modal, Pressable, SearchField, SheetHeader } from "./ui";
import { displayTitle } from "../lib/noteLabel";
import { containsTitle } from "../lib/noteSearch";
import { listsAsNote } from "../lib/nodeTags";
import EmptyState from "./EmptyState";

/** Lists membership of the whole board, independent of graph filters. The
 * writer owns acknowledgement/errors; this picker retains input until it
 * accepts the placement. Mount a new picker for each board/opening. */
export default function CanvasNotePicker({ canvasId, onAdd, onAdded, onClose }: {
  canvasId: string;
  onAdd: (nodeId: string) => Promise<unknown>;
  onAdded: (nodeId: string) => void;
  onClose: () => void;
}) {
  const nodes = useAllNodes();
  const canvas = useAppSelector((s) => s.activeCanvas);
  const [query, setQuery] = useState("");
  const [working, setWorking] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const onBoard = new Set(canvas?.id === canvasId ? canvas.data.nodes.map((n) => n.nodeId) : []);
  const search = query.trim().toLowerCase();
  const matches = nodes.filter((n) => listsAsNote(n) && n.id !== canvasId && !onBoard.has(n.id))
    .filter((n) => !search || containsTitle(search, n.title)).slice(0, 12);

  async function add(nodeId: string) {
    if (busy.current || canvas?.id !== canvasId) return;
    busy.current = true; setWorking(true);
    try {
      // false: the person declined at the reminder about who can see the card (nothing was placed).
      const placed = await onAdd(nodeId);
      if (placed !== false && mounted.current) onAdded(nodeId);
    } catch (error) {
      // The common helper avoids a second toast if the writer already reported.
      writeErrors.report(error, addToast);
    } finally {
      busy.current = false;
      if (mounted.current) setWorking(false);
    }
  }

  return <Modal label={t("Add existing note")} className="canvas-add-overlay" busy={working} onClose={onClose}>
    <div className="canvas-add-popover">
    <SheetHeader title={t("Add existing note")} onClose={onClose} />
    <SearchField value={query} onValueChange={setQuery} label={t("Search notes to add…")} />
    {working && <div className="canvas-add-status" role="status">{t("Adding…")}</div>}
    <div className="canvas-add-results" aria-busy={working}>
      {matches.length === 0 && !working && <EmptyState size="inline" as="div" title={t("No notes match")} />}
      {matches.map((n) => <Pressable type="button" key={n.id} className="canvas-add-item" disabled={working}
        title={displayTitle(n.title)} onClick={() => void add(n.id)}>{displayTitle(n.title)}</Pressable>)}
    </div>
    </div>
  </Modal>;
}
