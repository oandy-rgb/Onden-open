import type { ReactNode } from "react";
import { useNode, useOnline } from "../lib/appStore";
import { useCapabilities } from "../lib/capabilities";
import { blockLinkWriter } from "../lib/data";
import { useT } from "../lib/i18n";
import { Pressable } from "./ui";

/** Beside a part link whose paragraph is only probably where the link points (anchor state "maybe"): says so, and for a
 *  person who may edit that note offers the one-click 「就是這段」 that makes it certain. Anyone else only sees the hint.
 *  The link itself already opens the probable paragraph.
 *  `lost`: the paragraph is not found and the link opens the note itself; the hint says so, and offers a best guess
 *  (`guessed`) to confirm the same way. */
export default function PartLinkNote(props: { noteId: string; anchorId: string; lost?: boolean; guessed?: boolean } | { gone: string; children?: ReactNode }) {
  return "gone" in props ? <PartLinkGone quote={props.gone}>{props.children}</PartLinkGone> : <PartLinkMaybe {...props} />;
}

function PartLinkMaybe({ noteId, anchorId, lost = false, guessed = true }: { noteId: string; anchorId: string; lost?: boolean; guessed?: boolean }) {
  const t = useT();
  const online = useOnline();
  const caps = useCapabilities(online);
  const note = useNode(noteId);
  const mayConfirm = !!note && caps.canEdit(note);
  return (
    <span className="part-link-maybe">
      <span className="part-link-maybe-hint">{lost ? t("The paragraph is gone") : t("Maybe here")}</span>
      {lost && guessed && <span className="part-link-maybe-hint">{t("Maybe this one")}</span>}
      {mayConfirm && (!lost || guessed) && (
        <Pressable className="part-link-maybe-confirm" onClick={() => { void blockLinkWriter.confirm(noteId, anchorId); }}>
          {t("This is the one")}
        </Pressable>
      )}
    </span>
  );
}

/** A part link with nowhere to go: its paragraph was deleted (the old words, struck through, and 「已刪除的段落」 beside them),
 *  or its note is not this reader's (`quote` empty: only 「無法存取的內容」, never a name or any words). */
function PartLinkGone({ quote, children }: { quote: string; children?: ReactNode }) {
  return quote
    ? <span className="wikilink-token wikilink-token--deleted"><s>{quote}</s> <span className="wikilink-token-note">{children}</span></span>
    : <span className="wikilink-token wikilink-token--unavailable">{children}</span>;
}
