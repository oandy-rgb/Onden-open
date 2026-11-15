// Real PostgreSQL: an event that names a node must follow that node's read
// policy whatever its target_type string says. TASK_OCCURRENCE_MISSED used to be
// written with target_type "task", and /api/events showed every non-"node"
// event to all humans, leaking the titles of tasks under restricted notes.
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import * as db from "../db.js";
import { apiOnError } from "../httpError.js";
import eventsRouter from "../routes/events.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

let ws: string;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
let admin: ActorCtx = { id: "et-admin", name: "Admin", role: "admin", type: "human" };
let viewer: ActorCtx = { id: "et-viewer", name: "Viewer", role: "viewer", type: "human" };

async function feed(actor: ActorCtx): Promise<Array<{ event_type: string; target_type: string; target_id: string; payload: { title?: string } }>> {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/events", eventsRouter);
  const res = await app.request("/api/events?limit=200");
  expect(res.status).toBe(200);
  return ((await res.json()) as { events: Array<{ event_type: string; target_type: string; target_id: string; payload: { title?: string } }> }).events;
}

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("node-targeted events follow node read policy", () => {
  const secretTitle = `secret task ${randomUUID()}`;
  let restrictedTask = "";
  let openTask = "";

  beforeAll(async () => {
    ws = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Event targets',$1) RETURNING id", [randomUUID()])).rows[0].id;
    admin = await persistActor(ws, admin);
    viewer = await persistActor(ws, viewer);
    const restricted = await adminOnlySpace(ws, `restricted-${randomUUID()}`, [admin.id]);
    const node = async (title: string) => (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes(workspace_id,source_type,node_type,title,slug,markdown) VALUES($1,'manual','content',$2,$3,'') RETURNING id`,
      [ws, title, randomUUID()])).rows[0].id;
    restrictedTask = await node(secretTitle);
    openTask = await node("open task");
    await putInSpace(restrictedTask, restricted);
    // A legacy row as the scheduler wrote it before the fix, and a new one.
    await db.event(ws, "TASK_OCCURRENCE_MISSED", "task", restrictedTask, { title: secretTitle }, "system", "system-task-scheduler");
    await db.event(ws, "TASK_OCCURRENCE_MISSED", "node", restrictedTask, { title: secretTitle }, "system", "system-task-scheduler");
    await db.event(ws, "TASK_OCCURRENCE_MISSED", "task", openTask, { title: "open task" }, "system", "system-task-scheduler");
    await db.event(ws, "PREVIEW_GENERATED", "workspace", ws, {}, "user", admin.id);
  });
  afterAll(async () => { await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [ws]); });

  it("hides a restricted task's missed-occurrence events from a reader without access", async () => {
    const events = await feed(viewer);
    expect(events.some((e) => e.target_id === restrictedTask)).toBe(false);
    expect(JSON.stringify(events)).not.toContain(secretTitle);
    // Readable targets stay visible.
    expect(events.some((e) => e.target_id === openTask)).toBe(true);
  });

  it("a workspace-level event is the owner's and its author's, not every member's", async () => {
    // services/eventVisibility.ts: settings, members, tokens, previews…
    expect((await feed(viewer)).some((e) => e.event_type === "PREVIEW_GENERATED")).toBe(false);
    expect((await feed(admin)).some((e) => e.event_type === "PREVIEW_GENERATED")).toBe(true);
  });

  it("still shows them to a reader who can see the note", async () => {
    const events = await feed(admin);
    expect(events.filter((e) => e.target_id === restrictedTask).map((e) => e.target_type).sort()).toEqual(["node", "task"]);
  });
});
