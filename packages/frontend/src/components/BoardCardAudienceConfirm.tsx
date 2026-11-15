import { useT } from "../lib/i18n";
import { displayTitle } from "../lib/noteLabel";
import { useCardAudienceReview } from "../lib/cardAudienceGate";
import MoveToSpaceConfirm from "./MoveToSpaceConfirm";

// The reminder when notes that some of the board's people cannot see are put on it
// (lib/boardCardAudience). It is the sidebar's move-to-another-space confirmation, with a third
// choice, 「照樣放」, and a title that says what is going on. Mounted once (BuilderWorkspace).
export default function BoardCardAudienceConfirm() {
  const t = useT();
  const review = useCardAudienceReview();
  if (!review) return null;
  const { hidden, to, preview, answer } = review;
  const [first, ...rest] = hidden.map((h) => h.node);
  const title = hidden.length === 1
    ? t("This card is in “{space}”; the other people on the board can't see it", { space: hidden[0]!.from })
    : t("{n} of these cards can't be seen by the board's other people", { n: hidden.length });
  return (
    <MoveToSpaceConfirm
      node={first!} alsoMove={rest} to={to} parentTitle={null} knownPreview={preview}
      title={title} wrapTitle backLabel={t("Cancel")} moveLabel={t("Move to this space")}
      detail={hidden.length === 1
        ? <p className="move-to-hint-line">{t("Once placed, only the people who can see “{title}” will see its card.", { title: displayTitle(first!.title) })}</p>
        : <ul className="move-to-hint-line">{hidden.map(({ node, from }) => <li key={node.id}>{t("“{title}” — in {space}", { title: displayTitle(node.title), space: from })}</li>)}</ul>}
      secondaryAction={{ label: t("Place anyway"), onClick: () => answer("keep") }}
      onBack={() => answer("cancel")} onClose={() => answer("cancel")} onMoved={(moved) => answer("move", moved)}
    />
  );
}
