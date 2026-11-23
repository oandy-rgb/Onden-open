// The browser version, taking a file from another device: "從另一台裝置帶過來" (the device that made the file: settings/DeviceFileSetting.tsx).
// Opened on an EMPTY copy and instead of the app, so nothing writes while the file is taken in (the backend also refuses ordinary
// writes meanwhile: workspace_joining). Words are plain; no ids, codes, file formats.
//
// What can end it (docs/architecture/browser-app.md §18): taken in and saved here (then the page reloads into those notes); refused
// or cut off before the notes are all in (then this copy is empty again, the backend's guarantee, and the screen says so); a page closed
// in the middle (the next start finds the marker `joining` in browserApp/bringNotes.ts and says the same). The notes in but their earlier
// versions not all in (the file stopped in that part, or that part was refused): the screen says exactly that, never "done", and offers
// the same file again (it goes on from where it stopped) or to stop waiting for them (the notes stay). Opening the screen again on such a
// copy (BringEntry, settings) comes back to that question.

import { useEffect, useRef, useState } from "react";
import { Button, FieldError, FileInput } from "../components/ui";
import "../lib/i18n.app"; // the screen stands alone, before the app: it brings its own dictionary
import { reloadPage } from "../lib/api";
import { eraseBrowserCopy } from "../lib/browserAppBridge";
import type { JoinFileResult, WorkerClient } from "../lib/browserAppWorker";
import { deviceFileRefusal, holdsSummary, isNotEmpty, type JoinHolds, type SnapshotReadiness } from "../lib/deviceFile";
import { deviceFileHistory, reads } from "../lib/data";
import { dictionariesReady, t } from "../lib/i18n";
import { keepScreenAwake } from "../lib/webLock";
import { warnBeforeLeaving } from "../lib/pageHide";
import { ensureWordingFor } from "../lib/serverErrors";
import { storageStatus, type StorageStatus } from "../lib/storagePersist";
import { sizeLabel } from "../lib/data";
import { confirmDialog } from "../components/ConfirmDialog";
import { confirmEraseEverything, joinGaveUp, joinedDevicePhase, keptBytesOf, lacksRoom, roomNeeded, writeBringState } from "./bringNotes";
import "./BrowserAppShell.css";
import "./BringNotes.css";

type Phase =
  | { kind: "checking" }
  | { kind: "make-room"; holds: JoinHolds }
  | { kind: "choose"; note: "interrupted" | "wrong-file" | "no-room" | null; need?: number; free?: number }
  | { kind: "reading"; readBytes: number; totalBytes: number }
  /** `refill`: only the earlier versions came, into notes that were here already (a device that had none of them). */
  | { kind: "done"; textOnly: boolean; leftOut: number; refill?: boolean }
  /** The notes are here; their earlier versions are not all here. `reason`: why they stopped coming, in words (none: the file stopped in that part). */
  | { kind: "notes-in"; reason: string | null; failed?: string }
  /** The person stopped waiting for the earlier versions: the notes stay. */
  | { kind: "stopped" }
  /** The notes are here and none of their earlier versions (joined before files carried them, or the person stopped waiting): a file of the device the notes came
   *  from brings only them in. `reason`: why the last file did not, in words. */
  | { kind: "no-history"; reason: string | null }
  | { kind: "failed"; message: string; empty: boolean };

/** The first line of the file says it is one Onden made (a `hello`): a wrong file is told at once, before this copy is touched. */
async function looksLikeAFileFromAnotherDevice(file: Blob): Promise<boolean> {
  const reader = file.stream().getReader();
  try {
    const { value } = await reader.read();
    const first = new TextDecoder().decode(value ?? new Uint8Array()).split("\n")[0] ?? "";
    return (JSON.parse(first) as { kind?: unknown }).kind === "hello";
  } catch {
    return false;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

const noRoomWords = (need: number, free: number): string =>
  t("This browser does not have room for it: about {need} are needed and about {free} are free. Free some space, or use a device with more room.", { need: sizeLabel(need), free: sizeLabel(free) });

async function refusalMessage(result: Extract<JoinFileResult, { ok: false }>): Promise<string> {
  await ensureWordingFor(result.error);
  if (result.error === null) return t("The file could not be read all the way.");
  return deviceFileRefusal(result.status, result.error, JSON.stringify({ error: result.error })).message;
}

export default function BringNotes({ client, interrupted, onLeave }: { client: WorkerClient; interrupted: boolean; onLeave: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [ready, setReady] = useState(false);
  const working = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let current = true;
    void (async () => {
      await dictionariesReady();
      const [readiness, status] = await Promise.all([reads.workspace.snapshotReadiness().catch((): SnapshotReadiness | null => null), storageStatus()]);
      if (!current) return;
      setStorage(status);
      setReady(true);
      // A file already filled this device (the page went away before it heard so, or the notes are in and their earlier versions are not all in):
      // the screen says what the database holds, never "nothing was kept" and never "done" while versions are still on the way.
      const joined = joinedDevicePhase(readiness);
      if (joined) {
        writeBringState(null);
        setPhase(joined);
        if (joined.kind === "done" && !joined.textOnly && joined.leftOut === 0) setTimeout(reloadPage, 3500);
      } else if (isNotEmpty(readiness)) setPhase({ kind: "make-room", holds: readiness.holds });
      else setPhase({ kind: "choose", note: interrupted ? "interrupted" : null });
    })();
    return () => { current = false; };
  }, [interrupted]);

  // While the file is read the page must not close (the notes would not be kept) and the phone should not sleep.
  const reading = phase.kind === "reading";
  useEffect(() => {
    if (!reading) return;
    const release = keepScreenAwake();
    const stop = warnBeforeLeaving(() => true);
    return () => { release(); stop(); };
  }, [reading]);

  async function leave() {
    writeBringState(null);
    onLeave();
  }

  async function eraseAndRestart() {
    if (phase.kind !== "make-room" || !(await confirmEraseEverything(phase.holds))) return;
    writeBringState("pending");
    await eraseBrowserCopy(client);
    reloadPage();
  }

  async function take(file: File) {
    if (working.current) return;
    if (!(await looksLikeAFileFromAnotherDevice(file))) { setPhase({ kind: "choose", note: "wrong-file" }); return; }
    const status = await storageStatus();
    const free = status.quotaBytes !== null && status.usedBytes !== null ? status.quotaBytes - status.usedBytes : null;
    // a device that has its notes and none of their earlier versions: the file brings only those in, the notes are not in question
    const refill = phase.kind === "no-history";
    // the room it needs is for what is kept: not the notes again on a device that has them (a refill, or the same file again for the rest)
    const kept = await keptBytesOf(file, refill || phase.kind === "notes-in");
    if (lacksRoom(kept, free)) {
      // said on the screen the device is on: a device that has its notes stays on its own question, never the empty device's
      const words = noRoomWords(roomNeeded(kept), free ?? 0);
      if (phase.kind === "no-history") setPhase({ kind: "no-history", reason: words });
      else if (phase.kind === "notes-in") setPhase({ ...phase, failed: words });
      else setPhase({ kind: "choose", note: "no-room", need: roomNeeded(kept), free: free ?? 0 });
      return;
    }
    working.current = true;
    writeBringState("joining");
    setPhase({ kind: "reading", readBytes: 0, totalBytes: file.size });
    let result: JoinFileResult;
    try {
      result = await client.joinFile(file, (readBytes, totalBytes) => setPhase({ kind: "reading", readBytes, totalBytes }));
    } catch {
      // The worker ended before it answered: the same as a page closed in the middle. The marker still says "joining", so the next start says that
      // nothing was kept; the backend leaves the empty copy either way (and a copy saved before the join is what loads).
      working.current = false;
      reloadPage();
      return;
    }
    working.current = false;
    if (result.ok) {
      writeBringState(null);
      if (result.history !== "done") {
        let reason: string | null = null;
        if (result.historyRefused) { await ensureWordingFor(result.historyRefused); reason = deviceFileRefusal(409, result.historyRefused, JSON.stringify({ error: result.historyRefused })).message; }
        setPhase(result.history === "arriving" ? { kind: "notes-in", reason } : { kind: "no-history", reason });
        return;
      }
      setPhase({ kind: "done", textOnly: result.historyScope === "body", leftOut: result.historyLeftOut, refill });
      // the screen stays when it has more to say than "here" (what of the earlier versions was left out); otherwise it opens the notes by itself
      if (result.historyScope !== "body" && result.historyLeftOut === 0) setTimeout(reloadPage, 3500);
      return;
    }
    // A refusal may come after the notes are in (a file cut or refused in its history part, a device that had no earlier versions): what the
    // screen says then is what the database holds, asked again, not a guess from the refusal.
    // Only a refusal about the earlier versions is said as the reason: the others speak of a copy that is empty again, which this one is not.
    const reason = result.error?.startsWith("join_history_") ? await refusalMessage(result) : t("The last file did not bring them all in. Give this device the whole file again.");
    const now = joinedDevicePhase(await reads.workspace.snapshotReadiness().catch((): SnapshotReadiness | null => null), reason);
    if (now) {
      writeBringState(null);
      setPhase(now.kind === "done" ? { ...now, refill } : now);
      return;
    }
    writeBringState("pending"); // an empty copy again: the next start is a plain "bring notes" screen, not "interrupted"
    if (result.error === "join_not_empty") {
      // Ask the backend what it found, with the same judgement it just refused with (counts, never text).
      const found = await reads.workspace.snapshotReadiness().catch((): SnapshotReadiness | null => null);
      if (isNotEmpty(found)) { setPhase({ kind: "make-room", holds: found.holds }); return; }
    }
    // Every way out of a failure starts again from what is saved (a reload): after "not kept" the notes are in memory only, and no screen may
    // go on from that.
    setPhase({ kind: "failed", message: await refusalMessage(result), empty: joinGaveUp(result.error) });
  }

  async function stopWaiting() {
    if (!(await confirmDialog(t("Stop waiting for the earlier versions? Your notes stay as they are. The earlier versions that have arrived so far are removed from this device; the other device still has all of them, and a file from it can bring them in later. Until then this device can't make a file for another one."), { confirmLabel: t("Stop waiting") }))) return;
    try {
      await deviceFileHistory.stopWaiting();
      setPhase({ kind: "stopped" });
    } catch (error) {
      setPhase({ kind: "notes-in", reason: phase.kind === "notes-in" ? phase.reason : null, failed: error instanceof Error ? error.message : t("That did not work. Try again.") });
    }
  }

  if (!ready) return <main className="browser-app-status bring-notes"><p>{t("Opening Onden…")}</p></main>;
  return (
    <main className="browser-app-status bring-notes" aria-busy={phase.kind === "reading"}>
      <div className="bring-notes-card">
        <h1>{phase.kind === "done" || phase.kind === "stopped" ? t("Your notes are here") : phase.kind === "notes-in" ? t("Your notes are here, their earlier versions are not all here") : phase.kind === "no-history" ? t("This device has no earlier versions") : phase.kind === "failed" ? t("The notes were not brought over") : t("Bring notes from another device")}</h1>
        {phase.kind === "checking" && <p>{t("Opening Onden…")}</p>}

        {phase.kind === "make-room" && (
          <>
            <p>{holdsSummary(phase.holds)
              ? t("This device already has content of its own, so it can't take the file without erasing it: {what}. Nothing was changed.", { what: holdsSummary(phase.holds) ?? "" })
              : t("This device has been used for more than notes, so it can't take the file without erasing what is on it. Nothing was changed.")}</p>
            <p>{t("To use this device for the file, erase what is on it first. Otherwise keep it as it is.")}</p>
            <div className="browser-app-status-actions">
              <Button type="button" onClick={() => void eraseAndRestart()}>{t("Erase everything on this device and continue")}</Button>
              <Button type="button" variant="secondary" onClick={() => void leave()}>{t("Keep this device as it is")}</Button>
            </div>
          </>
        )}

        {phase.kind === "choose" && (
          <>
            {phase.note === "interrupted" && <p className="bring-notes-bad" role="status">{t("Last time the notes were not all brought over. Nothing was kept: this device is empty and can try again.")}</p>}
            {phase.note === "wrong-file" && <FieldError>{t("That is not a file made on your other device. Choose the file you made there, under Settings › Your data.")}</FieldError>}
            {phase.note === "no-room" && <FieldError>{noRoomWords(phase.need ?? 0, phase.free ?? 0)}</FieldError>}
            <p>{t("On your other device open Settings › Your data › Take your notes to another device, make the file, carry it here and choose it below. This device will then have the same notes.")}</p>
            <p>{t("It is a copy: afterwards the two devices do not update each other. Nothing is uploaded anywhere; the file is read on this device.")}</p>
            <p className="bring-notes-fine">{t("Pictures and files added to notes are not in the file yet.")}</p>
            {storage?.persistent === false && <p className="bring-notes-fine">{t("This browser has not promised to keep this site's data when space runs low. Once the notes are here, download a backup.")}</p>}
            <FileInput ref={fileInput} hidden aria-label={t("The file from your other device")} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void take(file); }} />
            <Button type="button" onClick={() => fileInput.current?.click()}>{t("Choose the file from your other device…")}</Button>
            <Button type="button" variant="secondary" onClick={() => void leave()}>{t("Use this device on its own")}</Button>
          </>
        )}

        {phase.kind === "reading" && (
          <>
            <p role="status">{phase.totalBytes > 0 && phase.readBytes >= phase.totalBytes
              ? t("The whole file is read. Putting your notes in order… this can take a moment.")
              : t("Bringing your notes in… {percent}% of the file read ({read} of {total}).", { percent: phase.totalBytes ? Math.floor((phase.readBytes / phase.totalBytes) * 100) : 0, read: sizeLabel(phase.readBytes), total: sizeLabel(phase.totalBytes) })}</p>
            <progress aria-label={t("Bringing your notes in")} max={phase.totalBytes || 1} value={phase.readBytes} />
            <p className="bring-notes-fine">{t("Keep this page open. If it closes before the end, nothing is kept and you start again. Nothing can be changed here until it is done.")}</p>
          </>
        )}

        {phase.kind === "notes-in" && (
          <>
            <p role="status">{t("All your notes came over and you can use them. Their earlier versions did not all come: this device does not yet have every earlier version your other device has.")}</p>
            {phase.reason && <FieldError>{phase.reason}</FieldError>}
            {phase.failed && <FieldError>{phase.failed}</FieldError>}
            <p>{t("Choose the same file again to bring in the rest: what is already here is not written again. Or stop waiting for them: your notes stay.")}</p>
            <p className="bring-notes-fine">{t("Until the earlier versions are all here, a file for another device cannot be made from this one.")}</p>
            <FileInput ref={fileInput} hidden aria-label={t("The file from your other device")} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void take(file); }} />
            <div className="browser-app-status-actions">
              <Button type="button" onClick={() => fileInput.current?.click()}>{t("Choose the same file again…")}</Button>
              <Button type="button" variant="secondary" onClick={() => void stopWaiting()}>{t("Stop waiting for the earlier versions")}</Button>
              <Button type="button" variant="secondary" onClick={reloadPage}>{t("Open my notes")}</Button>
            </div>
          </>
        )}

        {phase.kind === "stopped" && (
          <>
            <p role="status">{t("This device no longer waits for the earlier versions. Your notes are here; their earlier versions are on your other device.")}</p>
            <p className="bring-notes-fine">{t("Until they are brought in, a file for another device cannot be made from this one: it would carry notes without their history.")}</p>
            <Button type="button" onClick={reloadPage}>{t("Open my notes")}</Button>
          </>
        )}

        {phase.kind === "no-history" && (
          <>
            <p role="status">{t("Your notes are here, but this device has none of their earlier versions.")}</p>
            {phase.reason && <FieldError>{phase.reason}</FieldError>}
            <p>{t("On the device the notes came from, open Settings › Your data › Take your notes to another device, make a file and choose it here. Only the earlier versions are taken from it: your notes here are not changed.")}</p>
            <p className="bring-notes-fine">{t("Until they are brought in, a file for another device cannot be made from this one: it would carry notes without their history.")}</p>
            <FileInput ref={fileInput} hidden aria-label={t("The file from your other device")} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void take(file); }} />
            <div className="browser-app-status-actions">
              <Button type="button" onClick={() => fileInput.current?.click()}>{t("Choose the file from your other device…")}</Button>
              <Button type="button" variant="secondary" onClick={reloadPage}>{t("Open my notes")}</Button>
            </div>
          </>
        )}

        {phase.kind === "done" && (
          <>
            <p role="status">{phase.refill
              ? t("The earlier versions of your notes are here now. Your notes themselves were not changed.")
              : t("This device now has everything up to the moment the file was made, with the notes' earlier versions. The two devices do not update each other yet.")}</p>
            {phase.textOnly && <p>{t("The earlier versions of handwriting were left out: this browser keeps only the earlier versions of text when the handwriting's take too much room, and a device that kept only those passes on only those. The earlier versions of your text are here.")}</p>}
            {phase.leftOut > 0 && <p>{t("{count} earlier versions were not complete on your other device, so they were not brought.", { count: phase.leftOut })}</p>}
            {!phase.refill && <p>{t("From now on, what you write on either device stays only on that device, until the two can exchange changes.")}</p>}
            <Button type="button" onClick={reloadPage}>{t("Open my notes")}</Button>
          </>
        )}

        {phase.kind === "failed" && (
          <>
            <FieldError>{phase.message}</FieldError>
            {phase.empty && <p>{t("Nothing was kept: this device is empty again.")}</p>}
            <div className="browser-app-status-actions">
              <Button type="button" onClick={reloadPage}>{t("Try again")}</Button>
              <Button type="button" variant="secondary" onClick={() => { writeBringState(null); reloadPage(); }}>{t("Use this device on its own")}</Button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
