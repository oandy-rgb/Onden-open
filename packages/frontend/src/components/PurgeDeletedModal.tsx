// History › 已刪除的筆記 › 永久刪除: the confirmation for deleting one deleted
// note for good (backend services/nodeTrash.ts purgeDeleted). It lists what
// goes — the note, the deleted notes under it, its checklist items, the
// files only these notes use, their saved versions and field values — and
// says plainly that History cannot bring it back. The person types the
// note's title to confirm; a live note under it (D111 keeps there being none)
// explains and offers no button. The purge sends back the ids shown, so the
// server refuses rather than take more than was confirmed.

import { useEffect, useId, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useT , tn } from "../lib/i18n";
import { notePurge, writeErrors } from "../lib/data";
import { ApiError } from "../lib/api";
import { Button, FieldError, Modal, TextField } from "./ui";
import { displayTitle } from "../lib/noteLabel";
import "./PurgeDeletedModal.css";
import type { PurgePreview } from "@onden/contract";

type Props = {
  nodeId: string;
  onClose: () => void;
  /** After the server deleted it (or had already): reload the list. */
  onPurged: () => void;
};

export default function PurgeDeletedModal({ nodeId, onClose, onPurged }: Props) {
  const t = useT();
  const inputId = useId();
  const [preview, setPreview] = useState<PurgePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setPreview(null);
    setLoadError(null);
    setTyped("");
    notePurge.preview(nodeId).then(setPreview, (e: unknown) => setLoadError(writeErrors.message(e)));
  };
  useEffect(load, [nodeId]);

  const title = preview?.node.title.trim() ?? "";
  // An untitled note is confirmed by typing the action's name instead.
  const confirmWord = title || t("Delete for good");
  const blocked = (preview?.live_descendants.length ?? 0) > 0;
  const confirmed = typed.trim() === confirmWord;

  async function purge() {
    if (!preview || !confirmed || blocked || busy) return;
    setBusy(true);
    setError(null);
    try {
      await notePurge.purge(preview);
      onPurged();
    } catch (e) {
      // Gone already (a retry after a lost answer, another device): done.
      if (e instanceof ApiError && e.status === 404) { onPurged(); return; }
      if (e instanceof ApiError && e.status === 409 && e.code === "plan_changed") {
        setError(t("What would be deleted changed since you looked. Check again."));
        load();
      } else {
        setError(writeErrors.message(e));
      }
    } finally {
      setBusy(false);
    }
  }

  const counts = preview ? [
    preview.tasks > 0 && tn("1 checklist item", "{n} checklist items", preview.tasks),
    preview.media.images > 0 && tn("1 image used only here", "{n} images used only here", preview.media.images),
    preview.media.files > 0 && tn("1 attached file used only here", "{n} attached files used only here", preview.media.files),
    preview.versions > 0 && tn("1 saved version", "{n} saved versions", preview.versions),
    preview.attributes > 0 && tn("1 field value", "{n} field values", preview.attributes),
  ].filter((line): line is string => typeof line === "string") : [];

  return (
    <Modal label={t("Delete for good")} role="alertdialog" className="confirm-dialog-backdrop" busy={busy} onClose={onClose}>
      <div className="confirm-dialog purge-dialog" data-testid="purge-dialog">
        <h3 className="confirm-dialog-title">
          {preview ? t("Delete “{title}” for good?", { title: displayTitle(title) }) : t("Delete for good")}
        </h3>
        {loadError && <p className="confirm-dialog-message" role="alert">{loadError}</p>}
        {!preview && !loadError && <p className="confirm-dialog-message">{t("Loading…")}</p>}
        {preview && (
          <>
            <p className="purge-dialog-warning">
              <AlertTriangle size={14} aria-hidden="true" />
              <span>{t("This cannot be undone from History. The note and everything listed below are removed from the server, with their saved versions.")}</span>
            </p>
            {preview.subtree.length > 0 && (
              <div className="purge-dialog-section">
                <p>{tn("1 note under it:", "{n} notes under it:", preview.subtree.length)}</p>
                <ul className="purge-dialog-list">
                  {preview.subtree.slice(0, 20).map((n) => <li key={n.id}>{displayTitle(n.title)}</li>)}
                  {preview.subtree.length > 20 && <li>{t("…and {n} more", { n: preview.subtree.length - 20 })}</li>}
                </ul>
              </div>
            )}
            {counts.length > 0 && (
              <div className="purge-dialog-section">
                <p>{t("Also removed:")}</p>
                <ul className="purge-dialog-list" data-testid="purge-counts">
                  {counts.map((line) => <li key={line}>{line}</li>)}
                </ul>
              </div>
            )}
            {preview.media.kept > 0 && (
              <p className="purge-dialog-note">{tn("1 file another note still uses stays.", "{n} files another note still uses stay.", preview.media.kept)}</p>
            )}
            <p className="purge-dialog-note">{t("Copies can stay in backups for a while: the server's local git backup, the nightly database and file backups until they rotate out, and any external git/GitHub or GitHub Pages history.")}</p>
            {blocked ? (
              <div className="purge-dialog-section" role="alert">
                <p>{t("A note under it is not deleted, so it cannot be deleted for good. Delete or move these first:")}</p>
                <ul className="purge-dialog-list">
                  {preview.live_descendants.map((n) => <li key={n.id}>{displayTitle(n.title)}</li>)}
                </ul>
              </div>
            ) : (
              <label className="purge-dialog-confirm" htmlFor={inputId}>
                <span>{t("Type “{word}” to confirm", { word: confirmWord })}</span>
                <TextField id={inputId} value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy}
                  autoComplete="off" spellCheck={false} />
              </label>
            )}
          </>
        )}
        {error && <FieldError>{error}</FieldError>}
        <div className="confirm-dialog-actions">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>{t("Cancel")}</Button>
          {preview && !blocked && (
            <Button type="button" variant="danger" onClick={() => void purge()} disabled={!confirmed || busy}>
              {busy ? t("Deleting…") : t("Delete for good")}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
