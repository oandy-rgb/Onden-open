// Version history in a backup and in a workspace move (services/backupHistory.ts, spine/importedHistory.ts):
// a backup made with history is format 3 and a move into a new workspace brings every version of every note back — same
// text, same order, same time, the author's name kept — and an old version can be restored from it. Without the option the
// archive is what it always was. A damaged version fails that note's history alone, loudly. A replay adds nothing.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { fromBuffer as openZip } from "yauzl";
import { q } from "../db.js";

let current = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => current }));
import { apiOnError } from "../httpError.js";
import backupRouter from "../routes/backup.js";
import nodesRouter from "../routes/nodes.js";
import { BACKUP_VERSION } from "../services/backupArchive.js";
import { importNoteHistory, historyEntryPath, parseHistoryLine, HistoryLineError, type HistoryLine } from "../services/backupHistory.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import { listEvents } from "../services/eventQuery.js";
import { inboxQueue } from "../services/inboxQueue.js";
import { agentRunsStartedBetween } from "../services/history/agentRuns.js";
import { dayLens } from "../services/dayLens.js";
import { localDayId } from "../localDay.js";
import { listNoteVersions } from "../services/history/index.js";
import { MAX_HISTORY_LINE_CHARS } from "../services/backupFile.js";
import { appendImportedVersions, type ImportedVersion } from "../spine/importedHistory.js";
import { NO_INVERSE_PATCH } from "../services/eventLog/bodyPatch.js";
import { withTransaction } from "../db.js";
import type { RestoreJob } from "@onden/contract";
import type { ActorCtx } from "../types.js";
import { sha256Hex } from "../utils.js";
import { persistActor } from "./helpers/persistActor.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { waitForJob } from "./helpers/restoreJob.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { publishDefaultSpace } from "./helpers/spaceFixtures.js";
import { createSharedSpace } from "../services/spaces.js";
import { seedQ } from "./helpers/seedQ.js";
import { rawZip } from "./helpers/rawZip.js";

registerShippedModules();
const enabled = isTestDatabase();
/** SHA-256 of the README a format-2 backup has always had (main before this change): a plain backup must keep it. */
const PLAIN_README_SHA256 = "81aac1ce2a9d60d20876d7876005072e5ea9bcb47e1f20e73e83a66214ae382c";

function app(actor: ActorCtx) {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/backup", backupRouter);
  hono.route("/api/nodes", nodesRouter);
  return hono;
}
const send = (a: ActorCtx, url: string, method: string, body: unknown = {}) =>
  app(a).request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function newWorkspace(name: string): Promise<{ ws: string; owner: ActorCtx; personal: string }> {
  const ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id::text`, [name, `${name}-${randomUUID()}`])).rows[0]!.id;
  await publishDefaultSpace(ws);
  current = ws;
  const owner = await persistActor(ws, { id: "", name: `Owner of ${name}`, type: "human", role: "editor" });
  await setWorkspaceOwner(ws, owner.id);
  const personal = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [owner.id])).rows[0]!.id;
  return { ws, owner, personal };
}

async function download(actor: ActorCtx, query = ""): Promise<Buffer> {
  const res = await app(actor).request(`/api/backup/full.zip${query}`);
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}
async function upload(actor: ActorCtx, zip: Buffer): Promise<{ status: number; id?: string; error?: string }> {
  const res = await app(actor).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
  if (res.status !== 200) return { status: res.status, error: ((await res.json()) as { error?: string }).error };
  return { status: 200, id: ((await res.json()) as { upload_id: string }).upload_id };
}
async function move(actor: ActorCtx, personal: string, zip: Buffer): Promise<{ status: number; job?: RestoreJob; error?: string }> {
  const up = await upload(actor, zip);
  if (!up.id) return { status: up.status, ...(up.error ? { error: up.error } : {}) };
  const started = await app(actor).request(`/api/backup/restore/${up.id}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: personal, mode: "workspace" }) });
  if (started.status !== 202 && started.status !== 200) return { status: started.status, error: ((await started.json()) as { error?: string }).error };
  const job = await waitForJob(app(actor), ((await started.json()) as { job: RestoreJob }).job);
  return { status: job.status === "done" ? 200 : job.error_status ?? 500, job, ...(job.error ? { error: job.error } : {}) };
}

/** Every entry of a zip, by name. */
function entriesOf(zip: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    openZip(zip, { lazyEntries: true }, (err, z) => {
      if (err) return reject(err);
      const out = new Map<string, Buffer>();
      z.on("entry", (entry) => {
        if (entry.fileName.endsWith("/")) { z.readEntry(); return; }
        z.openReadStream(entry, (e, stream) => {
          if (e) return reject(e);
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("end", () => { out.set(entry.fileName, Buffer.concat(chunks)); z.readEntry(); });
        });
      });
      z.on("end", () => resolve(out));
      z.readEntry();
    });
  });
}
const zipOf = (entries: Map<string, Buffer>): Buffer => rawZip([...entries].map(([name, data]) => ({ name, data, deflate: true })));

/** A note's saves as the database holds them, oldest first: what the History page is built from. */
async function savesOf(ws: string, noteId: string) {
  return (await q<{ kind: string; title: string | null; markdown: string; at: string; who: string | null; actor_type: string; imported: boolean }>(
    `SELECT e.event_type AS kind, e.payload->>'title' AS title, b.content AS markdown, e.created_at::text AS at,
            coalesce(e.tx_meta->'history_import'->>'actor_name', a.name) AS who, e.actor_type, (e.tx_meta ? 'history_import') AS imported
       FROM domain_events e JOIN blobs b ON b.hash = e.payload->>'body_hash' LEFT JOIN actors a ON a.id::text = e.actor_id
      WHERE e.workspace_id = $1 AND e.target_id = $2 AND e.event_type IN ('NODE_CREATED','NODE_UPDATED','NODE_RESTORED') AND e.payload ? 'body_hash'
      ORDER BY e.created_at, e.id`, [ws, noteId])).rows;
}
const idOfTitle = async (ws: string, title: string) => (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = $2 AND deleted_at IS NULL`, [ws, title])).rows[0]!.id;

describe.skipIf(!enabled)("version history in a backup and a move", () => {
  let source: Awaited<ReturnType<typeof newWorkspace>>;
  let bob: ActorCtx;
  let bot: ActorCtx;
  let aiNoteId = "";
  let plainZip: Buffer;
  let historyZip: Buffer;
  let noteId = "";
  const bodies = ["第一版。\n", "第二版，多一行。\n\n加上一行。\n", "第三版：寫完了。\n", "第四版，又改了。\n"];

  beforeAll(async () => {
    source = await newWorkspace("hist-source");
    const { owner, ws } = source;
    bob = await persistActor(ws, { id: "", name: "Bob", type: "human", role: "editor" });
    const shared = (await createSharedSpace(owner, ws, "共用 Lab")).id;
    await seedQ(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'edit') ON CONFLICT DO NOTHING`, [shared, bob.id]);
    const made = await send(owner, "/api/nodes", "POST", { title: "歷史筆記", markdown: bodies[0], space_id: shared });
    expect(made.status).toBe(201);
    noteId = ((await made.json()) as { id: string }).id;
    for (const markdown of bodies.slice(1, 3)) expect((await send(owner, `/api/nodes/${noteId}`, "PATCH", { markdown })).status).toBe(200);
    expect((await send(bob, `/api/nodes/${noteId}`, "PATCH", { markdown: bodies[3] })).status).toBe(200);
    // Put the first version back, so history holds a restore.
    const first = (await savesOf(ws, noteId));
    expect(first.length).toBe(4);
    const firstId = (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE workspace_id = $1 AND target_id = $2 AND event_type = 'NODE_CREATED'`, [ws, noteId])).rows[0]!.id;
    expect((await app(owner).request(`/api/nodes/${noteId}/versions/${firstId}/restore`, { method: "POST" })).status).toBe(200);
    await send(owner, "/api/nodes", "POST", { title: "沒改過的筆記", markdown: "只有一版\n" });
    // A note an AI changed: its version is AI-authored in the source (and is AI work there: inbox, agent runs, day lens).
    bot = await persistActor(ws, { id: "", name: "整理小幫手", type: "agent", role: "editor" });
    await seedQ(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'edit') ON CONFLICT DO NOTHING`, [shared, bot.id]);
    const aiMade = await send(owner, "/api/nodes", "POST", { title: "AI 改過的筆記", markdown: "人寫的第一版\n", space_id: shared });
    aiNoteId = ((await aiMade.json()) as { id: string }).id;
    expect((await send(bot, `/api/nodes/${aiNoteId}`, "PATCH", { markdown: "AI 改的第二版\n" })).status).toBe(200);
    plainZip = await download(owner);
    historyZip = await download(owner, "?history=1");
  });
  afterAll(() => { current = ""; });

  it("a backup without the option is the format it always was: the same entries byte for byte, no history section, the same README", async () => {
    const plain = await entriesOf(plainZip);
    const withHistory = await entriesOf(historyZip);
    const manifestOf = (entries: Map<string, Buffer>) => JSON.parse(entries.get(".onden/manifest.json")!.toString()) as Record<string, unknown>;
    expect(manifestOf(plain).version).toBe(BACKUP_VERSION);
    expect(Object.keys(manifestOf(plain)).sort()).toEqual(Object.keys(manifestOf(withHistory)).filter((k) => k !== "history").sort());
    expect([...plain.keys()].filter((n) => n.startsWith(".onden/history/"))).toEqual([]);
    // Everything the option does not touch is the same bytes in both archives (a note is a note with or without history).
    const shared = [...plain.keys()].filter((n) => n !== ".onden/manifest.json" && n !== "README.txt");
    expect(shared.length).toBeGreaterThan(3);
    for (const name of shared) expect(withHistory.get(name)?.equals(plain.get(name)!), name).toBe(true);
    expect([...withHistory.keys()].filter((n) => !plain.has(n) && !n.startsWith(".onden/history/"))).toEqual([".onden/manifest.json", "README.txt"].filter((n) => !plain.has(n)));
    // The README of a plain backup is the text it always had (version history is still on its "not included" line);
    // only the history backup corrects that line.
    expect(sha256Hex(plain.get("README.txt")!.toString())).toBe(PLAIN_README_SHA256);
    expect(withHistory.get("README.txt")!.toString()).not.toContain("版本歷史與操作紀錄");
  });

  it("a backup with the option is format 3, one history file per note that has versions, and says how much", async () => {
    const entries = await entriesOf(historyZip);
    const manifest = JSON.parse(entries.get(".onden/manifest.json")!.toString()) as { version: number; history: { notes: number; versions: number; bytes: number } };
    expect(manifest.version).toBe(3);
    expect(manifest.history.notes).toBeGreaterThanOrEqual(2);
    expect(manifest.history.versions).toBeGreaterThanOrEqual(6);
    const lines = entries.get(historyEntryPath(noteId))!.toString().trim().split("\n").map((l) => JSON.parse(l) as HistoryLine);
    expect(lines.map((l) => l.markdown)).toEqual([bodies[0], bodies[1], bodies[2], bodies[3], bodies[0]]);
    expect(lines.map((l) => l.kind)).toEqual(["created", "updated", "updated", "updated", "restored"]);
    expect(lines[3]!.actor.name).toBe("Bob");
    expect(lines.every((l) => sha256Hex(l.markdown) === l.hash)).toBe(true);
    // The size the person sees before choosing it is what the file holds.
    current = source.ws;
    const size = await app(source.owner).request("/api/backup/history-size");
    expect(await size.json()).toEqual(manifest.history);
  });

  it("moving it into a new workspace brings every version back: same text, order, time and author; an old one restores", async () => {
    const target = await newWorkspace("hist-target");
    const result = await move(target.owner, target.personal, historyZip);
    expect(result.status, JSON.stringify(result.error)).toBe(200);
    const moved = result.job!.result!.moved!;
    expect(moved.history).toMatchObject({ failed: [] });
    expect(moved.history!.versions).toBeGreaterThanOrEqual(6);
    expect(moved.not_moved).not.toContain("history");
    expect(moved.not_moved).toContain("operation_log");

    const there = await idOfTitle(target.ws, "歷史筆記");
    const before = await savesOf(source.ws, noteId);
    const after = await savesOf(target.ws, there);
    // The restore wrote its own first save of the current text; it is the same text as the last carried version and the
    // list folds it into that one, so what the person sees is the source's list.
    const carried = after.filter((s) => s.imported);
    expect(after.filter((s) => !s.imported).length).toBe(1);
    expect(carried.length).toBe(before.length);
    expect(carried.map((s) => [s.kind, s.title, s.markdown, s.who, s.at])).toEqual(before.map((s) => [s.kind, s.title, s.markdown, s.who, s.at]));
    const raw = await listNoteVersions(target.ws, target.owner, there, { raw: true });
    expect(raw!.map((v) => v.markdown).slice(0, 5)).toEqual([bodies[0], bodies[0], bodies[3], bodies[2], bodies[1]]);
    const list = await listNoteVersions(target.ws, target.owner, there, { raw: false });
    const sourceList = await listNoteVersions(source.ws, source.owner, noteId, { raw: false });
    expect(list!.map((v) => [v.markdown, v.title, v.actor_name, v.markers])).toEqual(sourceList!.map((v) => [v.markdown, v.title, v.actor_name, v.markers]));

    // Restoring an old version (the second) works, and is one more version.
    const second = (await q<{ id: string }>(`SELECT e.id::text FROM domain_events e WHERE e.workspace_id = $1 AND e.target_id = $2 AND e.tx_meta ? 'history_import'
                                               AND e.body_hash = $3 ORDER BY e.id LIMIT 1`, [target.ws, there, sha256Hex(bodies[1]!)])).rows[0]!.id;
    const restored = await app(target.owner).request(`/api/nodes/${there}/versions/${second}/restore`, { method: "POST" });
    expect(restored.status).toBe(200);
    expect((await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [there])).rows[0]!.markdown).toBe(bodies[1]);
  });

  it("a backup carries history only of notes its maker may read, never another member's private notes", async () => {
    current = source.ws;
    const made = await send(bob, "/api/nodes", "POST", { title: "Bob 的私人筆記", markdown: "v1\n" });
    expect(made.status).toBe(201);
    const secret = ((await made.json()) as { id: string }).id;
    expect((await send(bob, `/api/nodes/${secret}`, "PATCH", { markdown: "v2 祕密\n" })).status).toBe(200);
    const mine = await entriesOf(await download(source.owner, "?history=1"));
    expect([...mine.keys()].filter((n) => n.includes(secret))).toEqual([]);
    expect([...mine.values()].some((b) => b.toString().includes("v2 祕密"))).toBe(false);
    const bobs = await entriesOf(await download(bob, "?history=1"));
    expect(bobs.has(historyEntryPath(secret))).toBe(true);
    expect(bobs.has(historyEntryPath(noteId))).toBe(true); // the shared space's note
  });

  it("a person who does not own the workspace is refused, history or not", async () => {
    const target = await newWorkspace("hist-notowner");
    const member = await persistActor(target.ws, { id: "", name: "Member", type: "human", role: "editor" });
    const result = await move(member, target.personal, historyZip);
    expect(result.status).toBe(403);
  });

  it("an archive that claims format 2 but carries history, or a format this server does not know, is refused whole", async () => {
    const entries = await entriesOf(historyZip);
    const manifest = JSON.parse(entries.get(".onden/manifest.json")!.toString()) as Record<string, unknown>;
    const asOld = new Map(entries);
    asOld.set(".onden/manifest.json", Buffer.from(JSON.stringify({ ...manifest, version: 2 })));
    expect((await upload(source.owner, zipOf(asOld))).status).toBe(400);
    const asNewer = new Map(entries);
    asNewer.set(".onden/manifest.json", Buffer.from(JSON.stringify({ ...manifest, version: 4 })));
    const refused = await upload(source.owner, zipOf(asNewer));
    expect(refused.status).toBe(400);
    expect(refused.error).toMatch(/newer_version/);
  });

  it("an old (format 2) archive moves as it always did, with no history and 'history' still listed as not moved", async () => {
    const target = await newWorkspace("hist-old");
    const result = await move(target.owner, target.personal, plainZip);
    expect(result.status).toBe(200);
    expect(result.job!.result!.moved!.history).toBeNull();
    expect(result.job!.result!.moved!.not_moved).toContain("history");
    // The note arrives with the one save the restore itself made.
    expect((await savesOf(target.ws, await idOfTitle(target.ws, "歷史筆記"))).length).toBe(1);
  });

  it("a version whose text does not match its hash fails that note's history alone, and the result says which", async () => {
    const entries = await entriesOf(historyZip);
    const path = historyEntryPath(noteId);
    const lines = entries.get(path)!.toString().trim().split("\n");
    const bad = JSON.parse(lines[2]!) as HistoryLine;
    bad.markdown = "被改過的內文\n";
    lines[2] = JSON.stringify(bad);
    entries.set(path, Buffer.from(`${lines.join("\n")}\n`));
    const target = await newWorkspace("hist-corrupt");
    const result = await move(target.owner, target.personal, zipOf(entries));
    expect(result.status, JSON.stringify(result.error)).toBe(200);
    const moved = result.job!.result!.moved!;
    expect(moved.history!.failed).toEqual(["歷史筆記"]);
    // The note itself is there, with only the save the restore made; the untouched notes' history came.
    const there = await idOfTitle(target.ws, "歷史筆記");
    expect((await savesOf(target.ws, there)).length).toBe(1);
    expect(moved.history!.notes).toBeGreaterThanOrEqual(1);
    const other = await idOfTitle(target.ws, "沒改過的筆記");
    expect((await savesOf(target.ws, other)).length).toBeGreaterThanOrEqual(1);
  });

  it("carrying the same history twice adds no version", async () => {
    const target = await newWorkspace("hist-twice");
    expect((await move(target.owner, target.personal, historyZip)).status).toBe(200);
    const there = await idOfTitle(target.ws, "歷史筆記");
    const count = async () => (await savesOf(target.ws, there)).length;
    const once = await count();
    const entries = await entriesOf(historyZip);
    const lines = entries.get(historyEntryPath(noteId))!.toString().split("\n");
    const again = await withTransaction(() => importNoteHistory(target.owner, target.ws, there, async function* () { yield* lines; }));
    expect(again).toEqual({ versions: 0, alreadyThere: 5 });
    expect(await count()).toBe(once);
  });

  it("only the owner can write carried versions, and only for a note of this workspace", async () => {
    const target = await newWorkspace("hist-guard");
    const member = await persistActor(target.ws, { id: "", name: "Someone", type: "human", role: "editor" });
    const v: ImportedVersion = { sourceEventId: "1", kind: "created", at: "2020-01-01T00:00:00.000000Z", title: "x", bodyHash: sha256Hex("x"), markdown: "x", actorType: "user", actorName: null, restoredFrom: null };
    await expect(withTransaction(() => appendImportedVersions(member, target.ws, randomUUID(), [v], NO_INVERSE_PATCH))).rejects.toThrow(/owner/);
    await expect(withTransaction(() => appendImportedVersions(target.owner, target.ws, randomUUID(), [v], NO_INVERSE_PATCH))).rejects.toThrow(/not in this workspace/);
  });

  // ── What a move carries, read back by the readers that look for AI work and for undo ──
  let movedPromise: Promise<Awaited<ReturnType<typeof newWorkspace>>> | null = null;
  const movedTarget = () => (movedPromise ??= (async () => {
    const target = await newWorkspace("hist-readers");
    const result = await move(target.owner, target.personal, historyZip);
    expect(result.status, JSON.stringify(result.error)).toBe(200);
    return target;
  })());

  it("a carried AI version is not AI work of the owner: out of the review inbox, the agent runs and the day lens, and the version list still says an AI wrote it", async () => {
    // Control: in the source the same version IS AI work, in all three.
    const filters = { limit: 500, actorId: null, eventType: null, since: null };
    const aiTitle = "AI 改過的筆記";
    const inbox = (ws: string, owner: ActorCtx) => inboxQueue(owner, ws, filters).then((r) => r.events.filter((e) => (e as { target_id: string }).target_id !== "" && (e as { payload?: { title?: string } }).payload?.title === aiTitle));
    const runs = (ws: string, owner: ActorCtx) => agentRunsStartedBetween(owner, ws, new Date(Date.now() - 365 * 86_400_000), new Date(Date.now() + 86_400_000)).then((all) => all.filter((r) => r.notes.some((n) => n.title === aiTitle)));
    const lens = (ws: string, owner: ActorCtx) => dayLens(owner, ws, localDayId()).then((l) => [...l.buckets.agent.items.filter((i) => i.title === aiTitle), ...l.items.filter((i) => i.kind === "agent" && JSON.stringify(i).includes(aiTitle))]);
    expect((await inbox(source.ws, source.owner)).length, "source inbox").toBeGreaterThan(0);
    expect((await runs(source.ws, source.owner)).length, "source agent runs").toBeGreaterThan(0);
    expect((await lens(source.ws, source.owner)).length, "source day lens").toBeGreaterThan(0);

    const target = await movedTarget();
    expect(await inbox(target.ws, target.owner)).toEqual([]);
    expect(await runs(target.ws, target.owner)).toEqual([]);
    expect(await lens(target.ws, target.owner)).toEqual([]);
    expect((await q<{ n: string }>(`SELECT count(*)::text AS n FROM domain_events WHERE workspace_id = $1 AND actor_type = 'ai_agent'`, [target.ws])).rows[0]!.n).toBe("0");

    // The version list keeps the author: an AI, by the name it had.
    const there = await idOfTitle(target.ws, aiTitle);
    for (const raw of [true, false]) {
      const versions = await listNoteVersions(target.ws, target.owner, there, { raw });
      // (the restore's own save of the note's present text is the owner's, the carried AI version is the AI's)
      expect(versions!.filter((v) => v.actor_kind === "agent").map((v) => [v.markdown, v.actor_name]), `raw=${raw}`).toEqual([["AI 改的第二版\n", "整理小幫手"]]);
    }
    // And a backup of the new workspace says so again (the kind survives a second move).
    current = target.ws;
    const again = await entriesOf(await download(target.owner, "?history=1"));
    const lines = again.get(historyEntryPath(there))!.toString().trim().split("\n").map((l) => JSON.parse(l) as HistoryLine);
    expect(lines.find((l) => l.markdown === "AI 改的第二版\n")!.actor).toEqual({ type: "ai_agent", name: "整理小幫手" });
  });

  it("undoing a carried save, of any kind, is refused before anything changes, and the event list does not offer it", async () => {
    const target = await movedTarget();
    const carried = (await q<{ event_id: string; event_type: string; target_id: string }>(
      `SELECT e.id::text AS event_id, e.event_type, e.target_id FROM domain_events e WHERE e.workspace_id = $1 AND e.tx_meta ? 'history_import' ORDER BY e.id`, [target.ws])).rows;
    expect(new Set(carried.map((e) => e.event_type))).toEqual(new Set(["NODE_CREATED", "NODE_UPDATED", "NODE_RESTORED"]));
    const listed = await listEvents(target.owner, target.ws, { limit: "500" } as never);
    expect("events" in listed).toBe(true);
    const flags = new Map(("events" in listed ? listed.events : []).map((e) => [String(e.id), e]));
    const noteIds = [...new Set(carried.map((e) => e.target_id))];
    const snapshot = async () => (await q<{ id: string; markdown: string; deleted_at: string | null; events: string }>(
      `SELECT n.id::text, n.markdown, n.deleted_at::text, (SELECT count(*)::text FROM domain_events WHERE target_id = n.id::text) AS events
         FROM content_nodes n WHERE n.id = ANY($1::uuid[]) ORDER BY n.id`, [noteIds])).rows;
    const before = await snapshot();
    expect(before.every((n) => n.deleted_at === null)).toBe(true);
    for (const e of carried) {
      expect(flags.get(e.event_id), `${e.event_type} listed`).toMatchObject({ restorable: false, restore_blocked_reason: "imported_history" });
      const refused = await restoreEvent(e.event_id, { actor: target.owner, workspaceId: target.ws });
      expect(refused, `${e.event_type} undo`).toMatchObject({ code: "imported_history", status: 409 });
    }
    // Every note is still there, with the same text and the same number of events.
    expect(await snapshot()).toEqual(before);
  });

  it("a history line is refused when its id is a number, its text holds a NUL, or its time is not a real microsecond time", () => {
    const line = (over: Record<string, unknown>) => JSON.stringify({ id: "1", kind: "updated", at: "2024-01-01T00:00:00.000001Z", title: "t", hash: sha256Hex("x"), markdown: "x", actor: { type: "user", name: "A" }, restored_from: null, ...over });
    expect(parseHistoryLine(line({})).id).toBe("1");
    for (const over of [
      { id: 1 }, { restored_from: 1 }, { restored_from: undefined },
      { markdown: "a\u0000b" }, { title: "a\u0000b" }, { actor: { type: "user", name: "a\u0000b" } },
      { at: "2024-01-01T00:00:00.000Z" }, { at: "2024-01-01T00:00:00Z" }, { at: "2024-02-31T00:00:00.000001Z" }, { at: "2024-01-01 00:00:00.000001" }, { at: "2024-01-01T25:00:00.000001Z" },
    ]) expect(() => parseHistoryLine(line(over)), JSON.stringify(over)).toThrow(HistoryLineError);
  });

  /** A move of the history archive with note `noteId`'s file changed by `edit`: the move result and what the target holds. */
  async function moveEdited(name: string, edit: (lines: string[]) => string[] | Promise<string[]>) {
    const entries = await entriesOf(historyZip);
    const path = historyEntryPath(noteId);
    entries.set(path, Buffer.from(`${(await edit(entries.get(path)!.toString().trim().split("\n"))).join("\n")}\n`));
    const target = await newWorkspace(name);
    const result = await move(target.owner, target.personal, zipOf(entries));
    expect(result.status, JSON.stringify(result.error)).toBe(200);
    const there = await idOfTitle(target.ws, "歷史筆記");
    return { target, moved: result.job!.result!.moved!, there, carried: (await savesOf(target.ws, there)).filter((s) => s.imported).length };
  }
  const withLine = (index: number, over: (l: HistoryLine) => HistoryLine) => (lines: string[]) => lines.map((l, i) => (i === index ? JSON.stringify(over(JSON.parse(l) as HistoryLine)) : l));

  it("a version line longer than the cap fails that note's history alone (the reader stops at the cap)", async () => {
    const huge = "字".repeat(MAX_HISTORY_LINE_CHARS + 1);
    const { moved, carried } = await moveEdited("hist-longline", withLine(1, (l) => ({ ...l, markdown: huge, hash: sha256Hex(huge) })));
    expect(moved.history!.failed).toEqual(["歷史筆記"]);
    expect(carried).toBe(0);
    expect(moved.history!.notes).toBeGreaterThanOrEqual(1); // the other notes' history came
  }, 120_000);

  it("a NUL in a version fails that note's history alone, after which the move still finishes", async () => {
    const nul = "有\u0000空字元\n";
    const { moved, carried, there, target } = await moveEdited("hist-nul", withLine(2, (l) => ({ ...l, markdown: nul, hash: sha256Hex(nul) })));
    expect(moved.history!.failed).toEqual(["歷史筆記"]);
    expect(carried).toBe(0);
    expect((await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [there])).rows[0]!.markdown).toBe(bodies[0]);
    expect((await savesOf(target.ws, await idOfTitle(target.ws, "沒改過的筆記"))).length).toBeGreaterThanOrEqual(1);
  });

  it("a version dated after the note was restored is refused (it would sort after the restore's own save), that note's history alone", async () => {
    const { moved, carried } = await moveEdited("hist-future", withLine(4, (l) => ({ ...l, at: "2999-01-01T00:00:00.000001Z" })));
    expect(moved.history!.failed).toEqual(["歷史筆記"]);
    expect(carried).toBe(0);
  });

  it("a numeric id in a history line fails that note's history alone, and nothing is carried twice on a replay", async () => {
    const { moved, carried } = await moveEdited("hist-numid", withLine(0, (l) => ({ ...l, id: Number(l.id) as unknown as string })));
    expect(moved.history!.failed).toEqual(["歷史筆記"]);
    expect(carried).toBe(0);
  });

  it("base_hash follows the previous version across a batch boundary", async () => {
    const target = await newWorkspace("hist-batch");
    const made = await send(target.owner, "/api/nodes", "POST", { title: "很多版本", markdown: "now\n" });
    const there = ((await made.json()) as { id: string }).id;
    const total = 205; // one batch is 200
    const lines = Array.from({ length: total }, (_, i) => {
      const markdown = `版本 ${i}\n`;
      return JSON.stringify({ id: String(i + 1), kind: i === 0 ? "created" : "updated", at: `2024-01-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000001Z`, title: "很多版本", hash: sha256Hex(markdown), markdown, actor: { type: "user", name: "Ann" }, restored_from: null } satisfies HistoryLine);
    });
    await withTransaction(() => importNoteHistory(target.owner, target.ws, there, async function* () { yield* lines; }));
    const rows = (await q<{ body_hash: string; base_hash: string | null }>(
      `SELECT body_hash, base_hash FROM domain_events WHERE target_id = $1 AND tx_meta ? 'history_import' ORDER BY created_at, id`, [there])).rows;
    expect(rows.length).toBe(total);
    expect(rows[0]!.base_hash).toBeNull();
    for (let i = 1; i < total; i++) expect(rows[i]!.base_hash, `version ${i}`).toBe(rows[i - 1]!.body_hash);
  });

  it("a manifest that lies about the history is not believed: the preview and the 'not moved' list count what the files hold", async () => {
    const entries = await entriesOf(historyZip);
    const real = JSON.parse(entries.get(".onden/manifest.json")!.toString()) as { history: { notes: number; versions: number; bytes: number } };
    const files = [...entries].filter(([n]) => n.startsWith(".onden/history/"));
    const truth = { notes: files.length, versions: files.reduce((n, [, b]) => n + b.toString().trim().split("\n").length, 0) };
    const preview = async (manifest: Record<string, unknown>) => {
      const copy = new Map(entries);
      copy.set(".onden/manifest.json", Buffer.from(JSON.stringify(manifest)));
      const target = await newWorkspace("hist-lie");
      const up = await upload(target.owner, zipOf(copy));
      const res = await app(target.owner).request(`/api/backup/restore/${up.id}/preview?space=${target.personal}&mode=workspace`);
      expect(res.status).toBe(200);
      return ((await res.json()) as { move: { history: { notes: number; versions: number } | null; not_moved: string[] } }).move;
    };
    const { history: _gone, ...noHistoryField } = real as Record<string, unknown>;
    const full = JSON.parse(entries.get(".onden/manifest.json")!.toString()) as Record<string, unknown>;
    delete full.history;
    for (const manifest of [full, { ...full, history: { notes: 999, versions: 99999, bytes: 1 } }]) {
      const shown = await preview(manifest);
      expect(shown.history).toMatchObject(truth);
      expect(shown.not_moved).not.toContain("history");
      expect(shown.not_moved).toContain("operation_log");
    }
    expect(noHistoryField.version).toBe(3);
  });
});
