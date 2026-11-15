// 反覆操作 — doing the same thing over and over must CONVERGE, not accumulate.
// These assert the substrate's idempotency / break-or-make guarantees that
// only show up under repetition (a single pass can't catch a duplicate-on-
// re-save or a double-mint). Run against the real spine + Postgres.
//
//   1. re-saving the same body N times keeps ONE wikilink edge (not N)
//   2. applying the same tag twice is one membership, not two
//   3. completing a recurring task repeatedly mints EXACTLY one next
//      occurrence each time, its due advancing by one interval (break-or-make)
//
// SAFETY: only runs against a *_test database (describe.skipIf).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { pool, q } from "../db.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import nodeRouter from "../routes/nodes.js";
import tagsRouter from "../routes/tags.js";
import tasksRouter, { addTaskUnderNote } from "../modules/tasks/routes.js";
import type { ActorCtx } from "../types.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

// The routes find the file's own workspace through getWorkspaceId.
let workspaceId = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodeRouter);
app.route("/api/tags", tagsRouter);
app.route("/api/tasks", tasksRouter);
app.post("/api/nodes/:id/tasks", addTaskUnderNote);

const J = { "content-type": "application/json" };
const createNote = async (title: string, markdown = "") => {
  const res = await app.request("/api/nodes", { method: "POST", headers: J, body: JSON.stringify({ title, markdown }) });
  expect(res.status, `create "${title}"`).toBe(201);
  return (await res.json()) as { id: string };
};
const editNote = (id: string, markdown: string, title: string) =>
  app.request(`/api/nodes/${id}`, { method: "PATCH", headers: J, body: JSON.stringify({ title, markdown }) });
const applyTag = (nodeId: string, tagId: string) =>
  app.request(`/api/nodes/${nodeId}/tags/${tagId}`, { method: "PUT", headers: J, body: "{}" });
const addTask = (nodeId: string, body: unknown) =>
  app.request(`/api/nodes/${nodeId}/tasks`, { method: "POST", headers: J, body: JSON.stringify(body) });
const patchTask = (id: string, body: unknown) =>
  app.request(`/api/tasks/${id}`, { method: "PATCH", headers: J, body: JSON.stringify(body) });

const edgeCount = async (sourceId: string, targetId: string) =>
  (await q<{ n: string }>(
    `SELECT count(*) AS n FROM node_edges WHERE source_node_id = $1 AND target_node_id = $2 AND origin = 'wikilink'`,
    [sourceId, targetId],
  )).rows[0]!.n;
const tagRowCount = async (nodeId: string, tagId: string) =>
  (await q<{ n: string }>(`SELECT count(*) AS n FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [nodeId, tagId])).rows[0]!.n;
// Open (not done/cancelled) task occurrences under a host, with their due dates.
const openOccurrences = async (hostId: string): Promise<Array<{ id: string; due: string | null }>> => {
  const r = await q<{ id: string; due: string | null }>(
    `SELECT t.id, d.value AS due
       FROM content_nodes t
       JOIN node_attributes s ON s.node_id = t.id AND s.key = '_task_status'
       LEFT JOIN node_attributes d ON d.node_id = t.id AND d.key = '_task_when'
      WHERE t.parent_id = $1 AND t.deleted_at IS NULL
        AND s.value NOT IN ('done', 'cancelled')
      ORDER BY d.value ASC NULLS LAST`,
    [hostId],
  );
  return r.rows;
};

describe.skipIf(!isTestDb)("repeated operations converge (idempotency / break-or-make)", () => {
  beforeAll(async () => {
    // A workspace of the file's own: the actor below becomes its owner, which
    // on the shared 'default' workspace would leak into every later file.
    const ws = await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Repeated ops', $1) RETURNING id`, [`repeated-ops-${randomUUID()}`],
    );
    workspaceId = ws.rows[0]!.id;
    const r = await q<{ id: string }>(
      `INSERT INTO actors (workspace_id, name, type) VALUES ($1, 'Doer', 'human') RETURNING id`,
      [workspaceId],
    );
    currentActor = { id: r.rows[0]!.id, name: "Doer", role: "admin", type: "human" };
    // Creating a tag definition (POST /api/tags/import) is the workspace owner's.
    await setWorkspaceOwner(workspaceId, r.rows[0]!.id);
  });

  afterAll(async () => {
    // Saves queue fire-and-forget cascades; one still running when the pool
    // ends rejects with nobody awaiting it.
    await awaitAllDispatchers();
    await pool.end();
  });

  it("re-saving the same body keeps exactly one wikilink edge", async () => {
    // A title of its own: [[Edge Target]] would also match earlier runs' notes.
    const name = `Edge Target ${Date.now()}`;
    const target = await createNote(name, "x");
    const source = await createNote("Edge Source", `links to [[${name}]]`);
    expect(await edgeCount(source.id, target.id)).toBe("1");
    // Re-save the identical body three times — sync DELETEs + re-inserts; the
    // edge must not multiply (and ON CONFLICT keeps it single even if it did).
    for (let i = 0; i < 3; i++) {
      expect((await editNote(source.id, `links to [[${name}]]`, "Edge Source")).status).toBe(200);
    }
    expect(await edgeCount(source.id, target.id)).toBe("1");
  });

  it("applying the same tag twice is one membership", async () => {
    const tag = await (await app.request("/api/tags/import", {
      method: "POST", headers: J, body: JSON.stringify({ name: `topic-${Date.now()}`, fields: [] }), // unique: earlier runs' tags stay
    })).json() as { id: string };
    const note = await createNote("Tagged note", "body");
    expect((await applyTag(note.id, tag.id)).status).toBe(200);
    expect((await applyTag(note.id, tag.id)).status).toBe(200); // again
    expect(await tagRowCount(note.id, tag.id)).toBe("1");
  });

  it("completing a recurring task repeatedly mints one next occurrence each time", async () => {
    const today = (await q<{ d: string }>(`SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS d`)).rows[0]!.d;
    const host = await createNote("Daily standup host", "recurring work");
    const first = (await (await addTask(host.id, { title: "Daily standup", due_date: today, recur: "1d" })).json()) as { id: string };

    // exactly one open occurrence to start
    let open = await openOccurrences(host.id);
    expect(open.length).toBe(1);
    expect(open[0]!.due).toBe(today);

    // Complete it three times in a row — break-or-make: each completion mints
    // the NEXT occurrence and leaves exactly one open, its due one day later.
    let current = first.id;
    let expectedDue = today;
    for (let i = 0; i < 3; i++) {
      expect((await patchTask(current, { status: "done" })).status).toBe(200);
      open = await openOccurrences(host.id);
      expect(open.length, `after completion ${i + 1} exactly one open occurrence`).toBe(1);
      const nextDue = open[0]!.due!;
      expect(nextDue > expectedDue, "due advanced by one interval").toBe(true);
      expectedDue = nextDue;
      current = open[0]!.id;
    }
  });
});
