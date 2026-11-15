// A note saved thousands of times: the backup and the move hold a page of its versions at a time, not the whole history.
// The test seeds 4000 versions of 4 KB each (16 MB of text) on one note, backs up with history, moves it into a new
// workspace and checks every version is there in order; it prints the peak resident memory above the starting point and the
// time, which the PR reports. What proves "a page at a time" is counted, not sampled from the process: the largest piece
// the export appends to its scratch file and the largest batch the import hands to the writer (memory is a sanity bound).

import { afterAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q, withTransaction } from "../db.js";

let current = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => current }));
import { apiOnError } from "../httpError.js";
import backupRouter from "../routes/backup.js";
import nodesRouter from "../routes/nodes.js";
import { appendImportedVersions, type ImportedVersion } from "../spine/importedHistory.js";
import { NO_INVERSE_PATCH } from "../services/eventLog/bodyPatch.js";
import type { RestoreJob } from "@onden/contract";
import type { ActorCtx } from "../types.js";
import { sha256Hex } from "../utils.js";
import { persistActor } from "./helpers/persistActor.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { waitForJob } from "./helpers/restoreJob.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { publishDefaultSpace } from "./helpers/spaceFixtures.js";

// Counted on the real code: every append to the history scratch file, and every batch handed to the writer.
const appended: number[] = [];
const batches: number[] = [];
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, appendFile: (async (...args: Parameters<typeof fs.appendFile>) => { appended.push(Buffer.byteLength(String(args[1]))); return fs.appendFile(...args); }) as typeof fs.appendFile };
});
vi.mock("../spine/importedHistory.js", async (original) => {
  const real = await original<typeof import("../spine/importedHistory.js")>();
  return { ...real, appendImportedVersions: ((...args: Parameters<typeof real.appendImportedVersions>) => { batches.push(args[3].length); return real.appendImportedVersions(...args); }) as typeof real.appendImportedVersions };
});

registerShippedModules();
const VERSIONS = 4000;
const BODY_BYTES = 4096;

function app(actor: ActorCtx) {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/backup", backupRouter);
  hono.route("/api/nodes", nodesRouter);
  return hono;
}
async function newWorkspace(name: string) {
  const ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id::text`, [name, `${name}-${randomUUID()}`])).rows[0]!.id;
  await publishDefaultSpace(ws);
  current = ws;
  const owner = await persistActor(ws, { id: "", name: `Owner of ${name}`, type: "human", role: "editor" });
  await setWorkspaceOwner(ws, owner.id);
  const personal = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [owner.id])).rows[0]!.id;
  return { ws, owner, personal };
}

/** Peak resident memory (MB) above the start while `run` goes. */
async function peakRss<T>(run: () => Promise<T>): Promise<{ result: T; peakMb: number; seconds: number }> {
  global.gc?.();
  const start = process.memoryUsage().rss;
  let peak = start;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
  const at = Date.now();
  try { const result = await run(); return { result, peakMb: Math.max(0, peak - start) / 1048576, seconds: (Date.now() - at) / 1000 }; }
  finally { clearInterval(timer); }
}

describe.skipIf(!isTestDatabase())("a note with thousands of saved versions", () => {
  afterAll(() => { current = ""; });

  it("is carried in bounded memory, every version in order", async () => {
    const source = await newWorkspace("scale-source");
    const made = await app(source.owner).request("/api/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "長長的歷史", markdown: "start\n" }) });
    const noteId = ((await made.json()) as { id: string }).id;
    const filler = "x".repeat(BODY_BYTES - 40);
    const base = Date.parse("2024-01-01T00:00:00Z");
    for (let at = 0; at < VERSIONS; at += 500) {
      const batch: ImportedVersion[] = [];
      for (let i = at; i < Math.min(VERSIONS, at + 500); i++) {
        const markdown = `版本 ${i}\n${filler}\n`;
        batch.push({ sourceEventId: String(i + 1), kind: "updated", at: new Date(base + i * 60_000).toISOString().replace("Z", "000Z"), title: "長長的歷史", bodyHash: sha256Hex(markdown), markdown, actorType: "user", actorName: "Ann", restoredFrom: null });
      }
      await withTransaction(() => appendImportedVersions(source.owner, source.ws, noteId, batch, NO_INVERSE_PATCH));
    }
    const total = (await q<{ n: string }>(`SELECT count(*)::text n FROM domain_events WHERE target_id = $1 AND body_hash IS NOT NULL`, [noteId])).rows[0]!.n;
    expect(Number(total)).toBe(VERSIONS + 1);

    appended.length = 0; batches.length = 0; // the seeding above wrote 500 at a time; what is counted is the backup and the move
    const backup = await peakRss(async () => Buffer.from(await (await app(source.owner).request("/api/backup/full.zip?history=1")).arrayBuffer()));
    const pages = [...appended];
    const plain = await peakRss(async () => Buffer.from(await (await app(source.owner).request("/api/backup/full.zip")).arrayBuffer()));

    const target = await newWorkspace("scale-target");
    const up = await app(target.owner).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(backup.result) });
    const uploadId = ((await up.json()) as { upload_id: string }).upload_id;
    const moved = await peakRss(async () => {
      const started = await app(target.owner).request(`/api/backup/restore/${uploadId}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: target.personal, mode: "workspace" }) });
      return waitForJob(app(target.owner), ((await started.json()) as { job: RestoreJob }).job, 600_000);
    });
    expect(moved.result.status).toBe("done");
    expect(moved.result.result!.moved!.history).toMatchObject({ failed: [], versions: VERSIONS + 1 });

    const there = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = '長長的歷史'`, [target.ws])).rows[0]!.id;
    const mine = (await q<{ markdown: string }>(
      `SELECT b.content AS markdown FROM domain_events e JOIN blobs b ON b.hash = e.body_hash
        WHERE e.target_id = $1 AND e.tx_meta ? 'history_import' ORDER BY e.created_at, e.id`, [there])).rows;
    expect(mine.length).toBe(VERSIONS + 1);
    // The seeded versions are dated 2024; the note's own first save ("start") is the newest.
    expect(mine[mine.length - 1]!.markdown).toBe("start\n");
    expect(mine.slice(0, -1).every((row, i) => row.markdown.startsWith(`版本 ${i}\n`))).toBe(true);

    // The export wrote the note's history in pages of 200 versions (about 0.8 MB each), never the whole 16 MB at once;
    // the import handed the writer batches of at most 200.
    expect(pages.length).toBe(Math.ceil((VERSIONS + 1) / 200));
    expect(Math.max(...pages)).toBeLessThan(200 * (BODY_BYTES + 2048));
    expect(Math.max(...batches)).toBeLessThanOrEqual(200);
    expect(batches.length).toBeGreaterThanOrEqual(Math.ceil((VERSIONS + 1) / 200));

    const textMb = (VERSIONS * BODY_BYTES) / 1048576;
    // eslint-disable-next-line no-console
    console.info(`[history-scale] ${VERSIONS} versions, ${textMb.toFixed(1)} MB of text, zip ${(backup.result.length / 1048576).toFixed(1)} MB (plain backup ${(plain.result.length / 1024).toFixed(0)} KB)\n` +
      `  backup with history: peak +${backup.peakMb.toFixed(0)} MB, ${backup.seconds.toFixed(1)} s; plain backup: peak +${plain.peakMb.toFixed(0)} MB, ${plain.seconds.toFixed(1)} s\n` +
      `  move with history: peak +${moved.peakMb.toFixed(0)} MB, ${moved.seconds.toFixed(1)} s`);
    // A sanity bound only (the counts above are the proof): measured +26 MB on Postgres and +64 MB on PGlite, which also
    // holds the text itself; loading the history whole costs the text's size several times over.
    expect(moved.peakMb).toBeLessThan(textMb * 2 + 60);
  }, 900_000);
});
