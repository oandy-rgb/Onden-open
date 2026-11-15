// Settings › Spaces › 刪除這個空間: what deleting a shared space meets
// (backend services/spaces.ts previewSpaceDelete). Notes that are not deleted
// block it, as before. Deleted notes no longer do: the dialog lists them and
// the manager chooses — 「一起永久刪除」 (deleted for good with the space, the
// same erasure as History's 永久刪除; confirmed by typing the space's name) or
// 「搬到我的個人空間」 (still deleted, still restorable from History).

import { useEffect, useId, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useT } from "../lib/i18n";
import { addToast } from "../lib/appStore";
import { writeErrors } from "../lib/data";
import { ApiError } from "../lib/api";
import { refreshSpaces, spaceApi, spaceLabel, type Space } from "../lib/spaces";
import { Button, FieldError, Modal, Radio, TextField } from "../components/ui";
import { displayTitle } from "../lib/noteLabel";
import "../components/PurgeDeletedModal.css";
import type { DeletedNotesChoice, SpaceDeletePreview } from "@onden/contract";

type Props = { space: Space; onClose: () => void };

export default function SpaceDeleteDialog({ space, onClose }: Props) {
  const t = useT();
  const inputId = useId();
  const [preview, setPreview] = useState<SpaceDeletePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState<DeletedNotesChoice | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = spaceLabel(space);

  const load = () => {
    spaceApi.deletePreview(space.id).then(setPreview, (e: unknown) => setLoadError(writeErrors.message(e)));
  };
  useEffect(load, [space.id]);

  const blocked = (preview?.live_notes ?? 0) > 0 || (preview?.subscriptions ?? 0) > 0;
  const hasDeleted = (preview?.deleted_count ?? 0) > 0;
  const ready = preview !== null && !blocked
    && (!hasDeleted || choice === "move" || (choice === "purge" && typed.trim() === name));

  async function remove() {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await spaceApi.remove(space.id, hasDeleted ? choice ?? undefined : undefined, preview?.deleted_ids);
      await refreshSpaces();
      addToast(t("Space deleted."), "success");
      onClose();
    } catch (e) {
      setError(writeErrors.message(e));
      // More notes were deleted there since the list was shown: show the new list.
      if (e instanceof ApiError && e.status === 409 && e.code === "plan_changed") { setTyped(""); load(); }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal label={t("Delete space")} role="alertdialog" className="confirm-dialog-backdrop" busy={busy} onClose={onClose}>
      <div className="confirm-dialog purge-dialog" data-testid="space-delete-dialog">
        <h3 className="confirm-dialog-title">{t("Delete the space “{name}”?", { name })}</h3>
        {loadError && <p className="confirm-dialog-message" role="alert">{loadError}</p>}
        {!preview && !loadError && <p className="confirm-dialog-message">{t("Loading…")}</p>}
        {preview && preview.live_notes > 0 && (
          <p className="confirm-dialog-message" role="alert">
            {t("This space still has {n} note(s) that are not deleted. Move or delete them first.", { n: preview.live_notes })}
          </p>
        )}
        {preview && preview.subscriptions > 0 && (
          <p className="confirm-dialog-message" role="alert">
            {t("This space still has {n} subscription(s). Move them to another space or unsubscribe first.", { n: preview.subscriptions })}
          </p>
        )}
        {preview && !blocked && !hasDeleted && (
          <p className="confirm-dialog-message">{t("Nothing is left in it. Its members will no longer see it.")}</p>
        )}
        {preview && !blocked && hasDeleted && (
          <>
            <p className="confirm-dialog-message">
              {t("It still holds {n} deleted note(s). Choose what happens to them:", { n: preview.deleted_count })}
            </p>
            <ul className="purge-dialog-list">
              {preview.deleted_notes.slice(0, 20).map((n) => <li key={n.id}>{displayTitle(n.title)}</li>)}
              {preview.deleted_notes.length > 20 && <li>{t("…and {n} more", { n: preview.deleted_notes.length - 20 })}</li>}
            </ul>
            <fieldset className="space-delete-choices">
              <label>
                <Radio name={`${inputId}-choice`} checked={choice === "move"} disabled={busy || !preview.can_move_to_personal}
                  onChange={() => setChoice("move")} />
                <span>
                  <strong>{t("Move them to my personal space")}</strong>
                  <small>{preview.can_move_to_personal
                    ? t("They stay deleted and can still be restored from History, by you only.")
                    : t("You have no personal space to move them to.")}</small>
                </span>
              </label>
              <label>
                <Radio name={`${inputId}-choice`} checked={choice === "purge"} disabled={busy}
                  onChange={() => setChoice("purge")} />
                <span>
                  <strong>{t("Delete them for good too")}</strong>
                  <small>{t("They are removed from the server with their saved versions. This cannot be undone from History.")}</small>
                </span>
              </label>
            </fieldset>
            {choice === "purge" && (
              <>
                <p className="purge-dialog-warning">
                  <AlertTriangle size={14} aria-hidden="true" />
                  <span>{t("This cannot be undone from History.")}</span>
                </p>
                <p className="purge-dialog-note">{t("Copies can stay in backups for a while: the server's local git backup, the nightly database and file backups until they rotate out, and any external git/GitHub or GitHub Pages history.")}</p>
                <label className="purge-dialog-confirm" htmlFor={inputId}>
                  <span>{t("Type “{word}” to confirm", { word: name })}</span>
                  <TextField id={inputId} value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy}
                    autoComplete="off" spellCheck={false} />
                </label>
              </>
            )}
          </>
        )}
        {error && <FieldError>{error}</FieldError>}
        <div className="confirm-dialog-actions">
          <Button variant="secondary" onClick={onClose} disabled={busy}>{t("Cancel")}</Button>
          {preview && !blocked && (
            <Button variant="danger" onClick={() => void remove()} disabled={!ready || busy}>
              {busy ? t("Deleting…") : t("Delete space")}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
