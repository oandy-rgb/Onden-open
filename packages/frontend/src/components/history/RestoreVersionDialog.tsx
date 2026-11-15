// 「回到這個版本」 when the version's title is not the note's title now: the text comes back,
// and bringing the old title back too is one visible choice, off until the person turns it on.
import { useState } from "react";
import { useT } from "../../lib/i18n";
import { displayTitle } from "../../lib/noteLabel";
import { Button, Checkbox, Modal } from "../ui";

type Props = {
  /** The version's time as the screen shows it ("Sep 1, 8:00 AM"). */
  when: string;
  titleNow: string;
  titleThen: string;
  onConfirm: (restoreTitle: boolean) => void;
  onClose: () => void;
};

export default function RestoreVersionDialog({ when, titleNow, titleThen, onConfirm, onClose }: Props) {
  const t = useT();
  const [restoreTitle, setRestoreTitle] = useState(false);
  return (
    <Modal label={t("Go back to this version?")} role="alertdialog" className="confirm-dialog-backdrop" onClose={onClose}>
      <div className="confirm-dialog" data-testid="restore-version-dialog">
        <h3 className="confirm-dialog-title">{t("Go back to this version?")}</h3>
        <p className="confirm-dialog-message">{t("This brings back the text of {when}.", { when })}</p>
        <p className="confirm-dialog-message">
          {t("The note's title is now “{now}”. That version was titled “{then}”.", { now: displayTitle(titleNow), then: displayTitle(titleThen) })}
        </p>
        <label className="confirm-dialog-message">
          <Checkbox checked={restoreTitle} onChange={(e) => setRestoreTitle(e.target.checked)} />{" "}
          {t("Also change the title back to “{title}”", { title: displayTitle(titleThen) })}
        </label>
        <div className="confirm-dialog-actions">
          <Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="primary" onClick={() => onConfirm(restoreTitle)}>{t("Go back to this version")}</Button>
        </div>
      </div>
    </Modal>
  );
}
