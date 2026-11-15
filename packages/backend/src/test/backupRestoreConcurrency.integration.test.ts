// Restore from a backup, second review of #442 (54eb4618): references the
// ownership rule counts but the link grammar does not (D1), two restores into
// one space at once, the automatic undo's lock, and History's undo while a
// restore is still running.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { q, getWorkspaceId } from "../db.js";

// A workspace of its own: a backup or export reads the whole workspace, so in
// the shared default workspace its cost would grow with every other test's
// notes (on a reused DB the export query alone took 1–2 s).
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
import { apiOnError } from "../httpError.js";
import backupRouter from "../routes/backup.js";
import { NODE_TITLE_MAX } from "@onden/markdown";
import { restoreEvent } from "../services/eventRestore/index.js";
import { withIdempotencyKey } from "../spine/mutate.js";
import { MEDIA_DIR } from "../services/mediaStore.js";
import { canReadMedia } from "../services/mediaAccess.js";
import { createNote } from "../services/noteCreate.js";
import type { RestoreJob } from "@onden/contract";
import type { ActorCtx } from "../types.js";
import { nativeOwnerActor, persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { rawZip } from "./helpers/rawZip.js";
import { applyAndWait, waitForJob } from "./helpers/restoreJob.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { needsSecondConnection } from "./helpers/pgliteSkips.js";

registerShippedModules();

const enabled = isTestDatabase();
function app(actor: ActorCtx) {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/backup", backupRouter);
  return hono;
}
async function uploaded(actor: ActorCtx, zip: Buffer): Promise<string> {
  const res = await app(actor).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { upload_id: string }).upload_id;
}
const manifest = JSON.stringify({ format: "onden-backup", version: 1, created_at: new Date().toISOString(), counts: {} });
type Sidecar = Record<string, unknown> & { id: string; markdown: string; media: string[]; attributes: unknown[] };
function craft(notes: Sidecar[]): Buffer {
  return rawZip([
    ...notes.map((n) => ({ name: `.onden/notes/${n.id}.json`, data: JSON.stringify(n), deflate: true })),
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

describe.skipIf(!enabled || needsSecondConnection)("restore from a backup: second review", () => {
  let ws: string;
  const stamp = randomUUID().slice(0, 8);
  // Restoring a backup into a space is managing it: the workspace owner's for a
  // shared space, the person's own for their personal space. `owner` is the
  // first human here, so it owns this fresh workspace.
  let owner: ActorCtx; let victim: ActorCtx; let mallory: ActorCtx; let victimSpace = "";
  const personalSpaceOf = async (actor: ActorCtx) => (await q<{ id: string }>(
    `SELECT id::text FROM spaces WHERE kind = 'personal' AND owner_actor_id = $1`, [actor.id])).rows[0]!.id;
  const sharedTarget = (name: string) => makeSpace(ws, name, [{ id: owner.id, permission: "edit" }]);
  async function soloActor(name: string): Promise<ActorCtx> {
    const actor = await persistActor(ws, { id: "", name: `${name} ${stamp}`, type: "human", role: "editor" });
    await q(`DELETE FROM space_members m USING spaces s WHERE m.space_id = s.id AND m.actor_id = $1 AND s.kind <> 'personal'`, [actor.id]);
    return actor;
  }
  beforeAll(async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Test', $1) RETURNING id::text`, [`backup-conc-${randomUUID()}`])).rows[0]!.id;
    ws = await getWorkspaceId();
    owner = await persistActor(ws, { id: "", name: `Owner ${stamp}`, type: "human", role: "admin" });
    victim = await soloActor("Victim"); mallory = await soloActor("Mallory");
    victimSpace = await makeSpace(ws, `V ${stamp}`, [{ id: victim.id, permission: "edit" }]);
    mkdirSync(MEDIA_DIR, { recursive: true });
  });

  for (const [label, embed] of [
    ["upper-case URL", (png: string) => `[x](/API/MEDIA/${png})\n`],
    ["URL inside a longer path", (png: string) => `see https://example.com/sub/api/media/${png}\n`],
    ["URL right after a letter", (png: string) => `x/api/media/${png}\n`],
  ] as const) {
    it(`a backdated note does not take over an imported file it names by ${label}`, async () => {
      const png = mediaId(".png");
      writeFileSync(join(MEDIA_DIR, png), Buffer.from("victim bytes"));
      await q(`INSERT INTO imported_media (workspace_id, actor_id, content_hash, extension, filename) VALUES ($1, $2, $3, '.png', $4)`,
        [ws, victim.id, createHash("sha256").update(png).digest("hex"), png]);
      await createNote({ actor: victim, workspaceId: ws, title: `Holiday ${stamp}`, markdown: `![](/api/media/${png})\n`, spaceId: victimSpace, event: { uiContext: "test" } });
      expect(await canReadMedia(mallory, png, ws)).toBe(false);
      // Mallory is not the owner: she restores into her own personal space.
      const target = await personalSpaceOf(mallory);
      const note = sidecar({ markdown: embed(png), created_at: "2001-01-01T00:00:00Z", updated_at: "2001-01-01T00:00:00Z" });
      const id = await uploaded(mallory, craft([note]));
      // Merge, not empty: the personal space keeps what the earlier cases restored.
      expect((await applyAndWait(app(mallory), id, target, "merge")).status).toBe(200);
      expect(await canReadMedia(mallory, png, ws)).toBe(false);
    });
  }

  it("two restores started together into one empty space: the second is refused", async () => {
    // Only an owner manages a shared space, and a person keeps one upload at a
    // time, so the two racers are the two owners: the person and the native System.
    const system = await nativeOwnerActor(ws);
    const target = await makeSpace(ws, `Race ${stamp}`, [{ id: owner.id, permission: "edit" }, { id: system.id, permission: "edit" }]);
    const a = await uploaded(owner, craft(Array.from({ length: 60 }, (_, i) => sidecar({ title: `A${i} ${stamp}` }))));
    const b = await uploaded(system, craft(Array.from({ length: 60 }, (_, i) => sidecar({ title: `B${i} ${stamp}` }))));
    const start = (actor: ActorCtx, id: string) => app(actor).request(`/api/backup/restore/${id}/apply`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: target, mode: "empty" }) });
    const [ra, rb] = await Promise.all([start(owner, a), start(system, b)]);
    const ends: Array<RestoreJob | number> = [];
    for (const [actor, r] of [[owner, ra], [system, rb]] as const) {
      if (r.status === 202 || r.status === 200) ends.push(await waitForJob(app(actor), ((await r.json()) as { job: RestoreJob }).job));
      else ends.push(r.status);
    }
    const done = ends.filter((e) => typeof e !== "number" && e.status === "done").length;
    const live = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM content_nodes WHERE space_id = $1 AND deleted_at IS NULL AND node_type <> 'class_tag'`, [target])).rows[0]!.n;
    expect(done).toBe(1);
    // The other one was refused before it started (409 restore_running), or
    // under the lock (target_not_empty) if the first had finished already.
    expect(ends.filter((e) => e === 409 || (typeof e !== "number" && e.status === "failed" && e.error === "target_not_empty"))).toHaveLength(1);
    expect(live).toBe(60);
  }, 120_000);

  it("the automatic undo of a failed restore does not hold the event lock for long", async () => {
    const target = await sharedTarget(`Undo ${stamp}`);
    const fine = Array.from({ length: 400 }, (_, i) => sidecar({ title: `F${i} ${stamp}` }));
    const id = await uploaded(owner, craft([...fine, sidecar({ title: "x".repeat(NODE_TITLE_MAX + 1) })]));
    const r = await app(owner).request(`/api/backup/restore/${id}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: target, mode: "empty" }) });
    let job = ((await r.json()) as { job: RestoreJob }).job;
    let maxBatchWait = 0; let maxUndoWait = 0; let sawUndo = false;
    while (job.status === "running") {
      const s = Date.now();
      await createNote({ actor: victim, workspaceId: ws, title: `probe ${randomUUID()}`, markdown: "p\n", spaceId: victimSpace, event: { uiContext: "test" } });
      const w = Date.now() - s;
      const res = await app(owner).request(`/api/backup/restore/jobs/${job.id}`);
      job = ((await res.json()) as { job: RestoreJob }).job;
      // The last batch fails: from then on the restore is undoing.
      if (job.phase === "notes" && job.done >= 400) sawUndo = true;
      if (sawUndo) maxUndoWait = Math.max(maxUndoWait, w); else maxBatchWait = Math.max(maxBatchWait, w);
    }
    expect(job).toEqual(expect.objectContaining({ status: "failed", rolled_back: true }));
    expect(maxBatchWait).toBeLessThan(5000);
    expect(maxUndoWait).toBeLessThan(5000);
  }, 300_000);

  it("History refuses to undo a restore that is still running", async () => {
    const target = await sharedTarget(`Mid ${stamp}`);
    const id = await uploaded(owner, craft(Array.from({ length: 300 }, (_, i) => sidecar({ title: `M${i} ${stamp}` }))));
    const r = await app(owner).request(`/api/backup/restore/${id}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: target, mode: "empty" }) });
    let job = ((await r.json()) as { job: RestoreJob }).job;
    while (!(job.phase === "notes" && job.done >= 100)) {
      await new Promise((res) => setTimeout(res, 20));
      job = ((await (await app(owner).request(`/api/backup/restore/jobs/${job.id}`)).json()) as { job: RestoreJob }).job;
    }
    const undone = await withIdempotencyKey(randomUUID(), () => restoreEvent(job.event_id!, { actor: owner, workspaceId: ws, cascade: true }));
    job = await waitForJob(app(owner), job);
    const live = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM content_nodes WHERE space_id = $1 AND deleted_at IS NULL`, [target])).rows[0]!.n;
    expect(undone).toEqual(expect.objectContaining({ code: "state_conflict" }));
    expect(job.status).toBe("done");
    expect(live).toBe(300);
    // Once it has finished, it undoes as before.
    const later = await withIdempotencyKey(randomUUID(), () => restoreEvent(job.event_id!, { actor: owner, workspaceId: ws, cascade: true }));
    expect(later).toEqual(expect.objectContaining({ restored: true }));
  }, 300_000);
});
