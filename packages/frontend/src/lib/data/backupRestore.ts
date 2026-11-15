// Restoring a full backup (Settings › 你的資料 › 從備份還原; backend
// routes/backup.ts). Online only and never queued: the file is uploaded once,
// the person reads the preview, then the restore runs on the server as a job
// (apply answers at once with it; the page polls `job` for its progress).
// The restore's key is the upload id, so a retry after a lost response finds
// the same job instead of restoring twice.

import { ApiError, api, apiFetch, readErrorBody } from "../api";
import { t } from "../i18n";
import { ensureWordingFor } from "../serverErrors";
import { backupLimits, sizeLabel } from "./backupLimits";
import { sendWrite } from "./onlineWrite";
import { WriteActionError } from "./writeErrors";
import type { BackupHistoryInfo, BackupManifest, RestoreJob, RestoreMode, RestorePreview } from "@onden/contract";

/** A manifest as read from a backup FILE. The server writes every key of BackupManifest today, but a file made by an older
 *  version may lack the newer ones (the creator, the workspace, some counts), and the server's reader passes the file's
 *  manifest through as it is (services/backupFile.ts) — so the page reads the optional form. */
type BackupManifestAsRead = Omit<BackupManifest, "workspace_id" | "created_by" | "counts" | "format"> & {
  format: string;
  workspace_id?: string;
  created_by?: BackupManifest["created_by"];
  counts: Partial<BackupManifest["counts"]>;
};

export type UploadedBackup = { upload_id: string; manifest: BackupManifestAsRead; bytes: number };

const tooLarge = (limitBytes: number) => new WriteActionError(t("The backup is larger than the {size} this server restores.", { size: sizeLabel(limitBytes) }));

/** A job's `error` is a server code shown with serverErrorMessage, outside any refusal
 *  body: load the wording a rarer code needs before the page reads it. */
async function wordedJob(answer: { job: RestoreJob }): Promise<RestoreJob> {
  await ensureWordingFor(answer.job.error);
  return answer.job;
}

export const backupRestore = {
  /** The version history a backup could include, shown before it is downloaded. */
  historySize: () => api<BackupHistoryInfo>("/api/backup/history-size"),
  /** Upload the zip. Refused before sending when over the cap; the server's
   *  refusal (not a backup, an unsafe entry …) throws ApiError. */
  async upload(file: Blob): Promise<UploadedBackup> {
    const limit = await backupLimits.restoreLimitBytes();
    if (file.size > limit) throw tooLarge(limit);
    const response = await apiFetch("/api/backup/restore/upload", { method: "POST", headers: { "Content-Type": "application/zip" }, body: file });
    if (response.status === 413) throw tooLarge(limit);
    if (!response.ok) throw new ApiError(response.status, await readErrorBody(response));
    return await response.json() as UploadedBackup;
  },
  preview: (uploadId: string, spaceId: string, mode: RestoreMode) =>
    api<RestorePreview>(`/api/backup/restore/${encodeURIComponent(uploadId)}/preview?space=${encodeURIComponent(spaceId)}&mode=${mode}`),
  /** Start the restore (or find the job a retry already started). */
  apply: (uploadId: string, spaceId: string, mode: RestoreMode) =>
    sendWrite<{ job: RestoreJob }>("POST", `/api/backup/restore/${encodeURIComponent(uploadId)}/apply`, { space_id: spaceId, mode }, uploadId)
      .then(wordedJob),
  job: (jobId: string) =>
    api<{ job: RestoreJob }>(`/api/backup/restore/jobs/${encodeURIComponent(jobId)}`).then(wordedJob),
  /** Forget the upload; a failure only leaves it until it expires. */
  discard: (uploadId: string) =>
    sendWrite("DELETE", `/api/backup/restore/${encodeURIComponent(uploadId)}`).catch(() => undefined),
};
