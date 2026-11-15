import { GraduationCap } from "lucide-react";
import { Pressable } from "../../components/ui";
import { useT, tn } from "../../lib/i18n";
import { useReviewStats } from "./useReviewStats";
import { useReviewDecks } from "./useReviewDecks";
import { displayTitle } from "../../lib/noteLabel";

// The review module's HomeStart line — same loose-ends section style as the
// host strip (it reuses .home-start-* classes on purpose). Renders nothing
// when nothing is due: the home stays quiet unless there's actually a reason
// to review ([[surface-no-programmer-ui]] — ordinary words, no SRS jargon).
//
// When cards live under specific notes (decks), each gets its own "study this
// one" entry — so review starts where the cards live ("卡片長在空間結構上"),
// not only as one global pile. onStudyDeck opens a subtree-scoped session.

type Props = {
  onOpenReview: () => void;
  onStudyDeck?: (id: string, title: string) => void;
  onOpenStatus?: () => void;
};

const MAX_DECKS = 5; // keep the strip calm — the global line covers the rest

export default function ReviewHomeSection({ onOpenReview, onStudyDeck, onOpenStatus }: Props) {
  const t = useT();
  const { stats } = useReviewStats();
  const { decks } = useReviewDecks();
  if (!stats || stats.due === 0) return null;
  const shown = onStudyDeck ? decks.slice(0, MAX_DECKS) : [];
  return (
    <div className="home-start-section home-start-review">
      <span className="home-start-label"><GraduationCap size={11} /> {t("Review")}</span>
      <ul className="home-start-list">
        <li>
          <Pressable onClick={onOpenReview}>
            {tn("1 note ready to review", "{n} notes ready to review", stats.due)}
            <span className="home-start-time">{stats.new > 0 ? t("{n} new", { n: stats.new }) : ""}</span>
          </Pressable>
        </li>
        {shown.map((d) => (
          <li key={d.node_id}>
            <Pressable onClick={() => onStudyDeck!(d.node_id, d.title)}>
              {t("Study {title}", { title: displayTitle(d.title) })}
              <span className="home-start-time">{t("{n} due", { n: d.due })}</span>
            </Pressable>
          </li>
        ))}
        {onOpenStatus && <li><Pressable onClick={onOpenStatus}>{t("Review status")}</Pressable></li>}
      </ul>
    </div>
  );
}
