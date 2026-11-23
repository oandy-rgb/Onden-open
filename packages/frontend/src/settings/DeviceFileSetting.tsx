// Settings › 你的資料 › 帶到另一台裝置: the device that HAS the notes makes one file for a new, empty device of the same person
// (lib/deviceFile.ts says what is in it). The other device's half is browserApp/BringNotes.tsx.
//
// What protects the notes is the SERVER: a file of all of them is only given to a request that carries a ticket from a fresh confirmation
// (components/ReconfirmDialog.tsx, the password again; the browser version, with one local person and no password, a press of the button).
// Nothing is uploaded anywhere: the file goes to disk and the person carries it.

import { useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { useT } from "../lib/i18n";
import { deviceFileHistory, reads, sizeLabel } from "../lib/data";
import { confirmDialog } from "../components/ConfirmDialog";
import { makeDeviceFile, type DeviceFileWrite } from "../lib/deviceFile";
import { useLocalOnlyStatus } from "../lib/localOnlyStatus";
import { warnBeforeLeaving } from "../lib/pageHide";
import { keepScreenAwake } from "../lib/webLock";
import { ReconfirmDialog } from "../components/ReconfirmDialog";
import { Button, FieldError, Modal } from "../components/ui";
import { DataRow } from "./DataRow";
import "./DeviceFileSetting.css";

type Step =
  | { kind: "closed" }
  | { kind: "reconfirm" }
  | { kind: "making"; bytes: number }
  | { kind: "done"; written: DeviceFileWrite }
  | { kind: "failed"; message: string; code: string | null };

export function DeviceFileSetting() {
  const tr = useT();
  const localOnly = useLocalOnlyStatus();
  const withoutPassword = localOnly?.signsInWithoutPassword === true;
  const [step, setStep] = useState<Step>({ kind: "closed" });
  // This device took its notes from a file and has none of their earlier versions: said on the row itself, before anyone tries (the owner's decision of 2026-11-23).
  // Asked of the backend (owner only; anyone else is simply not told here).
  const [noHistory, setNoHistory] = useState(false);
  const closed = step.kind === "closed";
  useEffect(() => {
    let current = true;
    reads.workspace.snapshotReadiness().then((r) => { if (current) setNoHistory(!r.ready && r.code === "join_history_missing"); }, () => undefined);
    return () => { current = false; };
  }, [closed]);

  // A page that closes half way leaves a file that is not whole; the browser asks first.
  useEffect(() => (step.kind === "making" ? warnBeforeLeaving(() => true) : undefined), [step.kind]);

  async function make(ticket: string) {
    setStep({ kind: "making", bytes: 0 });
    const release = keepScreenAwake();
    try {
      const written = await makeDeviceFile(ticket, (bytes) => setStep({ kind: "making", bytes }));
      // The person closed the place picker: nothing was asked of the server yet (the ticket is not spent), but the dialog simply confirms again.
      setStep(written === "cancelled" ? { kind: "reconfirm" } : { kind: "done", written });
    } catch (error) {
      setStep(error instanceof ApiError
        ? { kind: "failed", message: error.message, code: error.code ?? null }
        : { kind: "failed", message: tr("The file did not come out whole, so nothing usable was saved. Try again."), code: null });
    } finally {
      release();
    }
  }

  const close = () => setStep({ kind: "closed" });
  // This device took its notes from a file whose earlier versions have not all arrived: it cannot make a file until they have, or until the person stops waiting.
  async function stopWaiting() {
    if (!(await confirmDialog(tr("Stop waiting for the earlier versions? Your notes stay as they are. The earlier versions that have arrived so far are removed from this device; the other device still has all of them, and a file from it can bring them in later. Until then this device can't make a file for another one."), { confirmLabel: tr("Stop waiting") }))) return;
    try {
      await deviceFileHistory.stopWaiting();
      // the device has no earlier versions now: no file can be made until they are brought in, which the row and the refusal say
      close();
    } catch (error) {
      setStep({ kind: "failed", message: error instanceof ApiError ? error.message : tr("That did not work. Try again."), code: null });
    }
  }
  return (
    <DataRow
      title={tr("Take your notes to another device")}
      hint={tr("Saves all your notes in one file that you open on a new device of yours. The two devices will not update each other afterwards.")}
      note={noHistory
        ? `${tr("This device has no earlier versions of its notes, so it can't make a file for another device yet.")} ${tr("Pictures and files added to notes are not in the file yet.")}`
        : tr("Pictures and files added to notes are not in the file yet.")}
      action={<Button type="button" variant="secondary" onClick={() => setStep({ kind: "reconfirm" })}>{tr("Make the file…")}</Button>}
    >
      {step.kind === "reconfirm" && (
        <ReconfirmDialog
          purpose="snapshot_export"
          title={tr("Take your notes to another device")}
          confirmLabel={withoutPassword ? tr("Make the file") : tr("Confirm and make the file")}
          withoutPassword={withoutPassword}
          onProof={make}
          onClose={close}
          explanation={(
            <>
              <p>{tr("This makes one file with all your notes, tags, tasks and views. Open it on a new device of yours that has no notes yet, and that device will have the same notes.")}</p>
              <p>{tr("It is a copy: after that the two devices do not update each other. A note you change on one stays as it was on the other.")}</p>
              <p>{tr("The file is not encrypted: anyone who has it can read everything in it. Keep it like a backup, and delete it when you are done.")}</p>
              {!withoutPassword && <p>{tr("On a server with other people it also holds what you can read in shared spaces, including notes other people put there, and the members' names.")}</p>}
              <p className="device-file-fine">{tr("Pictures and files added to notes are not in the file yet.")}</p>
              {withoutPassword && <p>{tr("Press the button to confirm that you want all your notes in one file.")}</p>}
            </>
          )}
        />
      )}
      {(step.kind === "making" || step.kind === "done" || step.kind === "failed") && (
        <Modal label={tr("Take your notes to another device")} busy={step.kind === "making"} onClose={close}>
          <div className="device-file-dialog">
            <h3 className="device-file-title">{tr("Take your notes to another device")}</h3>
            {step.kind === "making" && (
              <>
                <p role="status">{tr("Making the file… {size} written so far. Keep this page open.", { size: sizeLabel(step.bytes) })}</p>
                <progress aria-label={tr("Making the file")} />
              </>
            )}
            {step.kind === "done" && (
              <>
                <p role="status">{step.written.how === "chosen-place"
                  ? tr("The file is saved ({size}) where you chose.", { size: sizeLabel(step.written.bytes) })
                  : tr("The file ({size}) was handed to your browser to download. Check that the download finished before you rely on it.", { size: sizeLabel(step.written.bytes) })}</p>
                <p>{tr("From now on, what you write on either device stays only on that device, until the two can exchange changes.")}</p>
                <p>{tr("Carry it to the new device by any way you like. There, open Onden's browser version and choose “Bring notes from another device”.")}</p>
                <div className="device-file-actions"><Button type="button" onClick={close}>{tr("Done")}</Button></div>
              </>
            )}
            {step.kind === "failed" && (
              <>
                <FieldError>{step.message}</FieldError>
                {step.code === "snapshot_foreign_origin" && <p>{tr("Make the file on the device your notes came from first.")}</p>}
                {step.code === "snapshot_source_history_missing" && (
                  <>
                    <p>{localOnly?.bringNotes
                      ? tr("Bring in the earlier versions from a file made on the device the notes came from. Then the file can be made.")
                      : tr("Once the earlier versions are brought in from the device the notes came from, the file can be made.")}</p>
                    {localOnly?.bringNotes && <div className="device-file-actions"><Button type="button" onClick={() => { close(); localOnly.bringNotes?.(); }}>{tr("Bring in the earlier versions…")}</Button></div>}
                  </>
                )}
                {step.code === "snapshot_source_history_incomplete" && (
                  <>
                    <p>{localOnly?.bringNotes
                      ? tr("Give this device the same file again to bring in the rest of the earlier versions, or stop waiting for them. Then the file can be made.")
                      : tr("Once the rest of the earlier versions are here, or once you stop waiting for them, the file can be made.")}</p>
                    <div className="device-file-actions">
                      {localOnly?.bringNotes && <Button type="button" onClick={() => { close(); localOnly.bringNotes?.(); }}>{tr("Bring in the earlier versions…")}</Button>}
                      <Button type="button" variant="secondary" onClick={() => void stopWaiting()}>{tr("Stop waiting for the earlier versions")}</Button>
                    </div>
                  </>
                )}
                <div className="device-file-actions">
                  {/* confirming again cannot help while the earlier versions are still arriving: the two ways out are above */}
                  {step.code !== "snapshot_source_history_incomplete" && step.code !== "snapshot_source_history_missing" && <Button type="button" onClick={() => setStep({ kind: "reconfirm" })}>{tr("Confirm again")}</Button>}
                  <Button type="button" variant="secondary" onClick={close}>{tr("Cancel")}</Button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
    </DataRow>
  );
}
