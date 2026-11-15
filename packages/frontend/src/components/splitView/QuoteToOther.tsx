import { useState, type CSSProperties } from "react";
import { addToast } from "../../lib/appStore";
import { writeErrors } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { displayTitle } from "../../lib/noteLabel";
import type { Side } from "../../lib/splitView";
import { useSplitSelection } from "../../hooks/useSplitSelection";
import { clearSelection } from "../../lib/documentAccess";
import { loadRssQuote } from "../../modules";
import { Button, keepFocus } from "../ui";

/** 「放進另一邊〈筆記名〉」: a selection on one side offers to quote it into the
 *  note on the other side (only when that side shows a note's text). It is
 *  the RSS reader's excerpt (rssQuote.appendQuote: a quote with its source
 *  link and a ^id), the source being this note — so the quote carries a link
 *  back to where it came from. `otherNote` is the note on the other side. */
export default function QuoteToOther({ active, otherNote, sourceOf }: {
  active: boolean;
  otherNote: (from: Side) => { id: string; title: string } | null;
  /** The note a selection was made in, for the source line. */
  sourceOf: (from: Side) => { title: string; url: string } | null;
}) {
  const t = useT();
  const selection = useSplitSelection(active);
  const [busy, setBusy] = useState(false);
  const other = selection ? otherNote(selection.from) : null;
  if (!selection || !other) return null;
  const source = sourceOf(selection.from);
  async function put() {
    if (!selection || !other || busy) return;
    setBusy(true);
    try {
      await (await loadRssQuote()).appendQuote(other.id, {
        passage: { text: selection.text, prefix: "", suffix: "" },
        source: { title: source?.title ?? "", url: source?.url ?? null, feed: "" },
      });
      clearSelection();
    } catch (error) { writeErrors.report(error, addToast); } finally { setBusy(false); }
  }
  return (
    <Button size="sm" className="split-quote" disabled={busy}
      style={{ "--split-quote-x": `${selection.x}px`, "--split-quote-y": `${selection.y}px` } as CSSProperties}
      onMouseDown={keepFocus} onClick={() => void put()}>
      {t("Add to the other side: {name}", { name: displayTitle(other.title) })}
    </Button>
  );
}
