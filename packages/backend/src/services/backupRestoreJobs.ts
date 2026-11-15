// A restore from a backup runs as a job (routes/backup.ts): POST …/apply
// checks the target, records a job and answers 202 at once; the restore
// itself (services/backupRestore.ts applyRestore, committing in batches) runs
// in this process and writes its progress to the job row, which the settings
// page polls (GET …/jobs/:id). A big restore takes minutes; a request that
// waited for it would hit the proxy's timeout while the restore went on.
//
// One job per upload. The upload id is the restore's idempotency key, so a
// retry of apply (a lost 202, a double click) finds the job — running, done
// with its report, or failed — instead of an upload already discarded. A job
// that failed before anything committed may be started again from the same
// upload; one that committed (and was undone, or left for History) may not.
//
// One running restore per space (a partial unique index, migration 123): two
// restores into one empty space would otherwise both pass the empty check
// and both commit, and two merges would interleave their batches. The second
// is refused with 409 restore_running.
//
// Jobs live only in the process that runs them: on boot,
// failInterruptedRestoreJobs marks every job still running as failed
// ("interrupted"), drops half-written uploads and media temp files, and undoes
// what an interrupted restore had already committed (in the background), so
// that running it again starts from the state before the first attempt.

import { isUuid } from "@onden/markdown";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { q } from "../db.js";
import { db } from "../dbKysely.js";
import { log } from "../logger.js";
import type { ActorCtx } from "../types.js";
import { AuthorityError, IdempotentReplay } from "../spine/mutate.js";
import { ScopeError } from "../spine/toolScope.js";
import { mediaFiles } from "./mediaFiles.js";
import {
  BackupFileError, BackupRestoreRefusal, BackupUploadNotFound, discardUpload, holdUpload, openBackupUpload, releaseUpload,
  sweepUploadsAtBoot, uploadAvailable, type BackupReader,
} from "./backupFile.js";
import { sweepBackupScratchAtBoot } from "./backupArchive.js";
import { applyRestore, checkRestoreTarget, RestoreAbandoned, undoInSteps, type RestoreProgress } from "./backupRestore.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import type { RestoreJob, RestoreMode, RestoreParentNote, RestoreReport } from "@onden/contract";

const COLUMNS = `id::text, upload_id::text, space_id::text, mode, status, phase, done, total, event_id::text,
  error, error_status, rolled_back, result, created_at::text, updated_at::text`;

type JobRow = Omit<RestoreJob, "retryable">;

async function withRetryable(actorId: string, row: JobRow): Promise<RestoreJob> {
  const retryable = row.status === "failed" && row.event_id === null && row.error !== "already_restored"
    && await uploadAvailable(actorId, row.upload_id);
  return { ...row, retryable };
}

async function jobByUpload(uploadId: string): Promise<(JobRow & { actor_id: string }) | null> {
  return (await q<JobRow & { actor_id: string }>(
    `SELECT ${COLUMNS}, actor_id::text FROM backup_restore_jobs WHERE upload_id = $1`, [uploadId])).rows[0] ?? null;
}

/** Job `jobId` of `actorId`; anyone else's reads as not found. */
export async function getRestoreJob(actorId: string, jobId: string): Promise<RestoreJob | null> {
  // A real uuid shape only: 36 dashes or hex in the wrong places would reach
  // the uuid column and fail as a 500 instead of reading as not found.
  if (!isUuid(jobId)) return null;
  const row = (await q<JobRow>(
    `SELECT ${COLUMNS} FROM backup_restore_jobs WHERE id = $1 AND actor_id = $2`, [jobId, actorId])).rows[0];
  return row ? withRetryable(actorId, row) : null;
}

const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === "23505";

/** Start restoring upload `uploadId` into `spaceId`, or find the job that
 *  already did. `started` is false for an existing job. Throws as the
 *  restore's checks do (403, 404 upload or space, 409 target_not_empty). */
export async function startRestoreJob(
  actor: ActorCtx, workspaceId: string, uploadId: string, spaceId: string, mode: RestoreMode, parentNote: RestoreParentNote | null = null,
): Promise<{ job: RestoreJob; started: boolean }> {
  const existing = await jobByUpload(uploadId);
  if (existing && existing.actor_id !== actor.id) throw new BackupUploadNotFound();
  const retry = existing?.status === "failed" && existing.event_id === null && existing.error !== "already_restored";
  if (existing && !retry) return { job: await withRetryable(actor.id, existing), started: false };

  let reader: BackupReader;
  try {
    reader = await openBackupUpload(actor.id, uploadId);
  } catch (error) {
    // The upload is gone; the job that used it still answers.
    if (existing && error instanceof BackupUploadNotFound) return { job: await withRetryable(actor.id, existing), started: false };
    throw error;
  }
  let row: JobRow | undefined;
  try {
    await checkRestoreTarget(actor, workspaceId, mode, spaceId);
    if (parentNote && mode !== "merge") throw new BackupRestoreRefusal("bad_request", 400);
    row = retry
      ? (await q<JobRow>(
        `UPDATE backup_restore_jobs SET status = 'running', phase = 'queued', done = 0, total = 0, error = NULL, error_status = NULL,
                space_id = $2, mode = $3, result = NULL, updated_at = now()
          WHERE upload_id = $1 AND status = 'failed' AND event_id IS NULL RETURNING ${COLUMNS}`, [uploadId, spaceId, mode])).rows[0]
      // Either conflict leaves no row: the same upload started a moment ago
      // (its job answers), or another restore runs into this space.
      : (await q<JobRow>(
        `INSERT INTO backup_restore_jobs (id, workspace_id, actor_id, upload_id, space_id, mode, status, phase)
         VALUES ($1, $2, $3, $4, $5, $6, 'running', 'queued') ON CONFLICT DO NOTHING RETURNING ${COLUMNS}`,
        [randomUUID(), workspaceId, actor.id, uploadId, spaceId, mode])).rows[0];
  } catch (error) {
    reader.close();
    // The retry's UPDATE met the one-running-per-space index.
    if (isUniqueViolation(error)) throw new BackupRestoreRefusal("restore_running", 409);
    throw error;
  }
  if (!row) {
    reader.close();
    const now = await jobByUpload(uploadId);
    if (!now || now.status !== "running") throw new BackupRestoreRefusal("restore_running", 409);
    return { job: await withRetryable(actor.id, now), started: false };
  }
  const job: RestoreJob = { ...row, retryable: false };
  holdUpload(uploadId);
  void runJob(job.id, actor, workspaceId, reader, uploadId, spaceId, mode, parentNote);
  return { job, started: true };
}

async function progress(jobId: string, p: RestoreProgress): Promise<void> {
  await q(
    `UPDATE backup_restore_jobs SET phase = $2, done = $3, total = $4, event_id = COALESCE($5::bigint, event_id), updated_at = now()
      WHERE id = $1 AND status = 'running'`,
    [jobId, p.phase, p.done, p.total, p.eventId],
  );
}

/** The code and HTTP status a failed job reports. */
function failure(error: unknown): { code: string; status: number } {
  if (error instanceof BackupRestoreRefusal || error instanceof BackupFileError) return { code: error.code, status: error.status };
  if (error instanceof BackupUploadNotFound) return { code: "upload_not_found", status: 404 };
  if (error instanceof AuthorityError || error instanceof ScopeError) return { code: "forbidden", status: 403 };
  // The key committed in another process: this backup was restored already.
  if (error instanceof IdempotentReplay) return { code: "already_restored", status: 409 };
  return { code: "restore_failed", status: 500 };
}

async function runJob(
  jobId: string, actor: ActorCtx, workspaceId: string, reader: BackupReader, uploadId: string, spaceId: string, mode: RestoreMode, parentNote: RestoreParentNote | null,
): Promise<void> {
  let committed = false;
  try {
    const report = await applyRestore(actor, workspaceId, reader, mode, spaceId, uploadId, async (p) => {
      if (p.eventId) committed = true;
      await progress(jobId, p);
    }, parentNote);
    committed = true;
    await q(
      `UPDATE backup_restore_jobs SET status = 'done', phase = 'done', done = total, event_id = $2::bigint, result = $3::jsonb, updated_at = now()
        WHERE id = $1`, [jobId, report.event_id, JSON.stringify(report)]);
  } catch (error) {
    const abandoned = error instanceof RestoreAbandoned ? error : null;
    if (abandoned) committed = true;
    const { code, status } = failure(abandoned ? abandoned.reason : error);
    if (status >= 500) log.error("backup", "restore job failed", { err: abandoned ?? error, job: jobId });
    await q(
      `UPDATE backup_restore_jobs SET status = 'failed', error = $2, error_status = $3, rolled_back = $4,
              event_id = COALESCE($5::bigint, event_id), updated_at = now()
        WHERE id = $1`,
      [jobId, abandoned ? "restore_failed" : code, abandoned ? 500 : status, abandoned?.rolledBack ?? false, abandoned?.eventId ?? null],
    ).catch((e) => log.error("backup", "recording a failed restore job failed", { err: e, job: jobId }));
  } finally {
    reader.close();
    releaseUpload(uploadId);
    // A restore that committed is done with its upload (a retry finds the
    // job); one that failed before any commit keeps it, to try again.
    if (committed) await discardUpload(uploadId).catch(() => undefined);
  }
}

/** Boot: a job still "running" belonged to a process that is gone. Mark it
 *  failed ("interrupted"), drop old finished jobs, half-written uploads and the
 *  temporary files a media write left behind, and start undoing what the
 *  interrupted restores had committed (with an event_id): that goes on in the
 *  background, one job at a time, and the job's `rolled_back` turns true when
 *  it is done. Call before serving. */
export async function failInterruptedRestoreJobs(): Promise<void> {
  const interrupted = await db.updateTable("backup_restore_jobs")
    .set({ status: "failed", error: "interrupted", error_status: 500, updated_at: sql`now()` })
    .where("status", "=", "running").returning(["id", "workspace_id", "actor_id", "event_id"]).execute();
  if (interrupted.length) log.warn("backup", `${interrupted.length} restore job(s) interrupted by a restart`);
  await q(`DELETE FROM backup_restore_jobs WHERE status <> 'running' AND updated_at < now() - interval '30 days'`);
  await sweepUploadsAtBoot();
  await sweepBackupScratchAtBoot();
  await mediaFiles().sweepIncomplete();
  const committed = interrupted.flatMap((job) => (job.event_id === null ? [] : [{ ...job, event_id: String(job.event_id) }]));
  if (committed.length) void (async () => { for (const job of committed) await rollBackInterrupted(job); })();
}

/** Undo the committed part of an interrupted restore, as a failed batch does. */
async function rollBackInterrupted(job: { id: string; workspace_id: string; actor_id: string; event_id: string }): Promise<void> {
  try {
    const actor = await resolveCurrentActor({ id: job.actor_id }, job.workspace_id);
    if (!await undoInSteps(actor, job.workspace_id, job.event_id)) return;
    await db.updateTable("backup_restore_jobs").set({ rolled_back: true, updated_at: sql`now()` }).where("id", "=", job.id).execute();
  } catch (error) {
    log.warn("backup", "undoing an interrupted restore failed", { err: error, job: job.id });
  }
}
