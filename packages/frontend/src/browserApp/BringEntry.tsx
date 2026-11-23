// Settings › 你的資料 › 從另一台裝置帶過來, on the browser version: the way into BringNotes while the app is already open.
// A file can only be taken into a copy with nothing of its own on it (backend services/stampedJoin.ts); the BACKEND says whether this copy is
// such a copy and what taking the file would erase (GET /api/snapshot/readiness, counts by kind), and this dialog only words that. The screen that
// takes the file replaces the app (nothing writes during it), and the copy is emptied first by the same erase as "Start over".

import { useEffect, useState } from "react";
import { Button, Modal } from "../components/ui";
import { reloadPage } from "../lib/api";
import { eraseBrowserCopy } from "../lib/browserAppBridge";
import type { WorkerClient } from "../lib/browserAppWorker";
import { reads } from "../lib/data";
import { holdsSummary, isNotEmpty, type SnapshotReadiness } from "../lib/deviceFile";
import { t } from "../lib/i18n";
import { confirmEraseEverything, writeBringState } from "./bringNotes";

export default function BringEntry({ client, onClose }: { client: WorkerClient; onClose: () => void }) {
  const [readiness, setReadiness] = useState<SnapshotReadiness | "unknown" | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void reads.workspace.snapshotReadiness().then(setReadiness, () => setReadiness("unknown")); }, []);

  async function go() {
    // Whatever was found, the way in empties the whole copy: one question, the same words as the screen that takes the file.
    if (isNotEmpty(readiness) && !(await confirmEraseEverything(readiness.holds))) return;
    setBusy(true);
    writeBringState("pending");
    if (isNotEmpty(readiness)) await eraseBrowserCopy(client);
    reloadPage();
  }

  const inProgress = readiness !== null && readiness !== "unknown" && !readiness.ready && readiness.code === "join_in_progress";
  // the notes of a file are here and their earlier versions are not all here: going on is the same file again, NOT erasing this copy
  const arriving = readiness !== null && readiness !== "unknown" && !readiness.ready && readiness.code === "join_history_arriving";
  // the notes of a file are here and none of their earlier versions: going on is a file of the device they came from, which brings only those in; nothing is erased
  const noHistory = readiness !== null && readiness !== "unknown" && !readiness.ready && readiness.code === "join_history_missing";
  const found = isNotEmpty(readiness) ? holdsSummary(readiness.holds) : null;
  return (
    <Modal label={t("Bring notes from another device")} busy={busy} onClose={onClose}>
      <div className="trial-dialog">
        <h3 className="trial-dialog-title">{t("Bring notes from another device")}</h3>
        {readiness === null && <p>{t("Starting…")}</p>}
        {inProgress && <p>{t("Notes are already being brought to this device.")}</p>}
        {readiness === "unknown" && <p>{t("This device could not be checked right now. Try again in a moment.")}</p>}
        {(arriving || noHistory) && (
          <>
            <p>{arriving
              ? t("The notes from your other device are here, but their earlier versions have not all arrived. Continue to choose the same file again, or to stop waiting for them.")
              : t("This device has no earlier versions of its notes. Continue to choose a file made on the device the notes came from: only the earlier versions are taken from it.")}</p>
            <div className="trial-dialog-actions">
              <Button type="button" onClick={() => { setBusy(true); writeBringState("pending"); reloadPage(); }} disabled={busy}>{t("Continue")}</Button>
              <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>{t("Cancel")}</Button>
            </div>
          </>
        )}
        {readiness !== null && readiness !== "unknown" && !inProgress && !arriving && !noHistory && (
          <>
            {readiness.ready
              ? <p>{t("This device has nothing of its own on it yet, so it can take the file you made on your other device.")}</p>
              : (
                <>
                  <p>{found ? t("This device already has content of its own: {what}. To take the file, everything on it is erased first.", { what: found }) : t("This device has been used for more than notes. To take the file, everything on it is erased first.")}</p>
                  <p>{t("If you want to keep what is on this device, close this.")}</p>
                </>
              )}
            <p>{t("Afterwards the two devices do not update each other.")}</p>
            <div className="trial-dialog-actions">
              <Button type="button" onClick={() => void go()} disabled={busy}>{readiness.ready ? t("Continue") : t("Erase everything and continue")}</Button>
              <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>{t("Cancel")}</Button>
            </div>
          </>
        )}
        {(inProgress || readiness === "unknown") && <div className="trial-dialog-actions"><Button type="button" variant="secondary" onClick={onClose}>{t("Close")}</Button></div>}
      </div>
    </Modal>
  );
}
