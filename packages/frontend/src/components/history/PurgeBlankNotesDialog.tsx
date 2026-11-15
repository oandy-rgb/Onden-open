// 「全部永久刪除」 for the blank notes in 最近刪除. They have no title, no text and nothing
// under them, so one plain confirmation (no typed word) says how many go and that History
// cannot bring them back; the notes the person may not delete for good are named as left alone.
import { useT } from "../../lib/i18n";
import { Button, Modal } from "../ui";

type Props = {
  /** How many will be deleted for good. */
  count: number;
  /** Blank notes the person may not delete for good; they stay in the list. */
  skipped: number;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
};

export default function PurgeBlankNotesDialog({ count, skipped, busy, error, onConfirm, onClose }: Props) {
  const t = useT();
  return (
    <Modal label={t("Delete blank notes for good")} role="alertdialog" className="confirm-dialog-backdrop" busy={busy} onClose={onClose}>
      <div className="confirm-dialog" data-testid="purge-blank-dialog">
        <h3 className="confirm-dialog-title">{t("Delete {n} blank notes for good?", { n: count })}</h3>
        <p className="confirm-dialog-message">{t("They have no title and no text. This cannot be undone from History.")}</p>
        {skipped > 0 && <p className="confirm-dialog-message">{t("{n} more you can't delete for good stay in the list.", { n: skipped })}</p>}
        {error && <p className="confirm-dialog-message" role="alert">{error}</p>}
        <div className="confirm-dialog-actions">
          <Button variant="secondary" onClick={onClose} disabled={busy}>{t("Cancel")}</Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy || count === 0}>
            {busy ? t("Deleting…") : t("Delete {n} for good", { n: count })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
