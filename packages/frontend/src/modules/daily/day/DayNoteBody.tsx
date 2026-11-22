// The day's note drawn in full, read-only: a tap on the words opens the note to write in it (onOpenNode),
// links in it go where they point. A day with no text (or no note) shows `empty` instead. The Journal page (DayPage) draws it.

import type { MouseEvent, ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "../../../components/ui";
import { NotePreview } from "../../../components/markdownSurfaces";
import { nodeNeedsBody, type ContentNode } from "../../../lib/api";
import { useT } from "../../../lib/i18n";

/** A click on one of these is the link's own, not 「open the note」. */
const OWN_CLICK = "a, button, input, textarea, select, summary, label, [role='button'], [role='link'], [contenteditable='true']";

type Props = {
  day: ContentNode | undefined;
  nodes: readonly ContentNode[];
  onOpenNode: (id: string) => void;
  /** Drawn when the day has no text yet. */
  empty: ReactNode;
};

export default function DayNoteBody({ day, nodes, onOpenNode, empty }: Props) {
  const t = useT();
  const navigate = (_slug: string, id: string | null) => { if (id) onOpenNode(id); };
  const openFromBody = (event: MouseEvent) => {
    if (day && !(event.target as Element).closest(OWN_CLICK)) onOpenNode(day.id);
  };
  if (day && nodeNeedsBody(day)) return <p className="day-page-loading">{t("Loading…")}</p>;
  if (!day || !day.markdown?.trim()) return <>{empty}</>;
  return (
    // The whole page is the target; the button is the same thing for the keyboard.
    <div className="day-page-body journal-body" onClick={openFromBody}>
      <Button size="sm" variant="ghost" className="day-page-open" onClick={() => onOpenNode(day.id)} aria-label={t("Open {title}", { title: day.title })} title={t("Open note")}>
        <ExternalLink size={14} aria-hidden="true" />
      </Button>
      <NotePreview nodes={nodes as ContentNode[]} from={day} onNavigate={navigate}>{day.markdown}</NotePreview>
    </div>
  );
}
