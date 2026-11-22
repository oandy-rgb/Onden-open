// Settings › 你的資料 › 完整備份: the backup a person makes themselves
// (GET /api/backup/full.zip, backend services/backupArchive.ts). One zip that
// opens as a Markdown vault and that Onden can restore. What it holds is
// what the person may read; the hint says so, and what it leaves out.
//
// 從備份還原: upload the zip, pick a space and a mode, read the preview
// (counts, notes whose current version is kept and the backup's added as a
// copy, title clashes), then restore. The restore runs on the server as a
// job; this page polls it and shows a progress bar. It is one event: History
// can undo it with the changes it caused.
//
// 搬整個工作區: a third choice, offered only when the server says this workspace
// is new and the person owns it (the preview in mode "workspace" has no refusal).
// It restores into the person's own space, makes the backup's spaces again and
// carries their progress and settings; the result says who to invite again and
// what was not moved.

import { useEffect, useRef, useState } from "react";
import { getApiBase } from "../lib/api";
import { useT } from "../lib/i18n";
import { dateLabel, timeLabel } from "../lib/timeLabels";
import { backupLimits, backupRestore, sizeLabel, writeErrors, type UploadedBackup } from "../lib/data";
import type { BackupHistoryInfo, RestoreJob, RestorePreview } from "@onden/contract";
import { serverErrorMessage } from "../lib/serverErrors";
import { spaceLabel, useSpaces } from "../lib/spaces";
import { confirmDialog } from "../components/ConfirmDialog";
import { Button, FieldError, FileInput, Link, Radio, Select, Switch, buttonClass } from "../components/ui";
import { DataRow } from "./DataRow";
import type { SettingContext } from "../lib/settingsTypes";
import "./FullBackupSetting.css";
import { canManageSpace } from "../lib/capabilities";
import type { RestoreMode, RestoreReport } from "@onden/contract";

/** Where the full backup is downloaded from. */
export const FULL_BACKUP_PATH = "/api/backup/full.zip";

/** History is on by default for a backup up to this much text (before compression); a larger one starts off, with its size shown. */
export const HISTORY_DEFAULT_ON_MAX_BYTES = 200 * 1024 * 1024;
const historyMegabytes = (bytes: number): number => Math.max(1, Math.round(bytes / (1024 * 1024)));

export function FullBackupDownload({ ctx }: { ctx: SettingContext }) {
  const tr = useT();
  // What history would add: asked once; a server that cannot say (offline, older) offers no switch and the backup is as before.
  const [size, setSize] = useState<BackupHistoryInfo | null>(null);
  const [withHistory, setWithHistory] = useState(false);
  useEffect(() => {
    if (!ctx.online) return;
    let current = true;
    backupRestore.historySize().then(
      (answer) => {
        if (!current || answer.versions === 0) return;
        setSize(answer);
        setWithHistory(answer.bytes <= HISTORY_DEFAULT_ON_MAX_BYTES);
      },
      () => undefined,
    );
    return () => { current = false; };
  }, [ctx.online]);
  // How large the download is against what this server restores: only said when it is over (the download still works).
  const [weight, setWeight] = useState<{ bytes: number; limit: number } | null>(null);
  useEffect(() => {
    if (!ctx.online) return;
    let current = true;
    void Promise.all([backupLimits.downloadBytes(), backupLimits.restoreLimitBytes()]).then(([bytes, limit]) => {
      if (current && bytes !== null) setWeight({ bytes, limit });
    });
    return () => { current = false; };
  }, [ctx.online]);
  const totalBytes = weight ? weight.bytes + (size && withHistory ? size.bytes : 0) : 0;
  const href = `${getApiBase()}${FULL_BACKUP_PATH}${size && withHistory ? "?history=1" : ""}`;
  return (
    <DataRow
      title={tr("Full backup")}
      hint={tr("Notes, attachments, drawings and tag settings in one zip. Restore it into Onden, or open it as a folder.")}
      note={size ? tr("Leaves out other members' private notes, accounts and keys.") : tr("Leaves out version history, other members' private notes, accounts and keys.")}
      action={<Link className={buttonClass("primary")} href={href} download>{tr("Download")}</Link>}
    >
      {weight && totalBytes > weight.limit && (
        <p className="settings-hint" role="status">
          {tr("This backup is about {size}, more than the {limit} this server restores. You can still download it, but restoring it here needs a server that allows larger backups.", { size: sizeLabel(totalBytes), limit: sizeLabel(weight.limit) })}
        </p>
      )}
      {size && (
        <label className="settings-backup-history">
          <Switch on={withHistory} label={tr("Include version history")} onChange={setWithHistory} />
          <span>
            {tr("Include version history")}
            <span className="settings-hint">
              {tr("Every earlier version of your notes: {versions} versions, about {mb} MB. Moving the whole workspace brings them back; other restores leave them out.", { versions: size.versions, mb: historyMegabytes(size.bytes) })}
            </span>
          </span>
        </label>
      )}
    </DataRow>
  );
}

type Step =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "uploaded"; upload: UploadedBackup }
  | { kind: "restoring"; upload: UploadedBackup }
  | { kind: "done"; report: RestoreReport | null };

/** How often a running restore is asked for its progress. */
export const RESTORE_POLL_MS = 1000;
/** Failed polls in a row before the page gives up (the restore goes on). */
const POLL_FAILURES = 5;

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** What a running job is doing, in words. */
function phaseLabel(tr: ReturnType<typeof useT>, job: RestoreJob): string {
  switch (job.phase) {
    case "queued": case "reading": return tr("Reading the backup…");
    case "attachments": return tr("Writing attachments: {done} / {total}", { done: job.done, total: job.total });
    case "tags": return tr("Restoring tags…");
    case "notes": return tr("Restoring notes: {done} / {total}", { done: job.done, total: job.total });
    case "history": return tr("Restoring version history: {done} / {total}", { done: job.done, total: job.total });
    case "links": return tr("Restoring links…");
    case "positions": return tr("Restoring board positions…");
    case "deleted": return tr("Putting deleted notes back in History…");
    case "done": return tr("Restoring the backup…");
  }
}

/** Why a job failed, and whether its upload can be tried again. */
function jobFailure(tr: ReturnType<typeof useT>, job: RestoreJob): { message: string; retry: boolean } {
  // After a commit the upload is gone: trying again means choosing the file again.
  if (job.event_id && job.rolled_back) {
    return { message: tr("The restore did not finish. What it had added was removed, so your notes are as they were. Choose the backup file again to try again; that is safe."), retry: false };
  }
  if (job.event_id && job.error === "interrupted") {
    return { message: tr("The server restarted before the restore finished. What it had added is being removed; choose the backup file again in a moment to try again."), retry: false };
  }
  if (job.event_id) {
    return { message: tr("The restore did not finish, and part of what it added is still there. In History, undo the restore with the changes it caused, then choose the backup file again."), retry: false };
  }
  if (job.error === "already_restored") return { message: serverErrorMessage("already_restored", undefined), retry: false };
  // Nothing restored, but the upload expired (or is gone): no retry from it.
  if (!job.retryable) {
    return { message: `${serverErrorMessage(job.error ?? "restore_failed", undefined)} ${tr("The uploaded backup has expired; upload it again to retry.")}`, retry: false };
  }
  if (job.error === "interrupted") return { message: tr("The restore was interrupted by a server restart. Nothing was restored; try again."), retry: true };
  return { message: serverErrorMessage(job.error ?? "restore_failed", undefined), retry: true };
}

/** A short list of note titles, with how many more there are. */
function TitleList({ items, total }: { items: Array<{ id: string; title: string }>; total: number }) {
  const tr = useT();
  if (!items.length) return null;
  return (
    <ul className="settings-hint settings-backup-list">
      {items.slice(0, 10).map((item) => <li key={item.id}>{item.title}</li>)}
      {total > 10 && <li>{tr("…and {n} more", { n: total - 10 })}</li>}
    </ul>
  );
}

export function FullBackupRestore({ ctx }: { ctx: SettingContext }) {
  const tr = useT();
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [limit, setLimit] = useState<number | null>(null);
  useEffect(() => {
    if (!ctx.online) return;
    let current = true;
    void backupLimits.restoreLimitBytes().then((bytes) => { if (current) setLimit(bytes); });
    return () => { current = false; };
  }, [ctx.online]);

  async function choose(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setStep({ kind: "uploading" });
    try {
      setStep({ kind: "uploaded", upload: await backupRestore.upload(file) });
    } catch (failure) {
      setError(writeErrors.message(failure));
      setStep({ kind: "idle" });
    }
  }

  return (
    <DataRow
      title={tr("Restore from a backup")}
      hint={tr("Shows what it will do before anything changes; nothing already there is overwritten.")}
      note={limit ? tr("Restores backups up to {size}.", { size: sizeLabel(limit) }) : undefined}
      action={<Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={step.kind === "uploading" || step.kind === "restoring"}>
        {step.kind === "uploading" ? tr("Uploading…") : tr("Choose file…")}
      </Button>}
    >
      <FileInput ref={fileRef} accept=".zip,application/zip" className="settings-file-input--hidden" onChange={choose} aria-label={tr("Full backup file")} />
      {error && <FieldError>{error}</FieldError>}
      {(step.kind === "uploaded" || step.kind === "restoring") && (
        <RestorePanel
          ctx={ctx}
          upload={step.upload}
          restoring={step.kind === "restoring"}
          onRestoring={() => { setError(null); setStep({ kind: "restoring", upload: step.upload }); }}
          onDone={(report) => { setStep({ kind: "done", report }); ctx.onImportDone(); }}
          onFailed={(message, retry) => {
            setError(message);
            setStep(retry ? { kind: "uploaded", upload: step.upload } : { kind: "idle" });
            if (!retry) ctx.onImportDone();
          }}
          onCancel={() => { void backupRestore.discard(step.upload.upload_id); setStep({ kind: "idle" }); setError(null); }}
        />
      )}
      {step.kind === "done" && (step.report ? <RestoreResult report={step.report} /> : <p className="settings-hint" role="status">{tr("This restore had already been done.")}</p>)}
      {step.kind === "done" && step.report?.moved && <MovedSummary moved={step.report.moved} />}
    </DataRow>
  );
}

/** What a finished restore did, in words: how many of each thing came back, then what the backup held that it left out
 *  and why. Every count of the report that is not zero appears; nothing is hidden because it went wrong. */
function RestoreResult({ report }: { report: RestoreReport }) {
  const tr = useT();
  const { skipped } = report;
  const notes = Math.max(0, report.created + report.copies - report.tasks);
  const broughtBack: Array<[number, string]> = [
    [notes, tr("Notes added: {n}", { n: notes })],
    [report.copies, tr("Of those, copies of notes that changed since the backup: {n}", { n: report.copies })],
    [report.tasks, tr("Tasks: {n}", { n: report.tasks })],
    [report.views, tr("Saved views: {n}", { n: report.views })],
    [report.tags_created, tr("Tags: {n}", { n: report.tags_created })],
    [report.attachments_written, tr("Attachments: {n}", { n: report.attachments_written })],
    [report.deleted_again, tr("Deleted notes, put back in History: {n}", { n: report.deleted_again })],
    [report.unchanged, tr("Notes already here and unchanged: {n}", { n: report.unchanged })],
  ];
  const leftOut: Array<[number, string]> = [
    [skipped.tasks, tr("Tasks left out because the note they belong to is not in this space: {n}", { n: skipped.tasks })],
    [skipped.views, tr("Saved views left out (a kind this version does not know, a feature that is off here, or a name already in use): {n}", { n: skipped.views })],
    [skipped.functions, tr("Functions that tags provide (with their settings) that were not brought back: {n}", { n: skipped.functions })],
    [skipped.attachments_too_large, tr("Attachments left out because they are too large: {n}", { n: skipped.attachments_too_large })],
    [skipped.attachments_unreadable, tr("Attachments left out because the file is damaged or of a type that is not allowed: {n}", { n: skipped.attachments_unreadable })],
    [skipped.attachments_not_yours, tr("Attachments left out because the file is missing here and belongs to someone else's upload: {n}", { n: skipped.attachments_not_yours })],
    [skipped.tags, tr("Tags that could not be put back on notes: {n}", { n: skipped.tags })],
    [skipped.attributes, tr("Fields that were refused and left out: {n}", { n: skipped.attributes })],
    [skipped.links, tr("Links between notes that could not be made again: {n}", { n: skipped.links })],
    [skipped.positions, tr("Positions on a whiteboard that could not be placed: {n}", { n: skipped.positions })],
    [skipped.pointers ?? 0, tr("Sidebar shortcuts that could not be put back: {n}", { n: skipped.pointers ?? 0 })],
    [skipped.tag_automation, tr("Old tag automation, which no longer exists, was not brought back: {n}", { n: skipped.tag_automation })],
    [skipped.tag_settings, tr("Tag settings (colour, fields, text) that were not brought back: {n}", { n: skipped.tag_settings })],
  ];
  const shown = (rows: Array<[number, string]>) => rows.filter(([n]) => n > 0).map(([, text]) => <li key={text}>{text}</li>);
  const left = shown(leftOut);
  return (
    <div role="status" aria-label={tr("Restore result")}>
      <p className="settings-hint">{tr("Restored. Undo it from History if needed.")}</p>
      <ul className="settings-hint settings-backup-counts">{shown(broughtBack)}</ul>
      {left.length > 0 && (
        <>
          <p className="settings-hint">{tr("Left out:")}</p>
          <ul className="settings-hint settings-backup-counts">{left}</ul>
        </>
      )}
    </div>
  );
}

/** After the upload: where to, how, what it would do, and the restore. The
 *  spaces are loaded only here, once there is something to restore. */
function RestorePanel({ ctx, upload, restoring, onRestoring, onDone, onFailed, onCancel }: {
  ctx: SettingContext;
  upload: UploadedBackup;
  restoring: boolean;
  onRestoring: () => void;
  onDone: (report: RestoreReport | null) => void;
  /** `retry`: nothing was restored, the preview stays for another try;
   *  otherwise part of it committed and the upload is gone. */
  onFailed: (message: string, retry: boolean) => void;
  onCancel: () => void;
}) {
  const tr = useT();
  const { spaces } = useSpaces(ctx.online);
  const managed = spaces.filter(canManageSpace);
  const [spaceId, setSpaceId] = useState("");
  const [mode, setMode] = useState<RestoreMode>("merge");
  // Whether this workspace may be moved into: new, and the person owns it. Asked once, quietly.
  const personalId = spaces.find((space) => space.kind === "personal")?.id ?? null;
  const [canMove, setCanMove] = useState(false);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [job, setJob] = useState<RestoreJob | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const uploadId = upload.upload_id;

  useEffect(() => {
    if (!spaceId && managed.length) setSpaceId(managed[0]!.id);
  }, [managed, spaceId]);

  useEffect(() => {
    if (!personalId) return;
    let current = true;
    backupRestore.preview(uploadId, personalId, "workspace").then(
      (answer) => { if (current) setCanMove(answer.refusal === null); },
      () => { if (current) setCanMove(false); },
    );
    return () => { current = false; };
  }, [uploadId, personalId]);

  // A move goes into the person's own space; the other choices pick one.
  useEffect(() => {
    if (mode === "workspace" && personalId) setSpaceId(personalId);
  }, [mode, personalId]);

  // The preview follows the chosen space and mode; a late answer for an
  // earlier choice is dropped.
  useEffect(() => {
    if (!spaceId) return;
    let current = true;
    setPreview(null);
    setPreviewError(null);
    backupRestore.preview(uploadId, spaceId, mode).then(
      (next) => { if (current) setPreview(next); },
      (failure: unknown) => { if (current) setPreviewError(writeErrors.message(failure)); },
    );
    return () => { current = false; };
  }, [uploadId, spaceId, mode]);

  async function restore() {
    if (!preview || preview.refusal) return;
    const total = preview.counts.notes_new + preview.counts.notes_new_deleted + preview.counts.notes_conflict + preview.counts.tasks;
    const confirmed = await confirmDialog(
      mode === "workspace"
        ? tr("Move {n} notes and everything that goes with them into this workspace? The sample notes here are removed. You can undo the move from History.", { n: total })
        : tr("Restore {n} notes into 「{space}」? Nothing already there is overwritten. You can undo the whole restore from History.", { n: total, space: preview.target.name }),
      { confirmLabel: tr("Restore"), cancelLabel: tr("Cancel") },
    );
    if (!confirmed) return;
    onRestoring();
    let current: RestoreJob;
    try {
      current = await backupRestore.apply(uploadId, spaceId, mode);
    } catch (failure) {
      onFailed(writeErrors.message(failure), true);
      return;
    }
    // The restore runs on the server; follow it until it ends. Leaving the
    // page stops only the polling.
    let failures = 0;
    while (alive.current) {
      setJob(current);
      if (current.status === "done") { onDone(current.result); return; }
      if (current.status === "failed") { const f = jobFailure(tr, current); onFailed(f.message, f.retry); return; }
      await wait(RESTORE_POLL_MS);
      try {
        current = await backupRestore.job(current.id);
        failures = 0;
      } catch (failure) {
        if (++failures >= POLL_FAILURES) {
          onFailed(tr("Lost track of the restore ({reason}). It may still be running: check History in a moment.", { reason: writeErrors.message(failure) }), false);
          return;
        }
      }
    }
  }

  const c = preview?.counts;
  const created = upload.manifest.created_at;
  return (
    <div className="settings-backup-restore" aria-label={tr("Backup restore preview")}>
      <p className="settings-hint">
        {tr("Backup of {date} by {name}", { date: `${dateLabel(created)} ${timeLabel(created)}`, name: upload.manifest.created_by?.name ?? "?" })}
      </p>
      {mode !== "workspace" && <label className="settings-row">
        <span>{tr("Restore into")}</span>
        <Select value={spaceId} onChange={(e) => setSpaceId(e.target.value)} disabled={restoring}>
          {managed.map((space) => <option key={space.id} value={space.id}>{spaceLabel(space)}</option>)}
        </Select>
      </label>}
      {!managed.length && <p className="settings-hint">{tr("Only a manager of a space can restore into it.")}</p>}
      <fieldset className="settings-backup-modes" disabled={restoring}>
        <label>
          <Radio name="restore-mode" checked={mode === "merge"} onChange={() => setMode("merge")} />
          {tr("Merge into this space: add what is missing; a note changed since the backup keeps its current text and gets the backup's version as a copy")}
        </label>
        <label>
          <Radio name="restore-mode" checked={mode === "empty"} onChange={() => setMode("empty")} />
          {tr("Restore into an empty space: everything comes back with its hierarchy, tags and fields")}
        </label>
        {canMove && (
          <label>
            <Radio name="restore-mode" checked={mode === "workspace"} onChange={() => setMode("workspace")} />
            {tr("Move the whole workspace here: every space, your review progress, subscriptions and settings come too")}
          </label>
        )}
      </fieldset>

      {previewError && <FieldError>{previewError}</FieldError>}
      {!preview && !previewError && managed.length > 0 && <p className="settings-hint">{tr("Checking the backup…")}</p>}
      {preview && c && (
        <div className="settings-backup-preview">
          {preview.refusal === "target_not_empty" && (
            <FieldError>
              {tr("「{space}」 already has {n} notes. Choose an empty space, or merge.", { space: preview.target.name, n: preview.target.notes })}
            </FieldError>
          )}
          {preview.move && <MovePreviewList move={preview.move} />}
          {!preview.move && preview.holds_history && (
            <p className="settings-hint">{tr("This backup holds version history. It comes back only when you move the whole workspace into a new one.")}</p>
          )}
          <ul className="settings-hint settings-backup-counts">
            <li>{tr("New notes: {n}", { n: c.notes_new })}</li>
            {c.notes_new_deleted > 0 && <li>{tr("Deleted notes, back in History: {n}", { n: c.notes_new_deleted })}</li>}
            {c.tasks > 0 && <li>{tr("Tasks: {n}", { n: c.tasks })}</li>}
            {c.notes_unchanged > 0 && <li>{tr("Already here, unchanged: {n}", { n: c.notes_unchanged })}</li>}
            {c.notes_conflict > 0 && <li>{tr("Changed since the backup — current kept, backup added as a copy: {n}", { n: c.notes_conflict })}</li>}
            {c.notes_in_history > 0 && <li>{tr("Deleted here — left in History: {n}", { n: c.notes_in_history })}</li>}
            {c.notes_second_copy > 0 && <li>{tr("Added as a second copy, kept off the website (the note is already here): {n}", { n: c.notes_second_copy })}</li>}
            {c.notes_new_id > 0 && <li>{tr("Restored under a new place, as it was (it follows its space's website setting): {n}", { n: c.notes_new_id })}</li>}
            <li>{tr("Tags: {existing} existing, {created} new", { existing: c.tags_existing, created: c.tags_new })}</li>
            <li>{tr("Attachments: {written} to restore, {kept} already here", { written: c.attachments_new, kept: c.attachments_existing })}</li>
          </ul>
          {preview.conflicts.length > 0 && (
            <>
              <p className="settings-hint">{tr("Kept as they are now, with the backup's version added as a copy:")}</p>
              <TitleList items={preview.conflicts} total={c.notes_conflict} />
            </>
          )}
          {preview.title_clashes.length > 0 && (
            <>
              <p className="settings-hint">{tr("Added next to a note with the same title:")}</p>
              <TitleList items={preview.title_clashes} total={preview.title_clashes.length} />
            </>
          )}
        </div>
      )}
      {restoring && job && (
        <div className="settings-backup-progress" role="status" aria-live="polite">
          <progress max={Math.max(job.total, 1)} value={job.phase === "notes" || job.phase === "attachments" || job.phase === "history" ? job.done : undefined} aria-label={tr("Restore progress")} />
          <span className="settings-hint">{phaseLabel(tr, job)}</span>
        </div>
      )}
      <div className="settings-row settings-row--actions">
        <Button variant="primary" onClick={restore} disabled={!preview || !!preview.refusal || restoring}>
          {restoring ? tr("Restoring the backup…") : tr("Restore")}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={restoring}>{tr("Cancel")}</Button>
      </div>
    </div>
  );
}

/** What the move will make and carry, before it runs. */
function MovePreviewList({ move }: { move: NonNullable<RestorePreview["move"]> }) {
  const tr = useT();
  const label = (item: NonNullable<RestorePreview["move"]>["carries"][number]): string => {
    switch (item.kind) {
      case "progress": return tr("Review progress: {n}", { n: item.count });
      case "focus_records": return tr("Focus records: {n}", { n: item.count });
      case "feeds": return tr("Feed subscriptions: {n}", { n: item.count });
      case "settings": return tr("Your settings");
      case "features": return tr("Which features are on");
      case "site": return tr("The published website");
    }
  };
  const carried = move.carries.map(label);
  return (
    <>
      <p className="settings-hint">{tr("These spaces will be made again:")}</p>
      <ul className="settings-hint settings-backup-list">
        {move.spaces.map((space, at) => (
          <li key={at}>
            {space.kind === "personal" ? tr("Only me") : space.name}{" · "}{tr("{n} notes", { n: space.notes })}
            {space.had_others && ` · ${tr("had other members; invite them again afterwards")}`}
          </li>
        ))}
      </ul>
      {carried.length > 0 && <p className="settings-hint">{tr("Comes along: {list}", { list: carried.join("、") })}</p>}
      {(move.clears.notes > 0 || move.clears.tags > 0) && <p className="settings-hint">{tr("The sample notes and tags here are removed first.")}</p>}
      {move.history && <p className="settings-hint">{tr("Version history comes along: {versions} versions of {notes} notes.", { versions: move.history.versions, notes: move.history.notes })}</p>}
      <p className="settings-hint">
        {move.history
          ? tr("Does not come along: the edit log (what History can undo), AI keys, notification subscriptions, feed reading marks.")
          : tr("Does not come along: version history, AI keys, notification subscriptions, feed reading marks.")}
      </p>
    </>
  );
}

/** After a move: who to invite again, what was left behind. */
function MovedSummary({ moved }: { moved: NonNullable<RestoreReport["moved"]> }) {
  const tr = useT();
  return (
    <>
      {moved.need_reinvite.length > 0 && (
        <p className="settings-hint" role="status">
          {tr("These spaces had other members, who are not moved. Invite them again: {names}", { names: moved.need_reinvite.join("、") })}
        </p>
      )}
      {moved.history && (
        <p className="settings-hint" role="status">
          {tr("Version history came along: {versions} versions of {notes} notes.", { versions: moved.history.versions, notes: moved.history.notes })}
        </p>
      )}
      {moved.history && moved.history.failed.length > 0 && (
        <p className="settings-hint" role="alert">
          {tr("The version history of these notes could not be brought along, because the file was damaged. The notes themselves are here: {titles}", { titles: moved.history.failed.map((title) => title || tr("Untitled")).join("、") })}
        </p>
      )}
      <p className="settings-hint" role="status">
        {moved.history
          ? tr("Not moved: the edit log (what History can undo), AI keys (add them again in Settings), notification subscriptions (turn them on again on each device) and feed reading marks.")
          : tr("Not moved: version history, AI keys (add them again in Settings), notification subscriptions (turn them on again on each device) and feed reading marks.")}
      </p>
    </>
  );
}
