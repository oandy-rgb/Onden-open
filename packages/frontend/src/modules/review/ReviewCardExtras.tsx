import { CalendarClock, ExternalLink, EyeOff, Pencil } from "lucide-react";
import type { ReviewContext } from "@onden/contract";
import { useT } from "../../lib/i18n";
import { Button } from "../../components/ui";
import { displayTitle } from "../../lib/noteLabel";

// What sits around a card once its answer is showing: where it comes from
// (the source note, the paragraphs before and after) and the four things a
// person can do with it besides grading. All of them are in plain sight.

export function ReviewContextBlock({ context, paragraph }: { context: ReviewContext; paragraph: boolean }) {
  const t = useT();
  const { source_title: title, before, after } = context;
  if (!title && !before && !after) return null;
  return (
    <section className="review-context" aria-label={t("Where this card comes from")}>
      {title && <p className="review-context-source">{t(paragraph ? "From {title}" : "Inside {title}", { title: displayTitle(title) })}</p>}
      {before && <p className="review-context-near" data-side="before">{before}</p>}
      {after && <p className="review-context-near" data-side="after">{after}</p>}
    </section>
  );
}

type ActionsProps = {
  paragraph: boolean;
  online: boolean;
  busy: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onTomorrow: () => void;
  onStop: () => void;
};

export function ReviewActions({ paragraph, online, busy, onOpen, onEdit, onTomorrow, onStop }: ActionsProps) {
  const t = useT();
  return (
    <div className="review-actions">
      <Button type="button" variant="ghost" onClick={onOpen}><ExternalLink size={14} aria-hidden="true" /> {t(paragraph ? "Open this paragraph" : "Open the note")}</Button>
      <Button type="button" variant="ghost" disabled={!online} onClick={onEdit}><Pencil size={14} aria-hidden="true" /> {t(paragraph ? "Edit this paragraph" : "Edit this note")}</Button>
      <Button type="button" variant="ghost" disabled={busy || !online} onClick={onTomorrow}><CalendarClock size={14} aria-hidden="true" /> {t("Tomorrow")}</Button>
      <Button type="button" variant="ghost" disabled={busy || !online} onClick={onStop}><EyeOff size={14} aria-hidden="true" /> {t("Stop reviewing this")}</Button>
    </div>
  );
}
