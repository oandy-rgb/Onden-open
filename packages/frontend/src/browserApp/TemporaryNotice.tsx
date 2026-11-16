import { useEffect, useRef, useState } from "react";
import type { MediaServing } from "../lib/browserAppMedia";
import { Button, Modal } from "../components/ui";
import { addToast } from "../lib/appStore";
import { useT } from "../lib/i18n";
import { announceDownload } from "../lib/browserAppBridge";
import { makeSessionBackupBlob, trialBackupFileName } from "../lib/browserAppBackup";
import { downloadBlob } from "../lib/download";
import { warnBeforeLeaving } from "../lib/pageHide";
import { setLocalOnlyStatus } from "../lib/localOnlyStatus";
import type { WorkerClient } from "../lib/browserAppWorker";

// The temporary session's one standing notice (the app's save line in the account and phone menus, which is where the
// trial version says where the notes are): this is not kept on this computer; download before closing. Opens a short
// explanation with the download, and the browser's own "leave this page?" question guards the tab while something
// written has not been downloaded. Nothing here is written to the browser (lib/temporarySession.ts).

export default function TemporaryNotice({ client, media }: { client: WorkerClient; media: MediaServing }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Changes seen when the page opened or when the last download was made; anything beyond it was not downloaded.
  const [changes, setChanges] = useState(() => client.lastSaveState()?.changes ?? 0);
  const [downloaded, setDownloaded] = useState(changes);
  const unsent = changes > downloaded;
  const unsentNow = useRef(false);
  unsentNow.current = unsent;

  useEffect(() => client.onSaveState((state) => setChanges(state.changes)), [client]);
  useEffect(() => warnBeforeLeaving(() => unsentNow.current), []);
  useEffect(() => { addToast(t("This is a temporary session. What you write here is not kept on this computer. Download it before you close the tab."), "info"); }, [t]);

  const line = t("Temporary · not kept on this computer · everything is in your last download");
  const trouble = unsent ? t("Not kept on this computer · download before you close the tab") : null;
  useEffect(() => {
    setLocalOnlyStatus({ label: line, trouble, open: () => setOpen(true) });
  }, [line, trouble]);
  useEffect(() => () => setLocalOnlyStatus(null), []);

  async function download() {
    setBusy(true);
    try {
      const reached = changes;
      const { blob } = await makeSessionBackupBlob();
      const name = trialBackupFileName(Date.now());
      downloadBlob(blob, name);
      setDownloaded(reached);
      announceDownload(name);
    } catch {
      addToast(t("The backup could not be made. Try again."), "error");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <Modal label={t("Temporary session")} onClose={() => setOpen(false)} busy={busy}>
      <div className="trial-dialog">
        <h3 className="trial-dialog-title">{t("Temporary session: nothing stays on this computer")}</h3>
        <p>{t("What you write and the files you add here are not saved on this computer. Closing or reloading this tab removes them. Download them before you leave.")}</p>
        <p className={`trial-dialog-status${unsent ? " trial-dialog-status--attention" : ""}`} role="status">
          {unsent ? t("You have changes that are not downloaded yet.") : t("Everything you wrote is in your last download.")}
        </p>
        <p className="trial-dialog-note">{t("The download holds only what you wrote and its files. You can put it into your own Onden with Settings › Your data › Restore from a backup.")}</p>
        {media !== "serving" && <p className="trial-dialog-note">{t("This browser could not set up the helper that shows uploaded pictures and files, so they will not appear here. Your notes are not affected.")}</p>}
        <div className="trial-dialog-actions">
          <Button type="button" onClick={() => void download()} disabled={busy}>{t("Download what I wrote")}</Button>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>{t("Close")}</Button>
        </div>
      </div>
    </Modal>
  );
}
