// Restore from a backup, against crafted archives (review of #442): what a
// person can make a restore do with a zip they edited by hand.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { q, getWorkspaceId } from "../db.js";

// A workspace of its own: a backup or export reads the whole workspace, so in
// the shared default workspace its cost would grow with every other test's
// notes (on a reused DB the export query alone took 1–2 s).
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
import { apiOnError } from "../httpError.js";
import backupRouter from "../routes/backup.js";
import { MEDIA_DIR } from "../services/mediaStore.js";
import { storeMedia } from "../services/media.js";
import { canReadMedia } from "../services/mediaAccess.js";
import { mediaOwnerSpace } from "../services/mediaOwners.js";
import { diskMediaFiles } from "../services/mediaFiles.js";
import { RESTORE_BATCH } from "../services/backupRestore.js";
import { failInterruptedRestoreJobs, getRestoreJob } from "../services/backupRestoreJobs.js";
import type { RestoreJob } from "@onden/contract";
import { STORE } from "../git.js";
import { NODE_TITLE_MAX } from "@onden/markdown";
import { createNote } from "../services/noteCreate.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { rawZip } from "./helpers/rawZip.js";
import { applyAndWait, waitForJob } from "./helpers/restoreJob.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

registerShippedModules();

const enabled = isTestDatabase();

function app(actor: ActorCtx) {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/backup", backupRouter);
  return hono;
}
const upload = (actor: ActorCtx, zip: Buffer) =>
  app(actor).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
async function uploaded(actor: ActorCtx, zip: Buffer): Promise<string> {
  const res = await upload(actor, zip);
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { upload_id: string }).upload_id;
}
const preview = (actor: ActorCtx, id: string, space: string, mode: "empty" | "merge") =>
  app(actor).request(`/api/backup/restore/${id}/preview?space=${space}&mode=${mode}`);
/** Start the restore job and wait for it (helpers/restoreJob.ts). */
const apply = (actor: ActorCtx, id: string, space: string, mode: "empty" | "merge") => applyAndWait(app(actor), id, space, mode);

const manifest = JSON.stringify({ format: "onden-backup", version: 1, created_at: new Date().toISOString(), counts: {} });
type Sidecar = Record<string, unknown> & { id: string; markdown: string; media: string[]; attributes: unknown[] };

/** A minimal backup: these notes (sidecars only) and attachments. */
function craft(notes: Sidecar[], attachments: Record<string, Buffer> = {}): Buffer {
  return rawZip([
    ...notes.map((n) => ({ name: `.onden/notes/${n.id}.json`, data: JSON.stringify(n), deflate: true })),
    ...Object.entries(attachments).map(([id, data]) => ({ name: `attachments/${id}`, data })),
    { name: ".onden/manifest.json", data: manifest },
  ]);
}
function sidecar(over: Partial<Sidecar> = {}): Sidecar {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), node_type: "content", title: `Crafted ${randomUUID().slice(0, 6)}`, slug: null, parent_id: null,
    space_id: null, hidden: false, sort_order: 0, source_type: "manual", created_at: now, updated_at: now, deleted_at: null,
    markdown: "crafted\n", presentation: null, attributes: [], tags: [], file: null, media: [], ...over,
  };
}
const mediaId = (ext: string) => `${randomUUID().replaceAll("-", "")}${ext}`;

describe.skipIf(!enabled)("restore from a crafted backup", () => {
  let ws: string;
  const stamp = randomUUID().slice(0, 8);
  let victim: ActorCtx;
  let mallory: ActorCtx;
  let victimSpace = "";
  let mallorySpace = "";

  // Restoring a backup into a shared space is the workspace owner's, so the
  // person who restores a crafted backup here is the owner: Mallory by default
  // (beforeEach), Honest in the one test that restores as them. Victim is an
  // ordinary member whose space the owner is not in.
  const makeOwner = (id: string) => setWorkspaceOwner(ws, id);

  async function soloActor(name: string): Promise<ActorCtx> {
    const actor = await persistActor(ws, { id: "", name: `${name} ${stamp}`, type: "human", role: "editor" });
    await q(`DELETE FROM space_members m USING spaces s WHERE m.space_id = s.id AND m.actor_id = $1 AND s.kind <> 'personal'`, [actor.id]);
    return actor;
  }

  beforeAll(async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Test', $1) RETURNING id::text`, [`backup-adv-${randomUUID()}`])).rows[0]!.id;
    ws = await getWorkspaceId();
    victim = await soloActor("Victim");
    mallory = await soloActor("Mallory");
    victimSpace = await makeSpace(ws, `V ${stamp}`, [{ id: victim.id, permission: "edit" }]);
    mallorySpace = await makeSpace(ws, `M ${stamp}`, [{ id: mallory.id, permission: "edit" }]);
    mkdirSync(MEDIA_DIR, { recursive: true });
  });

  beforeEach(async () => { await makeOwner(mallory.id); });

  it("refuses a symlink, an encrypted entry and a duplicated name", async () => {
    const status = async (zip: Buffer) => { const r = await upload(mallory, zip); return [r.status, ((await r.json()) as { error: string }).error]; };
    const png = mediaId(".png");
    expect(await status(rawZip([{ name: ".onden/manifest.json", data: manifest }, { name: `attachments/${png}`, data: "/etc/passwd", unixMode: 0o120777 }])))
      .toEqual([400, "unsafe_entry"]);
    const [code, error] = await status(rawZip([{ name: ".onden/manifest.json", data: manifest }, { name: "a.md", data: "x", encrypted: true }]));
    expect(code).toBe(400);
    expect(["encrypted_entry", "not_zip"]).toContain(error);
    expect(await status(rawZip([{ name: ".onden/manifest.json", data: manifest }, { name: "a.md", data: "x" }, { name: "a.md", data: "y" }])))
      .toEqual([400, "duplicate_entry"]);
  });

  it("a sidecar that inflates past the size its header declares is refused, not read", async () => {
    const note = sidecar({ markdown: "x".repeat(4 * 1024 * 1024) });
    const zip = rawZip([
      { name: `.onden/notes/${note.id}.json`, data: JSON.stringify(note), deflate: true, declaredSize: 1000 },
      { name: ".onden/manifest.json", data: manifest },
    ]);
    const id = await uploaded(mallory, zip);
    const res = await preview(mallory, id, mallorySpace, "merge");
    expect(res.status).toBe(400);
  });

  it("an attachment that inflates past its declared size fails the restore and leaves nothing", async () => {
    const pdf = mediaId(".pdf");
    const note = sidecar({ markdown: `[f](/api/media/${pdf})\n`, media: [pdf] });
    const target = await makeSpace(ws, `Bomb ${stamp}`, [{ id: mallory.id, permission: "edit" }]);
    const zip = rawZip([
      { name: `.onden/notes/${note.id}.json`, data: JSON.stringify(note), deflate: true },
      { name: `attachments/${pdf}`, data: Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(3 * 1024 * 1024)]), deflate: true, declaredSize: 100 },
      { name: ".onden/manifest.json", data: manifest },
    ]);
    const res = await upload(mallory, zip);
    // 3 MB declared as 100 bytes: under 1 MB, so the ratio check never sees it;
    // yauzl's validateEntrySizes must stop it while reading.
    if (res.status === 200) {
      const id = ((await res.json()) as { upload_id: string }).upload_id;
      const applied = await apply(mallory, id, target, "empty");
      expect(applied.status).toBeGreaterThanOrEqual(400);
    }
    expect(existsSync(join(MEDIA_DIR, pdf))).toBe(false);
    expect((await q(`SELECT 1 FROM content_nodes WHERE space_id = $1`, [target])).rows).toHaveLength(0);
  });

  it("a corrupt attachment fails the restore with nothing left, and does not stop the server", async () => {
    // Before the fix the entry stream's error reached the process as an
    // unhandled 'error' (vitest reports it as an uncaught exception).
    const pdf = mediaId(".pdf");
    const note = sidecar({ markdown: `[f](/api/media/${pdf})\n`, media: [pdf] });
    const target = await makeSpace(ws, `Corrupt ${stamp}`, [{ id: mallory.id, permission: "edit" }]);
    const zip = rawZip([
      { name: `.onden/notes/${note.id}.json`, data: JSON.stringify(note), deflate: true },
      { name: `attachments/${pdf}`, data: Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(3000, 7)]), claimDeflate: true },
      { name: ".onden/manifest.json", data: manifest },
    ]);
    const id = await uploaded(mallory, zip);
    const res = await apply(mallory, id, target, "empty");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(existsSync(join(MEDIA_DIR, pdf))).toBe(false);
    expect((await q(`SELECT 1 FROM content_nodes WHERE space_id = $1`, [target])).rows).toHaveLength(0);
  });

  it("a bad date is refused before anything is written: no notes, no files", async () => {
    const pdf = mediaId(".pdf");
    const target = await makeSpace(ws, `Rollback ${stamp}`, [{ id: mallory.id, permission: "edit" }]);
    const good = sidecar({ markdown: `[f](/api/media/${pdf})\n`, media: [pdf] });
    const bad = sidecar({ created_at: "not a date" });
    const id = await uploaded(mallory, craft([good, bad], { [pdf]: Buffer.from(`%PDF-1.4 ${stamp}`) }));
    const res = await apply(mallory, id, target, "empty");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(existsSync(join(MEDIA_DIR, pdf))).toBe(false);
    expect((await q(`SELECT 1 FROM content_nodes WHERE space_id = $1`, [target])).rows).toHaveLength(0);
    expect((await q(`SELECT 1 FROM media_uploads WHERE filename = $1`, [pdf])).rows).toHaveLength(0);
  });

  it("an attachment is sanitised (SVG) and signature-checked (PDF) like an import", async () => {
    const svg = mediaId(".svg");
    const fakePdf = mediaId(".pdf");
    const target = await makeSpace(ws, `Media ${stamp}`, [{ id: mallory.id, permission: "edit" }]);
    const note = sidecar({ markdown: `![](/api/media/${svg}) [x](/api/media/${fakePdf})\n`, media: [svg, fakePdf] });
    const evil = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10" onload="alert(2)"/></svg>`;
    const id = await uploaded(mallory, craft([note], { [svg]: Buffer.from(evil), [fakePdf]: Buffer.from("MZ not a pdf") }));
    const res = await apply(mallory, id, target, "empty");
    expect(res.status, await res.clone().text()).toBe(200);
    const onDisk = readFileSync(join(MEDIA_DIR, svg), "utf8");
    expect(onDisk).not.toMatch(/script|onload/i);
    expect(existsSync(join(MEDIA_DIR, fakePdf))).toBe(false);
  });

  it("an id of someone else's note never touches it: a new id, its own parent ignored", async () => {
    const theirs = await createNote({ actor: victim, workspaceId: ws, title: `Secret ${stamp}`, markdown: "secret\n", spaceId: victimSpace, event: { uiContext: "test" } });
    const theirId = String(theirs.node.id);
    const sameId = sidecar({ id: theirId, title: `Hijack ${stamp}`, markdown: "overwritten?\n" });
    const child = sidecar({ parent_id: theirId, title: `Under ${stamp}` });
    for (const mode of ["merge", "empty"] as const) {
      const target = mode === "merge" ? mallorySpace : await makeSpace(ws, `Empty ${stamp}`, [{ id: mallory.id, permission: "edit" }]);
      const id = await uploaded(mallory, craft([sameId, { ...child, id: randomUUID() }]));
      const shown = await (await preview(mallory, id, target, mode)).json() as { conflicts: unknown[]; counts: { notes_new_id: number } };
      expect(shown.conflicts).toEqual([]);
      const res = await apply(mallory, id, target, mode);
      expect(res.status, await res.clone().text()).toBe(200);
      const row = (await q<{ title: string; markdown: string; space_id: string }>(`SELECT title, markdown, space_id::text FROM content_nodes WHERE id = $1`, [theirId])).rows[0]!;
      expect(row).toEqual({ title: `Secret ${stamp}`, markdown: "secret\n", space_id: victimSpace });
      // The child follows its parent's sidecar to the parent's new id, in the target.
      const hijack = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE title = $1 AND space_id = $2`, [`Hijack ${stamp}`, target])).rows;
      expect(hijack).toHaveLength(1);
      const placed = (await q<{ parent_id: string | null }>(`SELECT parent_id::text FROM content_nodes WHERE title = $1 AND space_id = $2`, [`Under ${stamp}`, target])).rows;
      expect(placed).toEqual([{ parent_id: hijack[0]!.id }]);
      expect((await q(`SELECT 1 FROM content_nodes WHERE parent_id = $1`, [theirId])).rows).toHaveLength(0);
    }
  });

  it("only the system attributes that belong to a note come back from a crafted sidecar, with values Tasks could write", async () => {
    const target = await makeSpace(ws, `Attrs ${stamp}`, [{ id: mallory.id, permission: "edit" }]);

    const note = sidecar({ attributes: [
      { key: "_published", value: "true", value_type: "text", is_inheritable: false, source: "ui" },
      { key: "_task_status", value: "pwned", value_type: "text", is_inheritable: false, source: "ui" },
      { key: "_task_remind_at", value: "2026-11-01T09:00", value_type: "text", is_inheritable: false, source: "ui" },
      { key: "_task_deadline", value: "2026-11-05", value_type: "text", is_inheritable: false, source: "ui" },
      { key: "colour", value: "red", value_type: "text", is_inheritable: false, source: "ui" },
    ] });
    const id = await uploaded(mallory, craft([note]));
    expect((await apply(mallory, id, target, "empty")).status).toBe(200);
    const created = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE space_id = $1`, [target])).rows[0]!.id;
    const keys = (await q<{ key: string }>(`SELECT key FROM node_attributes WHERE node_id = $1`, [created])).rows.map((r) => r.key);
    expect(keys).toContain("colour");
    // `_published` is only the note's opt-in (the note menu's own write): the site changes at the next publish, by its owner, and only for a space whose publish switch is on.
    expect(keys).toContain("_published");
    // A note-task's own fields come back only as the Tasks page could have written them.
    expect(keys).not.toContain("_task_status");
    expect(keys).not.toContain("_task_remind_at");
    expect(keys).toContain("_task_deadline");
  });

  // A file with no upload row (imported, or from before migration 090)
  // belongs to its OLDEST referencing note (mediaAccess.ts). The restore keeps
  // the backup's created_at only where that does not make the restored note
  // older than a note already referencing such a file (review of #442, D1).
  it("a backdated note does not become the owner of someone else's imported file", async () => {
    // An imported file (no media_uploads row): its OLDEST referencing note decides who reads it.
    const png = mediaId(".png");
    writeFileSync(join(MEDIA_DIR, png), Buffer.from("not really a png"));
    await q(`INSERT INTO imported_media (workspace_id, actor_id, content_hash, extension, filename) VALUES ($1, $2, $3, '.png', $4)`,
      [ws, victim.id, createHash("sha256").update(png).digest("hex"), png]);
    await createNote({ actor: victim, workspaceId: ws, title: `Holiday ${stamp}`, markdown: `![](/api/media/${png})\n`, spaceId: victimSpace, event: { uiContext: "test" } });
    expect(await canReadMedia(mallory, png, ws)).toBe(false);
    // Mallory knows the URL (say, from before she left the space): pasting it
    // into a note of hers grants nothing...
    await createNote({ actor: mallory, workspaceId: ws, title: `Paste ${stamp}`, markdown: `![](/api/media/${png})\n`, spaceId: mallorySpace, event: { uiContext: "test" } });
    expect(await canReadMedia(mallory, png, ws)).toBe(false);
    // ...and neither may a restored note dated before the victim's.
    const target = await makeSpace(ws, `Backdate ${stamp}`, [{ id: mallory.id, permission: "edit" }]);
    const note = sidecar({ markdown: `![](/api/media/${png})\n`, created_at: "2001-01-01T00:00:00Z", updated_at: "2001-01-01T00:00:00Z" });
    const id = await uploaded(mallory, craft([note]));
    expect((await apply(mallory, id, target, "empty")).status).toBe(200);
    expect(await canReadMedia(mallory, png, ws)).toBe(false);
  });

  it("a file missing from disk is not refilled with someone else's bytes under their media id", async () => {
    const stored = await storeMedia(Buffer.from(`%PDF-1.4 victim ${stamp}`), ".pdf", { actor: victim, workspaceId: ws, origin: "upload" });
    if (!stored.ok) throw new Error(stored.reason);
    const pdf = stored.filename;
    await createNote({ actor: victim, workspaceId: ws, title: `Contract ${stamp}`, markdown: `[c](/api/media/${pdf})\n`, spaceId: victimSpace, event: { uiContext: "test" } });
    rmSync(join(MEDIA_DIR, pdf)); // lost from disk (a dead embed)
    const target = await makeSpace(ws, `Refill ${stamp}`, [{ id: mallory.id, permission: "edit" }]);
    const note = sidecar({ markdown: `[c](/api/media/${pdf})\n`, media: [pdf] });
    const id = await uploaded(mallory, craft([note], { [pdf]: Buffer.from("%PDF-1.4 mallory's version") }));
    expect((await apply(mallory, id, target, "empty")).status).toBe(200);
    const now = existsSync(join(MEDIA_DIR, pdf)) ? readFileSync(join(MEDIA_DIR, pdf), "utf8") : null;
    expect(now).not.toBe("%PDF-1.4 mallory's version");
  });

  it("an honest restore on the same server does not move an imported file to the restored copies", async () => {
    const honest = await soloActor("Honest");
    await makeOwner(honest.id);
    const home = await makeSpace(ws, `Home ${stamp}`, [{ id: honest.id, permission: "edit" }]);
    const png = mediaId(".png");
    writeFileSync(join(MEDIA_DIR, png), Buffer.from("imported bytes"));
    await q(`INSERT INTO imported_media (workspace_id, actor_id, content_hash, extension, filename) VALUES ($1, $2, $3, '.png', $4)`,
      [ws, honest.id, createHash("sha256").update(png).digest("hex"), png]);
    await createNote({ actor: honest, workspaceId: ws, title: `Trip ${stamp}`, markdown: `![](/api/media/${png})\n`, spaceId: home, event: { uiContext: "test" } });
    expect(await mediaOwnerSpace(ws, png)).toBe(home);
    // Their own backup, restored into an empty space shared with Mallory: the
    // copies carry the originals' created_at.
    const res = await app(honest).request("/api/backup/full.zip");
    expect(res.status).toBe(200);
    const target = await makeSpace(ws, `Shared copy ${stamp}`, [{ id: honest.id, permission: "edit" }, { id: mallory.id, permission: "edit" }]);
    const id = await uploaded(honest, Buffer.from(await res.arrayBuffer()));
    expect((await apply(honest, id, target, "empty")).status).toBe(200);
    const copies = (await q<{ created_at: string }>(`SELECT created_at::text FROM content_nodes WHERE space_id = $1 AND title = $2`, [target, `Trip ${stamp}`])).rows;
    expect(copies).toHaveLength(1);
    // The file still belongs to the original note's space, not the copy's.
    expect(await mediaOwnerSpace(ws, png)).toBe(home);
    expect(await canReadMedia(mallory, png, ws)).toBe(false);
    expect(await canReadMedia(honest, png, ws)).toBe(true);
  });

  it("a merge puts children and copies in the chosen space, never under a note of another space", async () => {
    const elsewhere = await makeSpace(ws, `Elsewhere ${stamp}`, [{ id: mallory.id, permission: "edit" }]);
    const target = await makeSpace(ws, `Chosen ${stamp}`, [{ id: mallory.id, permission: "edit" }]);
    const home = await createNote({ actor: mallory, workspaceId: ws, title: `Home ${stamp}`, markdown: "home\n", spaceId: elsewhere, event: { uiContext: "test" } });
    const homeId = String(home.node.id);
    const page = await createNote({ actor: mallory, workspaceId: ws, title: `Page ${stamp}`, markdown: "now\n", spaceId: elsewhere, parentId: homeId, event: { uiContext: "test" } });
    const pageId = String(page.node.id);
    // The backup: Home as it is (unchanged), Page as it was (a copy), and a
    // child of Home that is not here (new).
    const zip = craft([
      sidecar({ id: homeId, title: `Home ${stamp}`, markdown: "home\n" }),
      sidecar({ id: pageId, title: `Page ${stamp}`, markdown: "then\n", parent_id: homeId }),
      sidecar({ title: `Kid ${stamp}`, parent_id: homeId }),
    ]);
    const id = await uploaded(mallory, zip);
    const res = await apply(mallory, id, target, "merge");
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual(expect.objectContaining({ created: 1, copies: 1, unchanged: 1 }));
    const landed = (await q<{ title: string; parent_id: string | null }>(
      `SELECT title, parent_id::text FROM content_nodes WHERE space_id = $1 ORDER BY title`, [target])).rows;
    expect(landed).toEqual([
      { title: `Kid ${stamp}`, parent_id: null },
      { title: expect.stringMatching(new RegExp(`^Page ${stamp}（備份 `)), parent_id: null },
    ]);
    expect((await q(`SELECT 1 FROM content_nodes WHERE parent_id = $1`, [homeId])).rows).toHaveLength(1); // Page only
  });

  it("a batch failing after earlier ones committed undoes the restore", async () => {
    const target = await makeSpace(ws, `Half ${stamp}`, [{ id: mallory.id, permission: "edit" }]);
    const fine = Array.from({ length: RESTORE_BATCH + 1 }, (_, i) => sidecar({ title: `Fine ${i} ${stamp}` }));
    // Refused by the note size cap in the second batch, not by a single
    // write's rule: the restore stops there.
    const tooLong = sidecar({ title: "x".repeat(NODE_TITLE_MAX + 1) });
    const id = await uploaded(mallory, craft([...fine, tooLong]));
    const res = await apply(mallory, id, target, "empty");
    expect(res.status).toBe(500);
    const { job } = await res.json() as { job: RestoreJob };
    expect(job).toEqual(expect.objectContaining({ status: "failed", error: "restore_failed", rolled_back: true }));
    expect(job.event_id).not.toBeNull();
    // What the first batches added is undone and then deleted for good: nothing of the attempt stays in
    // History to meet the next one (a merge would take it for a note the person deleted).
    expect((await q(`SELECT 1 FROM content_nodes WHERE space_id = $1`, [target])).rows).toHaveLength(0);
    // It committed, so the upload is gone and a retry finds the job.
    const again = await app(mallory).request(`/api/backup/restore/${id}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: target, mode: "empty" }) });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { job: RestoreJob }).job.id).toBe(job.id);
  }, 120_000);

  it("a retry of apply returns the same job, running or done; another person's job is not found", async () => {
    const target = await makeSpace(ws, `Retry ${stamp}`, [{ id: mallory.id, permission: "edit" }]);
    const id = await uploaded(mallory, craft([sidecar({ title: `Once ${stamp}` })]));
    const post = () => app(mallory).request(`/api/backup/restore/${id}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: target, mode: "empty" }) });
    const first = await post();
    expect(first.status).toBe(202);
    const job = ((await first.json()) as { job: RestoreJob }).job;
    const second = await post();
    expect([200, 202]).toContain(second.status);
    expect(((await second.json()) as { job: RestoreJob }).job.id).toBe(job.id);
    const finished = await waitForJob(app(mallory), job);
    expect(finished.status).toBe("done");
    expect(finished.result).toEqual(expect.objectContaining({ created: 1 }));
    // The upload is discarded, but the retry still answers with the job.
    const third = await post();
    expect(third.status).toBe(200);
    expect(((await third.json()) as { job: RestoreJob }).job).toEqual(expect.objectContaining({ id: job.id, status: "done" }));
    expect((await q(`SELECT 1 FROM content_nodes WHERE space_id = $1`, [target])).rows).toHaveLength(1);
    expect((await app(victim).request(`/api/backup/restore/jobs/${job.id}`)).status).toBe(404);
    // Not a uuid, though 36 characters of hex and dashes: not found, not a 500 from the uuid column.
    expect((await app(mallory).request(`/api/backup/restore/jobs/${"-".repeat(36)}`)).status).toBe(404);
    expect((await app(victim).request(`/api/backup/restore/${id}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: victimSpace, mode: "merge" }) })).status).toBe(404);
  });

  it("on boot, a job left running is failed and half-written files are dropped", async () => {
    const jobId = randomUUID();
    await q(`INSERT INTO backup_restore_jobs (id, workspace_id, actor_id, upload_id, space_id, mode, status, phase) VALUES ($1, $2, $3, $4, $5, 'merge', 'running', 'notes')`,
      [jobId, ws, mallory.id, randomUUID(), mallorySpace]);
    const uploads = join(STORE, "backup-uploads");
    mkdirSync(uploads, { recursive: true });
    const part = join(uploads, `${randomUUID()}.zip.part`);
    writeFileSync(part, "half");
    const temp = join(MEDIA_DIR, `.store-${randomUUID()}.tmp`);
    writeFileSync(temp, "half");
    await failInterruptedRestoreJobs();
    expect(await getRestoreJob(mallory.id, jobId)).toEqual(expect.objectContaining({ status: "failed", error: "interrupted" }));
    expect(existsSync(part)).toBe(false);
    expect(existsSync(temp)).toBe(false);
  });

  it("on boot, a restore that had committed is undone, so a new attempt starts clean", async () => {
    const target = await makeSpace(ws, `Boot ${stamp}`, [{ id: mallory.id, permission: "edit" }]);
    const id = await uploaded(mallory, craft([sidecar({ title: `Cut off ${stamp}` })]));
    const res = await apply(mallory, id, target, "empty");
    expect(res.status).toBe(200);
    expect((await q(`SELECT 1 FROM content_nodes WHERE space_id = $1 AND deleted_at IS NULL`, [target])).rows).toHaveLength(1);
    // The process died after the first commit: the job is still "running", with its event.
    await q(`UPDATE backup_restore_jobs SET status = 'running', phase = 'notes', rolled_back = false WHERE upload_id = $1`, [id]);
    await failInterruptedRestoreJobs();
    const job = (await app(mallory).request(`/api/backup/restore/jobs/${(await q<{ id: string }>(`SELECT id::text FROM backup_restore_jobs WHERE upload_id = $1`, [id])).rows[0]!.id}`));
    expect(((await job.json()) as { job: RestoreJob }).job).toEqual(expect.objectContaining({ status: "failed", error: "interrupted" }));
    // The undo goes on in the background.
    for (let waited = 0; waited < 20_000; waited += 50) {
      if ((await q<{ rolled_back: boolean }>(`SELECT rolled_back FROM backup_restore_jobs WHERE upload_id = $1`, [id])).rows[0]!.rolled_back) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect((await q<{ rolled_back: boolean }>(`SELECT rolled_back FROM backup_restore_jobs WHERE upload_id = $1`, [id])).rows[0]!.rolled_back).toBe(true);
    expect((await q(`SELECT 1 FROM content_nodes WHERE space_id = $1`, [target])).rows).toHaveLength(0);
  }, 60_000);

  it("refuses to write attachments the disk has no room for", async () => {
    await expect(diskMediaFiles(MEDIA_DIR, async () => 100 * 1024 * 1024).assertRoom(10 * 1024 * 1024))
      .rejects.toMatchObject({ code: "insufficient_storage", status: 507 });
    await expect(diskMediaFiles(MEDIA_DIR, async () => 10 * 1024 ** 3).assertRoom(10 * 1024 * 1024)).resolves.toBeUndefined();
    await expect(diskMediaFiles(MEDIA_DIR, async () => 0).assertRoom(0)).resolves.toBeUndefined();
  });
});
