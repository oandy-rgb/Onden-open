import { useEffect, useRef } from "react";
import type { LinkedParagraph } from "../lib/blockSafety";
import { anchorsOf, watchAnchors } from "../lib/blockAnchorStore";
import { blockLinkWriter } from "../lib/data";

/** The paragraphs of `noteId` that part links in other notes point to, with how many (blockLinkWriter.counts) and where the
 *  server has them (the anchors): what the editor reads when a deletion may take such a paragraph away. Asked when the note
 *  opens and again a moment after its anchors change; never on a keystroke. Empty while offline or unknown. */
export function useLinkedParagraphs(noteId: string | undefined): { readonly current: readonly LinkedParagraph[] } {
  const linked = useRef<readonly LinkedParagraph[]>([]);
  useEffect(() => {
    linked.current = [];
    if (!noteId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const counts = await blockLinkWriter.counts(noteId);
      if (!live) return;
      linked.current = anchorsOf(noteId)
        .filter((a) => a.status === "valid" && (counts.get(a.anchor_id) ?? 0) > 0)
        .map((a) => ({ from: a.from, to: a.to, quote: a.quote, links: counts.get(a.anchor_id)! }));
    };
    void load();
    const stop = watchAnchors(() => { clearTimeout(timer); timer = setTimeout(() => void load(), 1500); });
    return () => { live = false; clearTimeout(timer); stop(); };
  }, [noteId]);
  return linked;
}
