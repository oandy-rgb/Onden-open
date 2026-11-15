import { Button } from "../../components/ui";
import { useT } from "../../lib/i18n";
import type { usePublishMove } from "./usePublishMove";

/** The question before a move into a publishing space: who gains access. */
export default function PublishMoveConfirm({ count, mover }: { count: number; mover: ReturnType<typeof usePublishMove> }) {
  const t = useT();
  if (!mover.gain) return null;
  return (
    <div className="publish-left-out-confirm" role="status">
      <p>{t("Move {n} notes to “{space}” so they can be published?", { n: count, space: mover.destinationName })}</p>
      <p className="publish-review-hint">
        {mover.gain.length > 0
          ? t("These people will be able to see them: {names}", { names: mover.gain.map((m) => m.name).join("、") })
          : t("No one new will be able to see them.")}
      </p>
      <div className="publish-left-out-actions">
        <Button variant="primary" disabled={mover.working} onClick={() => void mover.move()}>{mover.working ? t("Moving…") : t("Move")}</Button>
        <Button variant="ghost" disabled={mover.working} onClick={mover.cancel}>{t("Cancel")}</Button>
      </div>
    </div>
  );
}
