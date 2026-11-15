import { useEffect, useState, type ReactNode } from "react";
import type { ContentNode } from "../lib/api";
import { addToast } from "../lib/appStore";
import { writeErrors } from "../lib/data";
import { useT } from "../lib/i18n";
import { moveToSpace } from "../lib/moveToSpace";
import { openSpacesAndMembers } from "../lib/settingsRequest";
import { spaceApi, spaceLabel, type MovePreviewNumericEpoch, type Space } from "../lib/spaces";
import { Sheet, Button } from "./ui";
import MovePreviewSummary from "./MovePreviewSummary";
import "./ConfirmDialog.css";
import "./MoveToDialog.css";

// The confirmation before a note leaves for another space, shared by the note menu's
// 「移動到…」 (MoveToDialog) and the sidebar drag onto another space (useSidebarDrag):
// it looks up who gains and loses sight of the note (spaceApi.previewMove), shows that
// (MovePreviewSummary), and moves (moveToSpace) only on 「移動」. `onBack` leaves it unmoved.
// The board's card reminder (lib/boardCardAudience) reuses it: `knownPreview` (already looked up),
// `alsoMove` (more notes, one confirm), `detail` (what the reminder is about) and `secondaryAction`
// (「照樣放」: leave the note where it is) are all optional; without them it is the sidebar's.
export default function MoveToSpaceConfirm({ node, to, parentTitle, title, backLabel, onBack, onMoved, onClose, knownPreview, alsoMove, detail, secondaryAction, moveLabel, wrapTitle }: {
  node: ContentNode;
  to: Space;
  /** The note it will sit under in `to`; null: the space's top level. */
  parentTitle: string | null;
  title: string;
  backLabel: string;
  onBack: () => void;
  /** The note is in `to` now (at its top level). `moved`: how many of `node` and `alsoMove` got there (fewer than all if one failed). */
  onMoved: (moved: number) => void;
  onClose: () => void;
  /** The audience change, when the caller already asked for it (spaceApi.previewMove / merged). */
  knownPreview?: MovePreviewNumericEpoch;
  /** Further notes that move along with `node` to `to`. */
  alsoMove?: readonly ContentNode[];
  /** Shown above the audience summary. */
  detail?: ReactNode;
  /** A third choice between going back and moving; it does not move anything itself. */
  secondaryAction?: { label: string; onClick: () => void };
  moveLabel?: string;
  /** Let a long title wrap instead of being cut (a sentence, not a note title). */
  wrapTitle?: boolean;
}) {
  const t = useT();
  const [preview, setPreview] = useState<MovePreviewNumericEpoch | null>(knownPreview ?? null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (knownPreview) return;
    let cancelled = false;
    spaceApi.previewMove(node.id, to.id).then(
      (next) => { if (!cancelled) setPreview(next); },
      (error) => { if (!cancelled) { writeErrors.report(error, addToast); onBack(); } },
    );
    return () => { cancelled = true; };
    // onBack only reacts to a failure of this very request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, to.id]);

  const ids = [node.id, ...(alsoMove ?? []).map((other) => other.id)];

  async function move(seen: MovePreviewNumericEpoch) {
    setBusy(true);
    try {
      const { moved, freshPreview } = await moveToSpace(alsoMove?.length ? ids : node.id, to.id, alsoMove?.length ? undefined : seen);
      if (moved > 0) onMoved(moved);
      // A changed audience (409) needs a fresh look before trying again.
      else if (freshPreview !== undefined) { if (freshPreview) setPreview(freshPreview); else onBack(); }
    } finally { setBusy(false); }
  }

  return (
    <Sheet label={title} className="move-to-layer" cardClassName="move-to-dialog" busy={busy} onClose={onClose}>
      <div className={wrapTitle ? "move-to-heading move-to-heading-wrap" : "move-to-heading"}>{title}</div>
      <div className="move-to-confirm">
        <p className="move-to-destination">{t("Moving to: {where}", { where: `${spaceLabel(to)} › ${parentTitle ?? t("Top level")}` })}</p>
        {detail}
        {preview ? <MovePreviewSummary preview={preview} onManageSpace={(id) => { onClose(); openSpacesAndMembers(id); }} />
          : <p className="move-to-hint-line" role="status">{t("Checking who can see it…")}</p>}
      </div>
      <div className="confirm-dialog-actions">
        <Button type="button" variant="secondary" disabled={busy} onClick={onBack}>{backLabel}</Button>
        {secondaryAction && <Button type="button" variant="secondary" disabled={busy} onClick={secondaryAction.onClick}>{secondaryAction.label}</Button>}
        <Button type="button" variant="primary" disabled={busy || !preview} onClick={() => preview && void move(preview)}>
          {busy ? t("Moving…") : (moveLabel ?? t("Move"))}
        </Button>
      </div>
    </Sheet>
  );
}
