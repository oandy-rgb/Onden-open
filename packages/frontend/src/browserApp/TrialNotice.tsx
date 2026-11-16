import { shouldUrgeHomeScreen } from "../lib/browserAppInstall";
import { homeScreenEnv } from "../lib/browserNetwork";
import { Suspense, useEffect, useState } from "react";
import type { BridgeSaveState } from "@onden/markdown";
import { confirmDialog } from "../components/ConfirmDialog";
import { Button, Modal } from "../components/ui";
import { addToast } from "../lib/appStore";
import { reloadPage } from "../lib/api";
import { t } from "../lib/i18n";
import { announceDownload, deletePageDatabases, readBrowserAppState, removeSampleNotes } from "../lib/browserAppBridge";
import {
  backupDue, trialBackupFileName, backupFolderName, canBackupToFolder, chooseBackupFolder, makeBackupBlob, noteBackupMade,
  noteFirstSeen, noteSave, readBackupHabit, writeBackupToFolder, type BackupHabit,
} from "../lib/browserAppBackup";
import { recordIssue } from "../lib/browserAppDiagnostics";
import { downloadBlob } from "../lib/download";
import { forgetNotesMark, markNotesKept } from "../lib/browserAppDataMark";
import { openSettings } from "../lib/settingsRequest";
import { requestPersistentStorage, storageStatus, type StorageStatus } from "../lib/storagePersist";
import type { WorkerClient } from "../lib/browserAppWorker";
import type { MediaServing } from "../lib/browserAppMedia";
import { lazyWithReload } from "../lib/lazyWithReload";
import { setLocalOnlyStatus } from "../lib/localOnlyStatus";
import "./TrialNotice.css";

const TrialHelp = lazyWithReload(() => import("./TrialHelp"));

/** "Saved a moment ago" in the person's words; the exact seconds do not matter to them. */
function savedLine(state: BridgeSaveState | null): string {
  if (!state) return t("Starting…");
  if (state.store === "none") return t("This browser gave no place to keep your notes. Nothing is saved once you close the page: download a backup.");
  if (state.failed) return t("Your latest changes could not be saved in this browser (it may be full). Download a backup now.");
  if (state.unsaved) return t("Saving your latest changes in this browser…");
  return t("Everything is saved in this browser.");
}

/** The short line where the app shows its save status (account menu, phone menu): calm, or what to act on. */
function statusLine(state: BridgeSaveState | null): string {
  if (state?.unsaved) return t("Only in this browser · saving…");
  return t("Only in this browser · saved");
}
function troubleLine(state: BridgeSaveState | null, due: ReturnType<typeof backupDue>): string | null {
  if (state?.store === "none") return t("This browser keeps nothing · download a backup");
  if (state?.failed) return t("Not saved in this browser · download a backup");
  if (due.due) return t("Time to download a backup");
  return null;
}

function storageLine(storage: StorageStatus): string {
  if (storage.persistent === true) return t("The browser agreed to keep this site's data, even when space runs low.");
  if (storage.persistent === false) return t("The browser has not agreed to keep this site's data when space runs low. Back up to be safe.");
  return t("This browser does not say whether it will keep this site's data. Back up to be safe.");
}

function backupLine(habit: BackupHabit, due: ReturnType<typeof backupDue>): string {
  if (habit.lastBackupAt === null) return t("You have not made a backup yet.");
  return due.daysSince === 0 ? t("Last backup: today.") : t("Last backup: {n} days ago.", { n: due.daysSince ?? 0 });
}

export default function TrialNotice({ client, recovered, upgraded, media, notesLost }: { client: WorkerClient; recovered: number; upgraded: number; media: MediaServing; notesLost: boolean }) {
  const [open, setOpen] = useState(false);
  const [lostNotice, setLostNotice] = useState(notesLost);
  const [save, setSave] = useState<BridgeSaveState | null>(client.lastSaveState());
  const [samples, setSamples] = useState(0);
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  const [habit, setHabit] = useState<BackupHabit>(readBackupHabit);
  const [storage, setStorage] = useState<StorageStatus>({ persistent: null, usedBytes: null, quotaBytes: null });
  const [folder, setFolder] = useState<string | null>(null);
  const [folderNeedsTap, setFolderNeedsTap] = useState(false);
  const refreshHabit = () => setHabit(readBackupHabit());

  // Once at start: say what the start did to the saved copy, and start the "never backed up" clock. The very first
  // visit also says, once, where the notes live and where to find this (owner, 2026-11-02: no standing badge).
  useEffect(() => {
    if (readBackupHabit().firstSeenAt === null) addToast(t("This trial keeps your notes only in this browser. Your avatar at the top has backup and help."), "info");
    noteFirstSeen(Date.now());
    refreshHabit();
    if (upgraded > 0) addToast(t("Your notes were brought up to date for this new version."), "success");
    if (recovered > 0) addToast(t("{n} change(s) you made just before the page closed were recovered.", { n: recovered }), "success");
    void backupFolderName().then(setFolder).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A saved copy that held new changes counts toward the reminder; a failure goes to the report list.
  useEffect(() => client.onSaveState((state) => {
    setSave((previous) => {
      if (state.lastSavedAt !== null && state.lastSavedAt !== previous?.lastSavedAt) { noteSave(); refreshHabit(); void markNotesKept(); }
      if (state.failed && !previous?.failed) recordIssue("存檔失敗（瀏覽器拒絕寫入）");
      return state;
    });
  }), [client]);

  const due = backupDue(habit, Date.now());
  // The reminder, once per visit: a toast, plus the attention colour on the button below.
  const [reminded, setReminded] = useState(false);
  useEffect(() => {
    if (!due.due || reminded) return;
    setReminded(true);
    addToast(due.neverBackedUp ? t("You haven't downloaded a backup yet. Your avatar at the top has the backup.") : t("It has been {n} days since your last backup. Your avatar at the top has the backup.", { n: due.daysSince ?? 0 }), "info");
  }, [due.due, due.neverBackedUp, due.daysSince, reminded]);
  // On an iPad or iPhone outside the Home Screen the notes can be cleared while the app stays closed; say so once per visit,
  // whether or not a backup is due (the dialog repeats it with the steps).
  const [urged, setUrged] = useState(false);
  useEffect(() => {
    if (urged || !shouldUrgeHomeScreen(homeScreenEnv())) return;
    setUrged(true);
    addToast(t("Safari may clear these notes after seven days without a visit. Add Onden to the Home Screen to keep them; your avatar at the top has the steps."), "info");
  }, [urged]);

  useEffect(() => {
    if (!open) return;
    void readBrowserAppState().then((state) => setSamples(state.sampleNotes)).catch(() => {});
    void storageStatus().then(setStorage);
  }, [open, save]);

  async function download() {
    setBusy(true);
    try {
      const now = Date.now();
      const name = trialBackupFileName(now);
      downloadBlob(await makeBackupBlob(), name);
      noteBackupMade(now);
      refreshHabit();
      announceDownload(name);
    } catch {
      recordIssue("備份失敗");
      addToast(t("The backup could not be made. Try again."), "error");
    } finally {
      setBusy(false);
    }
  }

  async function backupToFolder(askPermission: boolean) {
    setBusy(true);
    try {
      const now = Date.now();
      const result = await writeBackupToFolder(await makeBackupBlob(), now, askPermission);
      if (result === "saved") {
        noteBackupMade(now);
        refreshHabit();
        setFolderNeedsTap(false);
        addToast(t("Backup saved in the folder."), "success");
      } else {
        setFolderNeedsTap(true);
        addToast(t("The browser needs your permission to write in that folder again. Press the folder button once more."), "info");
      }
    } catch {
      recordIssue("備份到資料夾失敗");
      addToast(t("The backup could not be made. Try again."), "error");
    } finally {
      setBusy(false);
    }
  }

  async function pickFolder() {
    try {
      if (!(await chooseBackupFolder())) return;
      setFolder(await backupFolderName());
      await backupToFolder(true);
    } catch {
      addToast(t("That folder could not be used. Choose another one."), "error");
    }
  }

  async function keepStorage() {
    const granted = await requestPersistentStorage();
    setStorage(await storageStatus());
    if (granted !== true) addToast(t("The browser did not agree. Keep downloading backups."), "info");
  }

  async function clearSamples() {
    const ok = await confirmDialog(t("Remove the sample notes for good? Their tags go to the trash. Notes you wrote yourself stay."), { confirmLabel: t("Remove"), danger: true });
    if (!ok) return;
    setBusy(true);
    try {
      if (!(await removeSampleNotes())) throw new Error("clear failed");
      setSamples(0);
      addToast(t("The sample notes are gone."), "success");
      setTimeout(reloadPage, 600);
    } catch {
      addToast(t("The sample notes could not be removed. Try again."), "error");
    } finally {
      setBusy(false);
    }
  }

  async function startOver() {
    const ok = await confirmDialog(t("Erase all notes in this browser and start again with the sample notes? This cannot be undone."), { confirmLabel: t("Erase and start over"), danger: true });
    if (!ok) return;
    setBusy(true);
    await client.reset();
    // The page's own copy of the notes (the offline mirror) goes too, or it would show what was erased. Settings such as
    // the theme stay.
    try { await deletePageDatabases(); } catch { /* a browser that will not list its databases: the reload still starts from the packaged notes */ }
    await forgetNotesMark(); // the person's own choice: the next start is not "the notes went missing"
    reloadPage();
  }

  const homeScreen = shouldUrgeHomeScreen(homeScreenEnv());
  const attention = save?.failed || save?.store === "none" || due.due || homeScreen;
  // No badge of its own: the app's save line (account menu, phone menu) says where the notes are and opens this;
  // a problem shows on the avatar like any other saving trouble.
  const line = statusLine(save);
  const trouble = troubleLine(save, due);
  useEffect(() => {
    setLocalOnlyStatus({ label: line, trouble, open: () => setOpen(true) });
  }, [line, trouble]);
  useEffect(() => () => setLocalOnlyStatus(null), []);
  return (
    <>
      {lostNotice && (
        <Modal label={t("Your notes are gone from this browser")} onClose={() => setLostNotice(false)}>
          <div className="trial-dialog">
            <h3 className="trial-dialog-title">{t("Your notes are gone from this browser")}</h3>
            <p>{t("This browser kept your notes before, but they are not here now. Clearing this site's data, or the browser cleaning up, does that. What you see now is the sample notes.")}</p>
            <p>{t("If you downloaded a backup, you can put your notes back from it.")}</p>
            <div className="trial-dialog-actions">
              <Button type="button" onClick={() => { setLostNotice(false); openSettings("data"); }}>{t("Restore from a backup")}</Button>
              <Button type="button" variant="secondary" onClick={() => setLostNotice(false)}>{t("Not now")}</Button>
            </div>
          </div>
        </Modal>
      )}
      {open && (
        <Modal label={t("Trial version")} onClose={() => setOpen(false)} busy={busy}>
          <div className="trial-dialog">
            <h3 className="trial-dialog-title">{t("Trial: your notes are kept only in this browser")}</h3>
            <p>{t("There is no server and no account. Switching device or browser, or clearing this site's data, makes the notes disappear. Download a backup of anything you want to keep.")}</p>
            <p className={`trial-dialog-status${attention ? " trial-dialog-status--attention" : ""}`} role="status">{savedLine(save)}</p>
            <p className="trial-dialog-line">{storageLine(storage)}</p>
            {storage.persistent !== true && storage.persistent !== null && (
              <Button type="button" variant="secondary" onClick={() => void keepStorage()}>{t("Ask the browser to keep my notes")}</Button>
            )}
            {homeScreen && (
              <p className="trial-dialog-line trial-dialog-status--attention">{t("On an iPad or iPhone, Safari may clear these notes after seven days without opening this page. Add Onden to the Home Screen to prevent that: tap the Share button, then “Add to Home Screen”, and open Onden from there.")}</p>
            )}
            <p className={`trial-dialog-line${due.due ? " trial-dialog-status--attention" : ""}`}>{backupLine(habit, due)}</p>
            <div className="trial-dialog-actions">
              <Button type="button" onClick={() => void download()} disabled={busy}>{t("Download a backup")}</Button>
              {canBackupToFolder() && !folder && <Button type="button" variant="secondary" onClick={() => void pickFolder()} disabled={busy}>{t("Back up to a folder…")}</Button>}
              {canBackupToFolder() && folder && (
                <Button type="button" variant="secondary" onClick={() => void backupToFolder(true)} disabled={busy}>
                  {folderNeedsTap ? t("Allow and back up to \"{name}\"", { name: folder }) : t("Back up now to \"{name}\"", { name: folder })}
                </Button>
              )}
              <Button type="button" variant="secondary" onClick={() => { setOpen(false); setHelp(true); }}>{t("Help and report a problem")}</Button>
              {samples > 0 && <Button type="button" variant="secondary" onClick={() => void clearSamples()} disabled={busy}>{t("Remove the sample notes")}</Button>}
              <Button type="button" variant="secondary" onClick={() => void startOver()} disabled={busy}>{t("Start over")}</Button>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>{t("Close")}</Button>
            </div>
            <p className="trial-dialog-note">{t("Not in the trial: RSS, outside calendars, AI, push reminders, publishing a website.")}</p>
            {media !== "serving" && <p className="trial-dialog-note">{t("This browser could not set up the helper that shows uploaded pictures and files, so they will not appear here. Your notes are not affected.")}</p>}
          </div>
        </Modal>
      )}
      {help && <Suspense fallback={null}><TrialHelp client={client} save={save} media={media} onClose={() => setHelp(false)} /></Suspense>}
    </>
  );
}
