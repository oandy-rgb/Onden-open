import { useMemo, useState } from "react";
import { inkChangeView } from "@onden/markdown/ink";
import type { InkKind } from "@onden/markdown/ink";
import { reads } from "../../lib/data";
import type { DayInkChange } from "@onden/contract";
import { inkThumbnailSvg } from "../../lib/ink";
import { useT } from "../../lib/i18n";
import { useLoad } from "./useLoad";
import "./InkChangeDisclosure.css";
import { LoadError, Pressable } from "../ui";

/** The picture of one change, drawn from its two drawings. The handwriting page and the whiteboard's pen layer
 *  are drawn the same way: the canvas is the strokes' own bounding box (inkThumbnailSvg), so a board, which has
 *  no page edge, is not cut at the page width. Mounted only once opened: that is when they are read. */
function InkChangePicture({ noteId, kind, change, online }: { noteId: string; kind: InkKind; change: DayInkChange; online: boolean }) {
  const t = useT();
  const [drawings, reload] = useLoad(() => reads.notes.inkChange(noteId, kind, change), [noteId, kind, change.before_event, change.after_event]);
  const svg = useMemo(
    () => (drawings.status === "ready" ? inkThumbnailSvg(inkChangeView(drawings.value.before, drawings.value.after)) : null),
    [drawings],
  );
  if (drawings.status === "error") {
    return (
      <p className="ink-change-note"><LoadError online={online} onRetry={reload} failed={t("Couldn't load the drawing.")} /></p>
    );
  }
  if (drawings.status === "loading") return <p className="ink-change-note">{t("Loading…")}</p>;
  // A drawing drawn white-on-nothing is no picture: say so rather than showing an empty frame.
  if (!svg) return <p className="ink-change-note">{t("Nothing to show for this change.")}</p>;
  return <div className="ink-change-picture" role="img" aria-label={t("What changed in the drawing")} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** "Show what changed" under a history row: opens a small picture of just the strokes this change drew (in
 *  their colours) and erased (pale grey). The drawings are read when it is opened, never with the list. */
export default function InkChangeDisclosure({ noteId, kind, change, online }: { noteId: string; kind: InkKind; change: DayInkChange; online: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="ink-change">
      <Pressable type="button" className="ink-change-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? t("Hide the drawing") : t("Show what was drawn")}
      </Pressable>
      {open && <InkChangePicture noteId={noteId} kind={kind} change={change} online={online} />}
    </div>
  );
}
