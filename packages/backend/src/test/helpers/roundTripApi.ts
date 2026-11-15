// The real routes the round-trip tests send a workspace out and in through:
// Markdown export, folder import, full backup and restore. Each call is made
// as `actor` in `ws` (workspaceSwitch moves the mocked getWorkspaceId).

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { apiOnError } from "../../httpError.js";
import importRouter from "../../modules/importers/routes.js";
import exportRouter from "../../routes/export.js";
import backupRouter from "../../routes/backup.js";
import type { ActorCtx } from "../../types.js";
import { workspaceSwitch } from "./workspaceSwitch.js";
import { zipEntries } from "./zipEntries.js";
import { applyAndWait } from "./restoreJob.js";

function app(actor: ActorCtx) {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/import", importRouter);
  hono.route("/api/export", exportRouter);
  hono.route("/api/backup", backupRouter);
  return hono;
}

export type Zip = Map<string, Buffer>;
export type ImportFile = { path: string; content: string } | { path: string; base64: string; kind: "media" };
export type ImportReport = Record<string, unknown> & { imported: number; skipped: number; conflicts: Array<{ path: string; reason: string }> };

/** `lang: "en"` asks for the English names of the standalone task list (Tasks/Tasks.md). */
export async function exportMarkdown(ws: string, actor: ActorCtx, options: { lang?: "en" } = {}): Promise<Zip> {
  workspaceSwitch.ws = ws;
  const res = await app(actor).request(`/api/export/markdown.zip${options.lang ? `?lang=${options.lang}` : ""}`);
  if (res.status !== 200) throw new Error(`export: ${res.status} ${await res.text()}`);
  return zipEntries(Buffer.from(await res.arrayBuffer()));
}

/** A Markdown zip as the files the folder import is sent (text for .md, bytes for the rest). */
export function zipFiles(zip: Zip): ImportFile[] {
  return [...zip].map(([path, data]): ImportFile => (path.endsWith(".md") ? { path, content: data.toString("utf8") } : { path, base64: data.toString("base64"), kind: "media" }));
}

export async function importFiles(ws: string, actor: ActorCtx, files: ImportFile[], source = { id: randomUUID(), name: "round trip" }, options: { upsert?: boolean } = {}): Promise<ImportReport> {
  workspaceSwitch.ws = ws;
  const res = await app(actor).request("/api/import/obsidian", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source, files, ...(options.upsert ? { upsert: true } : {}) }),
  });
  const body = await res.json() as ImportReport;
  if (res.status !== 200) throw new Error(`import: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

export async function fullBackup(ws: string, actor: ActorCtx): Promise<Buffer> {
  workspaceSwitch.ws = ws;
  const res = await app(actor).request("/api/backup/full.zip");
  if (res.status !== 200) throw new Error(`backup: ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Upload `zip` and restore it into the empty space `spaceId` of `ws`. */
export async function restoreBackup(ws: string, actor: ActorCtx, zip: Buffer, spaceId: string): Promise<Record<string, unknown>> {
  workspaceSwitch.ws = ws;
  const hono = app(actor);
  const up = await hono.request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
  if (up.status !== 200) throw new Error(`restore upload: ${up.status} ${await up.text()}`);
  const { upload_id } = await up.json() as { upload_id: string };
  const res = await applyAndWait(hono, upload_id, spaceId, "empty");
  const body = await res.json() as Record<string, unknown>;
  if (res.status !== 200) throw new Error(`restore: ${res.status} ${JSON.stringify(body)}`);
  return body;
}
