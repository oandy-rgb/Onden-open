// 「去年今天」: a one-line card at the top of the day (under the date and week row)
// with the first paragraph of the note written on this date a year ago. No note,
// or nothing written in it, and there is no card.

import { Pressable } from "../../../components/ui";
import { useEffect, useMemo } from "react";
import { addMonths, plainExcerpt, plainText, splitParagraphs } from "@onden/markdown";
import { useAllNodes } from "../../../lib/appStore";
import { nodeNeedsBody } from "../../../lib/api";
import { dataSync } from "../../../lib/data";
import { useT } from "../../../lib/i18n";
import { personalSpaceId } from "../../../lib/spaces";
import { dayNotesByDate } from "../journal";

const EXCERPT_CHARS = 140;

/** The first paragraph of a note as plain words, or "" when it has none. */
export function firstParagraphText(markdown: string): string {
  const first = splitParagraphs(markdown).find((p) => p.kind === "text" || p.kind === "listItem" || p.kind === "quote");
  return first ? plainExcerpt(plainText(first.body), EXCERPT_CHARS) : "";
}

export default function LastYearCard({ date, onOpenNode }: { date: string; onOpenNode: (id: string) => void }) {
  const t = useT();
  const nodes = useAllNodes();
  const spaceId = personalSpaceId();
  const lastYear = addMonths(date, -12);
  const note = useMemo(() => dayNotesByDate(nodes, spaceId).get(lastYear), [nodes, spaceId, lastYear]);
  useEffect(() => { if (note && nodeNeedsBody(note)) void dataSync.hydrateNode(note.id); }, [note]);
  const text = note && !nodeNeedsBody(note) ? firstParagraphText(note.markdown ?? "") : "";
  if (!note || !text) return null;
  return (
    <aside className="last-year" aria-label={t("This day last year")}>
      <Pressable type="button" className="last-year-open" onClick={() => onOpenNode(note.id)}>
        <span className="last-year-label">{t("This day last year")}</span>
        <span className="last-year-text">{text}</span>
      </Pressable>
    </aside>
  );
}
