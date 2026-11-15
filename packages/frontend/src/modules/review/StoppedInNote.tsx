import { useCallback, useEffect, useState } from "react";
import type { ReviewStatusCard } from "@onden/contract";
import { reads, sendWrite, writeErrors } from "../../lib/data";
import { addToast } from "../../lib/appStore";
import { tn, useT } from "../../lib/i18n";
import { revealBlockInNote } from "../../lib/noteReveal";
import { randomUUID } from "../../lib/uuid";
import { cardKey, cardPath } from "./cardKey";
import StoppedCards from "./StoppedCards";

// When a note's own review opens: the cards in that note this person stopped,
// with "Start reviewing again". Read once, here, when the review opens (not
// whenever a note is shown): GET /api/review/:noteId/stopped.

type Props = {
  rootId: string;
  online: boolean;
  onOpenNode: (id: string) => void;
  /** A card was brought back (its card key): it goes to the front of the session. */
  onResumed: (key: string) => void;
};

export default function StoppedInNote({ rootId, online, onOpenNode, onResumed }: Props) {
  const t = useT();
  const [cards, setCards] = useState<ReviewStatusCard[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    reads.modules.review.resource<{ stopped: ReviewStatusCard[] }>(`/api/review/${encodeURIComponent(rootId)}/stopped`)
      .then((answer) => { if (alive) setCards(answer.stopped); })
      .catch(() => { /* offline or not readable: nothing to offer */ });
    return () => { alive = false; };
  }, [rootId]);

  const resume = useCallback(async (card: ReviewStatusCard) => {
    setBusy(true);
    try {
      await sendWrite("POST", `${cardPath(cardKey(card))}/resume`, {}, randomUUID());
      setCards((previous) => previous.filter((other) => cardKey(other) !== cardKey(card)));
      onResumed(cardKey(card));
    } catch (error) {
      writeErrors.report(error, addToast);
    } finally { setBusy(false); }
  }, [onResumed]);

  if (cards.length === 0) return null;
  return (
    <section className="review-stopped-here" aria-label={t("Stopped in this note")}>
      <p className="review-status-note">{tn("1 card in this note is stopped.", "{n} cards in this note are stopped.", cards.length)}</p>
      <StoppedCards
        cards={cards} online={online} busy={busy} onResume={(card) => void resume(card)}
        onOpen={(card) => { if (card.block) revealBlockInNote(card.node_id, card.block.ref); onOpenNode(card.node_id); }}
      />
    </section>
  );
}
