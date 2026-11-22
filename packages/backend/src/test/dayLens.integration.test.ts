// Today lens (GET /api/day/:date/lens) — the day node's auto-aggregated,
// read-only projection of a date's activity. Pins:
//   • bucket correctness: a node created on the date is in `created`; a node
//     edited (NODE_UPDATED) on the date is in `edited`; a node BOTH created and
//     edited that day is in `created` only (dedup);
//   • date windowing: activity on adjacent days does not leak in;
//   • the day node itself (title/slug = the date) never lists in its own lens;
//   • system machinery (source_type='system') and hidden nodes are excluded;
//   • READ POLICY: every bucket is bounded by readableNodeIdSet — a viewer
//     must not see nodes of a space it is not in (or their tasks) in ANY
//     bucket; a bearer token with an empty read-space scope sees nothing;
//   • the `due` bucket matches the agenda's row shape and values;
//   • per-bucket cap (50 items) with a true total.
//
// Mirrors src/test/inboxReadPolicy.integration.test.ts.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { randomUUID } from "node:crypto";
import { q, getWorkspaceId } from "../db.js";
import dayRouter from "../routes/day.js";
import tasksRouter, { addTaskUnderNote } from "../modules/tasks/routes.js";
import { K } from "../services/tasksStore.js";
import { markAsTask } from "./helpers/taskRef.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { seedVersion } from "./helpers/versionFixtures.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
// Production error boundary — router harnesses must map spine errors the
// same way src/index.ts does (401/403 instead of Hono's default 500).
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/day", dayRouter);
app.route("/api/tasks", tasksRouter);
app.post("/api/nodes/:id/tasks", addTaskUnderNote);

let viewer: ActorCtx = { id: "dl-viewer", name: "Viewer", role: "viewer", type: "human" };
let admin: ActorCtx = { id: "dl-admin", name: "Admin", role: "admin", type: "human" };
// A delegated bearer token whose agent is in no space: readable set = ∅.
let scopedToken: ActorCtx = {
  id: "dl-token", name: "Scoped token", role: "admin", type: "agent",
  tokenScope: { tokenId: "dl-tok-1", allowedTools: null, access: "read", writeMode: "apply", expiresAt: null },
};

// Fixed past dates so the suite never collides with "today" activity from
// other tests. Assertions are membership-based (the local onden_test persists
// across runs, so the date's buckets accumulate).
const D = "2020-03-10";
const PREV = "2020-03-09";
const CAP_DATE = "2020-04-20";
const at = (date: string, hh: string) => `${date}T${hh}:00:00Z`;

type LensNode = { id: string; title: string; at: string };
type LensTask = {
  id: string; node_id: string; node_title: string; title: string;
  status: string; due_date: string | null; remind_at?: string | null; recur: string | null; bucket: string;
};
type Bucket<T> = { items: T[]; total: number };
type LensItem = { at?: string; until?: string; kind: string; title: string; ref: { type: string; id: string }; past: boolean; count?: number };
type Lens = { date: string; items: LensItem[]; buckets: { created: Bucket<LensNode>; edited: Bucket<LensNode>; due: Bucket<LensTask>; agent: Bucket<LensNode> } };

describe.skipIf(!isTestDb)("day lens (DB)", () => {
  let WS = "";
  const stamp = Date.now();

  let createdId = "";   // created on D
  let editedId = "";    // created PREV, NODE_UPDATED on D
  let bothId = "";      // created AND edited on D → created only
  let movedId = "";     // created PREV, only moved (no body_hash) on D → not a save, so not edited
  let prevId = "";      // created PREV, edited the day AFTER D → in neither
  let dayNodeId = "";   // the day node itself (title/slug = D)
  let sysId = "";       // source_type='system'
  let hiddenId = "";    // hidden = true
  let agentId = "";     // created PREV, ai_agent NODE_UPDATED on D
  let secretId = "";    // in an admin-only space; created + agent-touched on D, task due D
  let publicTaskId = "";
  let doneTaskId = "";
  let secretTaskId = "";
  let timedTaskId = "";   // day D WITH a reminder time → must still land on day D

  const mkNode = async (
    title: string, opts: { createdAt: string; sourceType?: string; hidden?: boolean; slug?: string } ,
  ): Promise<string> => {
    const r = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, created_at, hidden)
       VALUES ($1, $2, 'content', $3, $4, 'body', $5::timestamptz, $6) RETURNING id`,
      [WS, opts.sourceType ?? "manual", title, opts.slug ?? `dl-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, opts.createdAt, opts.hidden ?? false],
    );
    return r.rows[0]!.id;
  };

  // Raw insert (not the event() helper) so created_at can be a past date.
  const mkEvent = async (nodeId: string, eventType: string, actorType: string, createdAt: string, payload: object = { body_hash: "dl-body" }) => {
    await q(
      `INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, created_at)
       VALUES ($1, $2, $7, $3, 'node', $4, $6::jsonb, $5::timestamptz)`,
      // One actor per run: the timeline merges an actor's edits, and a kept
      // database holds earlier runs' edits on the same fixed day.
      [WS, actorType, eventType, nodeId, createdAt, JSON.stringify(payload), `dl-actor-${stamp}`],
    );
    // a save is a version (History reads them): the author is the kind the event says
    if (eventType.startsWith("NODE_") && "body_hash" in payload) {
      const title = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [nodeId])).rows[0]!.title;
      await seedVersion({ ws: WS, noteId: nodeId, title, markdown: `${title} at ${createdAt}`, at: createdAt, authorKind: actorType === "ai_agent" ? "ai" : "person", kind: eventType === "NODE_CREATED" ? "created" : "updated" });
    }
  };

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    viewer = await persistActor(WS, viewer);
    admin = await persistActor(WS, admin);
    scopedToken = await persistActor(WS, scopedToken);
    // persistActor joins the default space; this agent must reach nothing.
    await q(`DELETE FROM space_members WHERE actor_id = $1::uuid`, [scopedToken.id]);

    createdId = await mkNode(`dl-created-${stamp}`, { createdAt: at(D, "10") });
    editedId = await mkNode(`dl-edited-${stamp}`, { createdAt: at(PREV, "10") });
    await mkEvent(editedId, "NODE_UPDATED", "user", at(D, "11"));
    bothId = await mkNode(`dl-both-${stamp}`, { createdAt: at(D, "09") });
    await mkEvent(bothId, "NODE_UPDATED", "user", at(D, "12"));
    movedId = await mkNode(`dl-moved-${stamp}`, { createdAt: at(PREV, "10") });
    await mkEvent(movedId, "NODE_UPDATED", "user", at(D, "11"), {});
    prevId = await mkNode(`dl-prev-${stamp}`, { createdAt: at(PREV, "10") });
    await mkEvent(prevId, "NODE_UPDATED", "user", at("2020-03-11", "11"));

    // The day node itself: title AND slug are the ISO date. (Unique-slug
    // collision across reruns is avoided by ON CONFLICT-free fresh slug — the
    // date slug may already exist from a prior run, so tolerate that.)
    const existingDay = await q<{ id: string }>(
      `SELECT id FROM content_nodes WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL LIMIT 1`, [WS, D],
    );
    dayNodeId = existingDay.rows[0]?.id
      ?? (await mkNode(D, { createdAt: at(D, "08"), slug: D }));
    await mkEvent(dayNodeId, "NODE_UPDATED", "user", at(D, "13"));

    sysId = await mkNode(`dl-sys-${stamp}`, { createdAt: at(D, "10"), sourceType: "system" });
    hiddenId = await mkNode(`dl-hidden-${stamp}`, { createdAt: at(D, "10"), hidden: true });

    agentId = await mkNode(`dl-agent-${stamp}`, { createdAt: at(PREV, "10") });
    await mkEvent(agentId, "NODE_UPDATED", "ai_agent", at(D, "14"));

    // Restricted node: moved (with its task, below) into a space only the
    // admin belongs to.
    secretId = await mkNode(`dl-secret-node-${stamp}`, { createdAt: at(D, "10") });
    await mkEvent(secretId, "NODE_UPDATED", "ai_agent", at(D, "15"));

    // Tasks due on D: an open one on a public node, a done one (excluded), and
    // an open one on the restricted node. Tasks are NODES (migration 062):
    // hidden #task children with _task_* attrs.
    const mkTaskNode = async (title: string, host: string, status: string, due: string): Promise<string> => {
      const id = randomUUID();
      await seedQ(
        `INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, parent_id, hidden)
         VALUES ($1, $2, 'manual', 'content', $3, $4, '', $5, true)`,
        [id, WS, title, `task-${id}`, host]);
      await markAsTask(WS, id);
      await seedQ(
        `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source)
         VALUES ($1, $2, '${K.status}', $3, 'text', false, 'explicit'),
                ($1, $2, '${K.when}', $4, 'text', false, 'explicit')`,
        [WS, id, status, due]);
      return id;
    };
    publicTaskId = await mkTaskNode(`dl-task-${stamp}`, createdId, "todo", D);
    doneTaskId = await mkTaskNode(`dl-done-task-${stamp}`, createdId, "done", D);
    secretTaskId = await mkTaskNode(`dl-secret-task-${stamp}`, secretId, "todo", D);
    timedTaskId = await mkTaskNode(`dl-timed-task-${stamp}`, createdId, "todo", D);
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, is_inheritable, source)
             VALUES ($1, $2, '${K.remindAt}', $3, 'text', false, 'explicit')`, [WS, timedTaskId, `${D}T14:30`]);
    await putInSpace(secretId, await adminOnlySpace(WS, `dl-secret-${stamp}`, [admin.id]));
  });

  const lens = async (date = D): Promise<Lens> =>
    (await (await app.request(`/api/day/${date}/lens`)).json()) as Lens;
  const hasNode = (b: Bucket<LensNode>, id: string) => b.items.some((n) => n.id === id);
  const hasTask = (b: Bucket<LensTask>, id: string) => b.items.some((t) => t.id === id);

  it("buckets: created vs edited dedup, agent bucket, totals", async () => {
    currentActor = admin;
    const l = await lens();
    expect(hasNode(l.buckets.created, createdId)).toBe(true);
    expect(hasNode(l.buckets.edited, editedId)).toBe(true);
    // edited is History's definition: a move that saved no text is not an edit.
    expect(hasNode(l.buckets.edited, movedId)).toBe(false);
    // created AND edited the same day → created only.
    expect(hasNode(l.buckets.created, bothId)).toBe(true);
    expect(hasNode(l.buckets.edited, bothId)).toBe(false);
    // agent-touched → agent bucket (and, being a NODE_UPDATED, also edited).
    expect(hasNode(l.buckets.agent, agentId)).toBe(true);
    expect(hasNode(l.buckets.edited, agentId)).toBe(true);
    // user-only activity stays out of the agent bucket.
    expect(hasNode(l.buckets.agent, editedId)).toBe(false);
    // totals are consistent with (capped) items.
    for (const b of Object.values(l.buckets)) {
      expect(b.total).toBeGreaterThanOrEqual(b.items.length);
      expect(b.items.length).toBeLessThanOrEqual(50);
    }
  });

  it("date windowing: adjacent days' activity does not leak in", async () => {
    currentActor = admin;
    const l = await lens();
    expect(hasNode(l.buckets.created, prevId)).toBe(false);
    expect(hasNode(l.buckets.created, editedId)).toBe(false); // created PREV
    expect(hasNode(l.buckets.edited, prevId)).toBe(false);    // edited the day AFTER
    // PREV's lens has the PREV-created nodes, not D's.
    const lp = await lens(PREV);
    expect(hasNode(lp.buckets.created, editedId)).toBe(true);
    expect(hasNode(lp.buckets.created, createdId)).toBe(false);
  });

  it("the day node itself never lists in its own lens", async () => {
    currentActor = admin;
    const l = await lens();
    expect(hasNode(l.buckets.created, dayNodeId)).toBe(false);
    expect(hasNode(l.buckets.edited, dayNodeId)).toBe(false);
    expect(hasNode(l.buckets.agent, dayNodeId)).toBe(false);
  });

  it("system and hidden nodes are excluded", async () => {
    currentActor = admin;
    const l = await lens();
    expect(hasNode(l.buckets.created, sysId)).toBe(false);
    expect(hasNode(l.buckets.created, hiddenId)).toBe(false);
  });

  it("read policy: a viewer sees NO restricted node in any bucket; the admin does", async () => {
    currentActor = viewer;
    const v = await lens();
    expect(hasNode(v.buckets.created, secretId)).toBe(false);
    expect(hasNode(v.buckets.edited, secretId)).toBe(false);
    expect(hasNode(v.buckets.agent, secretId)).toBe(false);
    expect(hasTask(v.buckets.due, secretTaskId)).toBe(false);
    // public activity still shows for the viewer
    expect(hasNode(v.buckets.created, createdId)).toBe(true);
    expect(hasTask(v.buckets.due, publicTaskId)).toBe(true);

    currentActor = admin;
    const a = await lens();
    expect(hasNode(a.buckets.created, secretId)).toBe(true);
    expect(hasNode(a.buckets.agent, secretId)).toBe(true);
    expect(hasTask(a.buckets.due, secretTaskId)).toBe(true);
  });

  it("read policy: a bearer token with an empty read-space scope sees empty buckets", async () => {
    currentActor = scopedToken;
    const t = await lens();
    for (const b of Object.values(t.buckets)) {
      expect(b.items.length).toBe(0);
      expect(b.total).toBe(0);
    }
  });

  it("due bucket: matches the agenda's rows for the same task; done tasks stay out", async () => {
    currentActor = admin;
    const l = await lens();
    expect(hasTask(l.buckets.due, doneTaskId)).toBe(false);
    const lensRow = l.buckets.due.items.find((t) => t.id === publicTaskId)!;
    expect(lensRow).toBeTruthy();

    const agenda = await (await app.request("/api/tasks/agenda")).json() as
      { buckets: Record<string, LensTask[]> };
    const agendaRow = Object.values(agenda.buckets).flat().find((t) => t.id === publicTaskId)!;
    expect(agendaRow, "the same task is on the agenda").toBeTruthy();
    // Same shape, same values — the frontend reuses the agenda rendering.
    expect(lensRow).toEqual(agendaRow);
    expect(lensRow.bucket).toBe("overdue"); // due 2020 < today
  });

  it("due bucket: a task with a reminder time still lands on its day", async () => {
    // A task's day (`_task_when`) is a date; a time of day is its reminder
    // (`_task_remind_at`, migration 135). The reminder does not move the day.
    currentActor = admin;
    const l = await lens();
    expect(hasTask(l.buckets.due, timedTaskId)).toBe(true);
    const row = l.buckets.due.items.find((t) => t.id === timedTaskId)!;
    expect(row.due_date).toBe(D);
    expect(row.remind_at).toBe(`${D}T14:30`);
    expect(row.bucket).toBe("overdue"); // 2020 date → overdue regardless of time
  });

  it("caps each bucket at 50 items while reporting the true total", async () => {
    currentActor = admin;
    await seedQ(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, created_at)
       SELECT $1, 'manual', 'content', 'dl-cap-${stamp}-' || i, 'dl-cap-${stamp}-' || i, '', $2::timestamptz
       FROM generate_series(1, 55) AS i`,
      [WS, at(CAP_DATE, "10")],
    );
    const l = await lens(CAP_DATE);
    expect(l.buckets.created.items.length).toBe(50);
    expect(l.buckets.created.total).toBeGreaterThanOrEqual(55);
  });

  it("rejects malformed and impossible dates with 400", async () => {
    currentActor = admin;
    expect((await app.request("/api/day/notadate/lens")).status).toBe(400);
    expect((await app.request("/api/day/2026-13-01/lens")).status).toBe(400);
    expect((await app.request("/api/day/2026-02-31/lens")).status).toBe(400);
  });

  it("items: edits merge into runs, creations and agent work are timed, unreadable notes never appear", async () => {
    currentActor = admin;
    const l = await lens();
    const byRef = (kind: string, id: string) => l.items.find((i) => i.kind === kind && i.ref.id === id);
    expect(byRef("created", createdId)?.at).toBe(at(D, "10").replace(":00Z", ":00.000Z"));
    expect(byRef("agent", agentId)).toBeDefined();
    // dl-actor edits editedId 11:00 and agentId 14:00 (hours apart): separate runs, each one note.
    expect(byRef("edit", editedId)).toMatchObject({ count: 1, title: expect.stringContaining("dl-edited") });
    // The day node never lists in its own lens; the unreadable note is absent for a viewer.
    expect(l.items.some((i) => i.ref.id === dayNodeId)).toBe(false);
    currentActor = viewer;
    const asViewer = await lens();
    expect(asViewer.items.some((i) => i.ref.id === secretId)).toBe(false);
    currentActor = admin;
    expect((await lens()).items.some((i) => i.ref.id === secretId)).toBe(true);
    // Sorted by time.
    const times = l.items.map((i) => i.at ?? "");
    expect(times).toEqual([...times].sort());
  });
});
