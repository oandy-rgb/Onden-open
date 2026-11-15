import { useEffect, useState } from "react";
import type { BridgeSaveState, BrowserAppMedia } from "@onden/markdown";
import { Button, Link, Modal } from "../components/ui";
import { copyText } from "../lib/clipboard";
import { t } from "../lib/i18n";
import { browserSummary } from "../lib/browserNetwork";
import { readBackupHabit } from "../lib/browserAppBackup";
import { diagnosticsReport, versionLabel } from "../lib/browserAppDiagnostics";
import { BUILD_ID } from "../lib/lazyWithReload";
import { storageStatus, type StorageStatus } from "../lib/storagePersist";
import type { WorkerClient } from "../lib/browserAppWorker";
import { readBrowserAppState } from "../lib/browserAppBridge";
import type { MediaServing } from "../lib/browserAppMedia";
import "./TrialNotice.css";

// A short page inside the trial version: what it is, where the notes live, how to back up and restore, what is
// missing, how to report a problem. Plain words; the copied report holds no note content (lib/browserAppDiagnostics).
// Set at build time (scripts/build-browser.mjs --report-url / --tag); empty = nothing shown / no tag.
const REPORT_URL = (import.meta.env.VITE_TRIAL_REPORT_URL as string | undefined) || "";
const VERSION_TAG = (import.meta.env.VITE_TRIAL_TAG as string | undefined) || undefined;

export default function TrialHelp({ client, save, media, onClose }: { client: WorkerClient; save: BridgeSaveState | null; media: MediaServing; onClose: () => void }) {
  const [storage, setStorage] = useState<StorageStatus>({ persistent: null, usedBytes: null, quotaBytes: null });
  const [files, setFiles] = useState<BrowserAppMedia | null>(null);
  // Read when the page opens, not when the button is pressed: copying has to happen inside the press (some browsers
  // refuse a copy that comes after a wait).
  useEffect(() => { void storageStatus().then(setStorage); void readBrowserAppState().then((state) => setFiles(state.media), () => {}); }, []);

  async function copyReport() {
    const report = diagnosticsReport({
      version: versionLabel(BUILD_ID, VERSION_TAG),
      browser: browserSummary(),
      save: save ?? client.lastSaveState(),
      storage,
      files,
      filesShown: media === "serving",
      lastBackupAt: readBackupHabit().lastBackupAt,
      now: Date.now(),
    });
    await copyText(report, { what: "text" });
  }

  return (
    <Modal label={t("Help for the trial version")} onClose={onClose}>
      <div className="trial-dialog trial-help">
        <h3 className="trial-dialog-title">{t("Help for the trial version")}</h3>
        <section>
          <h4>{t("What this is")}</h4>
          <p>{t("A trial of Onden that runs entirely in this page. You can write notes, tasks, a journal and whiteboards without signing up.")}</p>
        </section>
        <section>
          <h4>{t("Where your notes are")}</h4>
          <p>{t("Only in this browser on this device. Nothing is sent anywhere. Clearing this site's data, switching browser or device, or a browser that cleans up unused sites will remove them.")}</p>
        </section>
        <section>
          <h4>{t("Back up and restore")}</h4>
          <p>{t("Press your avatar at the top, then the line that says your notes are only in this browser, and choose Download a backup. Keep the file somewhere safe. To bring notes back, open Settings › Data and backup and choose a backup file to restore.")}</p>
        </section>
        <section>
          <h4>{t("Not in the trial")}</h4>
          <p>{t("Not in the trial: RSS, outside calendars, AI, push reminders, publishing a website, reading a web page's title.")}</p>
        </section>
        <section>
          <h4>{t("Report a problem")}</h4>
          <p>{REPORT_URL ? t("Copy the details below and send them with a sentence about what happened. Do not include private notes.") : t("Copy the details below and send them to the person who gave you this link, with a sentence about what happened.")}</p>
          {REPORT_URL && <p><Link href={REPORT_URL} target="_blank" rel="noreferrer">{t("Where to report")}</Link></p>}
          <p className="trial-dialog-note">{t("The details hold the browser, how your notes are kept and the last save time. They never include your notes.")}</p>
        </section>
        <div className="trial-dialog-actions">
          <Button type="button" onClick={() => void copyReport()}>{t("Copy details for a report")}</Button>
          <Button type="button" variant="secondary" onClick={onClose}>{t("Close")}</Button>
        </div>
      </div>
    </Modal>
  );
}
