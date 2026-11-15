import type { ReviewStatusCard } from "@onden/contract";
import { Button } from "../../components/ui";
import { useT } from "../../lib/i18n";
import { displayTitle } from "../../lib/noteLabel";
import { cardKey } from "./cardKey";
import "./ReviewPanel.css";
import "./ReviewStatusPage.css";

// The cards a person stopped reviewing, each with a way back. Shown on the
// status page (all of them) and when a note's own review opens (the ones in it).

type Props = {
  cards: readonly ReviewStatusCard[];
  online: boolean;
  busy: boolean;
  onOpen: (card: ReviewStatusCard) => void;
  onResume: (card: ReviewStatusCard) => void;
};

export default function StoppedCards({ cards, online, busy, onOpen, onResume }: Props) {
  const t = useT();
  return (
    <ul className="review-status-cards">
      {cards.map((card) => (
        <li key={cardKey(card)} className="review-status-card">
          <span className="review-status-card-title">{displayTitle(card.title)}</span>
          <span className="review-status-card-actions">
            <Button type="button" variant="ghost" onClick={() => onOpen(card)}>{t(card.block ? "Open this paragraph" : "Open the note")}</Button>
            <Button type="button" disabled={busy || !online} onClick={() => onResume(card)}>{t("Start reviewing again")}</Button>
          </span>
        </li>
      ))}
    </ul>
  );
}
