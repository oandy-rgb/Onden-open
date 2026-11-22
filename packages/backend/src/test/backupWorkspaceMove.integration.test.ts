// Moving a whole workspace (services/backupWorkspaceMove.ts): the backup of one
// workspace restored into a new one, downloaded again and restored into a third.
// The first and the third hold the same notes, slugs, trees, spaces, tags,
// attributes, board positions, drawings, attachments and links; the person's
// review progress, subscriptions, settings and the site come along. And who may
// move, and into what, is checked.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";

let current = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => current }));
import { apiOnError } from "../httpError.js";
import backupRouter from "../routes/backup.js";
import nodesRouter from "../routes/nodes.js";
import tasksRouter from "../modules/tasks/routes.js";
import { storeMedia } from "../services/media.js";
import { createTag } from "../services/tagHierarchy.js";
import { applyTagToNode } from "../services/tagMembershipWrites.js";
import { setNodeAttribute } from "../services/attributeWrites.js";
import { createSharedSpace } from "../services/spaces.js";
import type { RestoreJob } from "@onden/contract";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { waitForJob } from "./helpers/restoreJob.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { ensureInboxTag } from "../modules/capture/inboxTag.js";
import { seedQ } from "./helpers/seedQ.js";
import { noteViewsOf, type NoteView } from "./helpers/noteViews.js";
import { publishDefaultSpace } from "./helpers/spaceFixtures.js";

registerShippedModules();
const enabled = isTestDatabase();

function app(actor: ActorCtx) {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/backup", backupRouter);
  hono.route("/api/nodes", nodesRouter);
  hono.route("/api/tasks", tasksRouter);
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

async function download(actor: ActorCtx): Promise<Buffer> {
  const res = await app(actor).request("/api/backup/full.zip");
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}
async function upload(actor: ActorCtx, zip: Buffer): Promise<string> {
  const res = await app(actor).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { upload_id: string }).upload_id;
}
/** Move `zip` into the workspace of `actor`; the job as it ended. */
async function move(actor: ActorCtx, personal: string, zip: Buffer): Promise<{ status: number; job?: RestoreJob; error?: string }> {
  const id = await upload(actor, zip);
  const started = await app(actor).request(`/api/backup/restore/${id}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: personal, mode: "workspace" }) });
  if (started.status !== 202 && started.status !== 200) return { status: started.status, error: ((await started.json()) as { error?: string }).error };
  const job = await waitForJob(app(actor), ((await started.json()) as { job: RestoreJob }).job);
  return { status: job.status === "done" ? 200 : job.error_status ?? 500, job, ...(job.error ? { error: job.error } : {}) };
}
const previewMove = async (actor: ActorCtx, zip: Buffer, personal: string) => {
  const id = await upload(actor, zip);
  const res = await app(actor).request(`/api/backup/restore/${id}/preview?space=${personal}&mode=workspace`);
  return { status: res.status, body: await res.json() as { refusal: string | null; move: { spaces: Array<{ name: string; kind: string; had_others: boolean; notes: number }>; carries: Array<{ kind: string; count: number }>; clears: { notes: number; tags: number } } | null } };
};

const comparable = (views: Map<string, NoteView>) => [...views.values()].sort((a, b) => a.key.localeCompare(b.key));
/** The tags a person made, by name: colour, text. */
const tagsOf = async (ws: string) => (await q<{ title: string; tag_color: string | null; markdown: string }>(
  `SELECT title, tag_color, markdown FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND deleted_at IS NULL AND title LIKE 'mv%' ORDER BY title`, [ws])).rows;

describe.skipIf(!enabled)("moving a whole workspace", () => {
  let source: Awaited<ReturnType<typeof newWorkspace>>;
  let first: Awaited<ReturnType<typeof newWorkspace>>;
  let third: Awaited<ReturnType<typeof newWorkspace>>;
  let bob: ActorCtx;
  let zip1: Buffer;
  let zip2: Buffer;
  let firstReport: NonNullable<NonNullable<RestoreJob["result"]>["moved"]>;
  let snapSource: Map<string, NoteView>;
  let snapFirst: Map<string, NoteView>;
  let snapThird: Map<string, NoteView>;

  beforeAll(async () => {
    source = await newWorkspace("source");
    const { ws, owner } = source;
    const shared = (await createSharedSpace(owner, ws, "共用 Lab")).id;
    bob = await persistActor(ws, { id: "", name: "Bob", type: "human", role: "editor" });
    await seedQ(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'edit') ON CONFLICT DO NOTHING`, [shared, bob.id]);
    const create = async (title: string, markdown: string, extra: Record<string, unknown> = {}) => {
      const res = await send(owner, "/api/nodes", "POST", { title, markdown, ...extra });
      expect(res.status, await res.clone().text()).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    // Same-titled twins, the older one in the trash; links to them.
    const old = await create("二分搜尋法", "舊的。\n");
    await send(owner, `/api/nodes/${old}`, "DELETE");
    await create("二分搜尋法", "新的。\n");
    await create("Index", "見 [[二分搜尋法]]。\n");
    // A tree, in the personal and the shared space.
    const parent = await create("Parent", "p\n");
    const child = await create("Child", "c\n", { parent_id: parent });
    await create("共用筆記", "在共用空間。\n", { space_id: shared });
    // Tasks with a clock time, a finished one, one in the trash.
    const plan = await create("Plan", "- [ ] 晨跑 {task}\n- [x] 喝水 {task}\n- [ ] 暫時的 {task}\n");
    const tasks = (await q<{ id: string; title: string }>(`SELECT id::text, title FROM content_nodes WHERE parent_id = $1 AND hidden`, [plan])).rows;
    const tid = (title: string) => tasks.find((t) => t.title === title)!.id;
    await send(owner, `/api/tasks/${tid("晨跑")}`, "PATCH", { when_date: "2026-11-09", time: "07:30", until: "08:15" });
    const body = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [plan])).rows[0]!.markdown;
    await send(owner, `/api/nodes/${plan}`, "PATCH", { markdown: body.split("\n").filter((l) => !l.includes("暫時的")).join("\n") });
    // Attributes: system ones, a drawing; a tag with colour, text and a note; an attachment.
    const marked = await create("Marked", "內文\n");
    for (const [key, value] of [["_import_source_id", "obsidian:7"], ["_pinned", "true"], ["_published", "true"]]) {
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, $3, $4, 'text', 'ui')`, [ws, marked, key, value]);
    }
    await setNodeAttribute({ workspaceId: ws, actor: owner, nodeId: child, attribute: { key: "ink_data", value: `{"v":1,"items":["${randomUUID()}"]}` } });
    const stored = await storeMedia(Buffer.from(`%PDF-1.4 move ${randomUUID()}`), ".pdf", { actor: owner, workspaceId: ws, origin: "upload" });
    if (!stored.ok) throw new Error(stored.reason);
    await create("Attach", `[file](/api/media/${stored.filename})\n`);
    const tag = (await createTag({ actor: owner, workspaceId: ws, name: `mvbooks` })).id;
    await send(owner, `/api/nodes/${tag}`, "PATCH", { markdown: "記錄書籍的資訊" });
    await seedQ(`UPDATE content_nodes SET tag_color = '#336699' WHERE id = $1`, [tag]);
    await applyTagToNode({ workspaceId: ws, actor: owner, nodeId: marked, tagId: tag });
    // A card on a board.
    const board = await create("Board", "b\n");
    await seedQ(`INSERT INTO node_positions (workspace_id, node_id, surface, x, y) VALUES ($1, $2, $3, 120, 340)`, [ws, child, board]);
    // The person's own state and the workspace's settings.
    await seedQ(`INSERT INTO review_states (workspace_id, node_id, actor_id, state) VALUES ($1, $2, $3, '{"due":"2026-11-10"}')`, [ws, marked, owner.id]);
    // The note is a review card itself (its own reference), made by the "make this note a card" command.
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, 'review', $2)`, [ws, marked]);
    await seedQ(`INSERT INTO focus_sessions (id, workspace_id, actor_id, task_id, started_at, ended_at, note) VALUES ($1, $2, $3, $4, '2026-11-05T01:00:00Z', '2026-11-05T01:25:00Z', '專注')`, [randomUUID(), ws, owner.id, tid("喝水")]);
    await seedQ(`INSERT INTO rss_subscriptions (workspace_id, space_id, title, url, created_by_actor_id) VALUES ($1, $2, '某個 Feed', 'https://example.com/feed.xml', $3)`, [ws, shared, owner.id]);
    await seedQ(`INSERT INTO actor_prefs (actor_id, key, value) VALUES ($1, 'nav', '{"order":["notes","tasks"],"phone":2}')`, [owner.id]);
    await seedQ(`INSERT INTO publish_snapshots (workspace_id, title, home_node_id, event_cursor, payload) VALUES ($1, '我的網站', $2, 1, '{"nodes":[]}')`, [ws, marked]);

    snapSource = await noteViewsOf(ws);
    zip1 = await download(owner);

    first = await newWorkspace("first");
    const done = await move(first.owner, first.personal, zip1);
    expect(done.status, JSON.stringify(done)).toBe(200);
    firstReport = done.job!.result!.moved!;
    snapFirst = await noteViewsOf(first.ws);
    zip2 = await download(first.owner);

    third = await newWorkspace("third");
    const again = await move(third.owner, third.personal, zip2);
    expect(again.status, JSON.stringify(again)).toBe(200);
    snapThird = await noteViewsOf(third.ws);
  });

  it("the first and the third workspace hold the same notes: titles, bodies, slugs, trees, spaces, tags, attributes, positions, links", () => {
    expect(comparable(snapThird)).toEqual(comparable(snapSource));
    expect(comparable(snapFirst)).toEqual(comparable(snapSource));
    const live = [...snapThird.values()].find((n) => n.title === "二分搜尋法" && !n.deleted)!;
    expect(live.slug).toBe("二分搜尋法");
    const index = [...snapThird.values()].find((n) => n.title === "Index")!;
    expect(index.edges).toEqual(expect.arrayContaining([expect.stringContaining("二分搜尋法")]));
    expect([...snapThird.values()].filter((n) => n.title === "共用筆記").map((n) => n.space)).toEqual(["共用 Lab"]);
    expect([...snapThird.values()].find((n) => n.title === "Marked")!.attributes).toEqual(expect.objectContaining({ _import_source_id: "obsidian:7", _pinned: "true", _published: "true" }));
  });

  it("the tags keep their colour and text; the person's progress, subscriptions, settings and site come along", async () => {
    expect(await tagsOf(third.ws)).toEqual(await tagsOf(source.ws));
    expect((await tagsOf(third.ws))[0]).toEqual(expect.objectContaining({ tag_color: "#336699", markdown: "記錄書籍的資訊" }));
    const counts = async (ws: string, actor: ActorCtx) => ({
      review: (await q(`SELECT 1 FROM review_states WHERE workspace_id = $1 AND actor_id = $2`, [ws, actor.id])).rowCount,
      focus: (await q(`SELECT 1 FROM focus_sessions WHERE workspace_id = $1 AND actor_id = $2 AND note = '專注'`, [ws, actor.id])).rowCount,
      rss: (await q(`SELECT 1 FROM rss_subscriptions WHERE workspace_id = $1 AND url = 'https://example.com/feed.xml'`, [ws])).rowCount,
      nav: (await q(`SELECT 1 FROM actor_prefs WHERE actor_id = $1 AND key = 'nav'`, [actor.id])).rowCount,
      site: (await q(`SELECT 1 FROM publish_snapshots WHERE workspace_id = $1 AND title = '我的網站'`, [ws])).rowCount,
    });
    expect(await counts(third.ws, third.owner)).toEqual(await counts(source.ws, source.owner));
    expect(await counts(third.ws, third.owner)).toEqual({ review: 1, focus: 1, rss: 1, nav: 1, site: 1 });
    // The subscription sits in the shared space it was in.
    const space = (await q<{ name: string }>(`SELECT s.name FROM rss_subscriptions r JOIN spaces s ON s.id = r.space_id WHERE r.workspace_id = $1`, [third.ws])).rows[0]!.name;
    expect(space).toBe("共用 Lab");
  });

  it("a note that is a review card is still a card after a move, and a plain note is not", async () => {
    const cardTitles = async (ws: string) => (await q<{ title: string }>(
      `SELECT n.title FROM function_refs r JOIN content_nodes n ON n.id = r.holder_node_id WHERE r.workspace_id = $1 AND r.function_id = 'review' ORDER BY n.title`, [ws])).rows.map((r) => r.title);
    expect(await cardTitles(source.ws)).toEqual(["Marked"]);
    expect(await cardTitles(first.ws)).toEqual(["Marked"]);
    expect(await cardTitles(third.ws)).toEqual(["Marked"]);
  });

  it("members are not rebuilt: the shared space has only its owner, and the result says who to invite again", async () => {
    // Bob is in the default space and in the shared one: both had other people.
    expect(firstReport.need_reinvite).toEqual(expect.arrayContaining(["共用 Lab"]));
    expect(firstReport.not_moved).toEqual(expect.arrayContaining(["history", "ai_keys", "push"]));
    const members = (await q<{ n: string }>(`SELECT count(*)::text AS n FROM space_members m JOIN spaces s ON s.id = m.space_id WHERE s.workspace_id = $1 AND s.name = '共用 Lab'`, [first.ws])).rows[0]!.n;
    expect(members).toBe("1");
    expect((await q(`SELECT 1 FROM actors WHERE workspace_id = $1 AND name = 'Bob'`, [first.ws])).rowCount).toBe(0);
  });

  it("only the owner, and only into a new workspace", async () => {
    // A workspace with a note of its own is not new.
    const used = await newWorkspace("used");
    await send(used.owner, "/api/nodes", "POST", { title: "我的筆記", markdown: "x\n" });
    expect(await move(used.owner, used.personal, zip1)).toEqual({ status: 409, error: "workspace_not_new" });
    expect((await previewMove(used.owner, zip1, used.personal)).body.refusal).toBe("workspace_not_new");
    // Another person in the workspace: not new either.
    const crowded = await newWorkspace("crowded");
    await persistActor(crowded.ws, { id: "", name: "Guest", type: "human", role: "editor" });
    expect((await move(crowded.owner, crowded.personal, zip1)).error).toBe("workspace_not_new");
    // A member who is not the owner.
    const notOwner = await newWorkspace("notowner");
    const member = await persistActor(notOwner.ws, { id: "", name: "Member", type: "human", role: "editor" });
    const memberPersonal = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal'`, [member.id])).rows[0]!.id;
    expect((await move(member, memberPersonal, zip1)).error).toBe("not_workspace_owner");
    // A tag of its own makes it not new; a fresh workspace with only the built-in ones is.
    const tagged = await newWorkspace("tagged");
    await createTag({ actor: tagged.owner, workspaceId: tagged.ws, name: "mine" });
    expect((await move(tagged.owner, tagged.personal, zip1)).error).toBe("workspace_not_new");
    const fresh = await newWorkspace("fresh");
    const shown = await previewMove(fresh.owner, zip1, fresh.personal);
    expect(shown.body.refusal).toBeNull();
    expect(shown.body.move!.spaces.map((s) => [s.name, s.kind, s.had_others])).toEqual(expect.arrayContaining([["共用 Lab", "shared", true]]));
    expect(shown.body.move!.carries).toEqual(expect.arrayContaining([{ kind: "progress", count: 1 }, { kind: "focus_records", count: 1 }, { kind: "feeds", count: 1 }, { kind: "settings", count: 1 }, { kind: "site", count: 1 }]));
  });

  it("the sample notes of the new workspace are cleared, not mixed in", async () => {
    const trial = await newWorkspace("trial");
    const sample = ((await (await send(trial.owner, "/api/nodes", "POST", { title: "歡迎來到 Onden 試用版", markdown: "範例\n- [ ] 把試用版逛一圈 {task}\n" })).json()) as { id: string }).id;
    const sampleTag = (await createTag({ actor: trial.owner, workspaceId: trial.ws, name: "範例" })).id;
    await seedQ(`CREATE TABLE IF NOT EXISTS browser_app_state (key text PRIMARY KEY, value jsonb NOT NULL)`);
    await seedQ(`INSERT INTO browser_app_state (key, value) VALUES ('sample-notes', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ notes: [sample], tags: [sampleTag] })]);
    try {
      const done = await move(trial.owner, trial.personal, zip1);
      expect(done.status, JSON.stringify(done)).toBe(200);
      expect(done.job!.result!.moved!.cleared).toEqual({ notes: 1, tags: 1 });
      const live = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE workspace_id = $1 AND deleted_at IS NULL AND node_type <> 'class_tag' AND NOT hidden`, [trial.ws])).rows.map((r) => r.title);
      expect(live).not.toContain("歡迎來到 Onden 試用版");
      expect(live).toContain("Marked");
    } finally {
      await seedQ(`DELETE FROM browser_app_state WHERE key = 'sample-notes'`);
    }
  });

  it("clearing the samples leaves a module's tag (the inbox) in place instead of failing the move", async () => {
    const trial = await newWorkspace("trial-inbox");
    const inbox = await ensureInboxTag(trial.owner, trial.ws);
    await seedQ(`CREATE TABLE IF NOT EXISTS browser_app_state (key text PRIMARY KEY, value jsonb NOT NULL)`);
    await seedQ(`INSERT INTO browser_app_state (key, value) VALUES ('sample-notes', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ notes: [], tags: [inbox] })]);
    try {
      const done = await move(trial.owner, trial.personal, zip1);
      expect(done.status, JSON.stringify(done)).toBe(200);
      expect(done.job!.result!.moved!.cleared.tags).toBe(0);
      expect((await q(`SELECT 1 FROM content_nodes WHERE id = $1 AND deleted_at IS NULL`, [inbox])).rowCount).toBe(1);
    } finally {
      await seedQ(`DELETE FROM browser_app_state WHERE key = 'sample-notes'`);
    }
  });
});
