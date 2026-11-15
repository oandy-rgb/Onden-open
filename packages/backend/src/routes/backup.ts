// The backup a person makes and restores themselves (Settings › 你的資料).
//   GET    /api/backup/history-size              { notes, versions, bytes } of version history a backup could add
//   GET    /api/backup/full.zip[?written=1][&since=][&note=…][&history=1]  (history=1: with every note's version history)
//                                                everything the caller may read, as one zip; with the query,
//                                                only the notes written / saved since / named (same format)
//                                                (services/backupArchive.ts)
//   POST   /api/backup/restore/upload            the zip as the raw body → { upload_id, manifest }
//                                                (stored and checked: services/backupFile.ts)
//   GET    /api/backup/restore/:id/preview?space=&mode=empty|merge|workspace   (workspace: a move into a new
//                                                workspace, `space` its personal space)
//                                                what the restore would do (services/backupRestore.ts)
//   POST   /api/backup/restore/:id/apply { space_id, mode, parent_title?, parent_id? }
//                                                (merge only) parent_title: everything lands under one new note of that
//                                                title; parent_id: the same note again on the next import of one session
//                                                restore it, as a job: 202 { job } (200 when
//                                                the job had already finished); one undoable event
//   GET    /api/backup/restore/jobs/:job         the job: status, phase, progress, error, report
//                                                (services/backupRestoreJobs.ts)
//   DELETE /api/backup/restore/:id               forget the upload
// A person only: a delegated token never downloads or restores a workspace.
// Errors go through the shared boundary (httpError.ts).

import { attachmentHeaders } from "../downloadHeaders.js";
import { Hono } from "hono";
import { Readable } from "node:stream";
import { z } from "zod";
import { NODE_TITLE_MAX } from "@onden/markdown";
import { getWorkspaceId } from "../services/workspaceId.js";
import type { ActorCtx } from "../types.js";
import { requireActor } from "../spine/mutate.js";
import { requirePerson } from "../spine/authority.js";
import { backupFileName, backupHistorySize, buildFullBackup, measureFullBackup } from "../services/backupArchive.js";
import { discardUpload, maxBackupUploadBytes, openBackupUpload, stageBackupUpload, uploadHeld } from "../services/backupFile.js";
import { previewBackupRestore } from "../services/backupRestore.js";
import { getRestoreJob, startRestoreJob } from "../services/backupRestoreJobs.js";
import { parseBody, parseQuery } from "./params.js";
import { StatusError } from "../statusError.js";

const router = new Hono<{ Variables: { actor: ActorCtx | null } }>();

function person(c: { get(key: "actor"): ActorCtx | null }): ActorCtx {
  const actor = requireActor(c.get("actor"));
  requirePerson(actor, "backup");
  return actor;
}

// Part of the workspace in the same format (services/backupArchive.ts BackupSelection): `written=1` only notes someone
// wrote, `since=<ISO time>` only notes saved at or after it, `note=<id>`
// (repeatable) only those notes. Their ancestors, tags and attachments come along.
const selectionQuery = z.object({
  written: z.enum(["1", "true"]).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  note: z.array(z.uuid()).optional(),
  // Add every note's version history (format 3; services/backupHistory.ts).
  history: z.enum(["1", "true"]).optional(),
});

// How much version history a full backup would add ({ notes, versions, bytes }), shown before the person chooses it.
router.get("/history-size", async (c) => c.json(await backupHistorySize(person(c), await getWorkspaceId())));

// How large a full backup would be (without history), so the page can say before the download that it is over the restore limit.
router.get("/size", async (c) => c.json(await measureFullBackup(person(c), await getWorkspaceId())));

// The largest backup this server restores (ONDEN_MAX_BACKUP_MB), shown beside the file chooser.
router.get("/restore/limit", (c) => { person(c); return c.json({ max_bytes: maxBackupUploadBytes() }); });

router.get("/full.zip", async (c) => {
  const actor = person(c);
  const query = parseQuery(c, selectionQuery, { repeated: ["note"] });
  const selection = query.written || query.since || query.note
    ? { ...(query.written ? { written: true } : {}), ...(query.since ? { changedSince: query.since } : {}), ...(query.note ? { noteIds: query.note } : {}) }
    : undefined;
  const archive = await buildFullBackup(actor, await getWorkspaceId(), selection, { history: !!query.history });
  return c.body(Readable.toWeb(archive) as ReadableStream, 200, {
    ...attachmentHeaders(backupFileName(), "application/zip"),
    "Cache-Control": "no-store",
  });
});

// nginx passes this body through as it arrives (proxy_request_buffering off), so every refusal below must come before
// the body is read: the person check, the length cap and the free-space check all run first (stageBackupUpload).
// A refused request also closes its connection, so the server does not read the rest of the file just to discard it.
router.post("/restore/upload", async (c) => {
  try {
    const actor = person(c);
    const body = c.req.raw.body;
    if (!body) throw new StatusError(400, "empty_body");
    const declared = Number(c.req.header("content-length"));
    const staged = await stageBackupUpload(actor.id, Readable.fromWeb(body as import("node:stream/web").ReadableStream), Number.isFinite(declared) ? declared : null);
    return c.json({ upload_id: staged.uploadId, manifest: staged.manifest, bytes: staged.bytes });
  } catch (error) {
    c.header("Connection", "close");
    throw error;
  }
});

const modeSchema = z.enum(["empty", "merge", "workspace"]);

// "Put it all under one new note": `parent_title` (and, for a session imported again, `parent_id`); merge only.
const parentTitle = z.string().trim().min(1).max(NODE_TITLE_MAX);
const parentNoteOf = (title: string | undefined, id: string | undefined) => (title ? { title, ...(id ? { id } : {}) } : null);

router.get("/restore/:id/preview", async (c) => {
  const actor = person(c);
  const query = parseQuery(c, z.object({ space: z.uuid(), mode: modeSchema, parent_title: parentTitle.optional(), parent_id: z.uuid().optional() }));
  const reader = await openBackupUpload(actor.id, c.req.param("id"));
  try {
    return c.json(await previewBackupRestore(actor, await getWorkspaceId(), reader, query.mode, query.space, parentNoteOf(query.parent_title, query.parent_id)));
  } finally { reader.close(); }
});

router.post("/restore/:id/apply", async (c) => {
  const actor = person(c);
  const input = await parseBody(c, z.object({ space_id: z.uuid(), mode: modeSchema, parent_title: parentTitle.optional(), parent_id: z.uuid().optional() }));
  const { job } = await startRestoreJob(actor, await getWorkspaceId(), c.req.param("id"), input.space_id, input.mode, parentNoteOf(input.parent_title, input.parent_id));
  return c.json({ job }, job.status === "running" ? 202 : 200);
});

router.get("/restore/jobs/:job", async (c) => {
  const actor = person(c);
  const job = await getRestoreJob(actor.id, c.req.param("job"));
  if (!job) throw new StatusError(404, "job_not_found");
  return c.json({ job });
});

router.delete("/restore/:id", async (c) => {
  const actor = person(c);
  const uploadId = c.req.param("id");
  // Only the uploader's own: anyone else's id reads as not found.
  (await openBackupUpload(actor.id, uploadId)).close();
  // A restore reading it keeps it; the job lets go of it when it ends.
  if (!uploadHeld(uploadId)) await discardUpload(uploadId);
  return c.json({ ok: true });
});

export default router;
