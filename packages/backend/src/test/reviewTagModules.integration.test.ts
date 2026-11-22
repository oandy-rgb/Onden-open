import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const context = vi.hoisted(() => ({ workspaceId: "" }));
vi.mock("../db.js", async original => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => context.workspaceId }));
import { pool, q, withTransaction } from "../db.js";
import { apiOnError } from "../httpError.js";
import type { ActorCtx } from "../types.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { persistActor } from "./helpers/persistActor.js";
import reviewRouter from "../modules/review/routes.js";
import { reviewQueueTool } from "../modules/review/reviewQueueTool.js";
import { schedule } from "../modules/review/fsrs.js";
import tagsRouter from "../routes/tags.js";
import nodesRouter from "../routes/nodes.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { deleteWorkspaceActors } from "./helpers/setOwner.js";
import { waitForEventLockWaiter } from "./helpers/eventLockWait.js";
import { needsSecondConnection } from "./helpers/pgliteSkips.js";
import { seedQ } from "./helpers/seedQ.js";

registerShippedModules();

const NOW = "2026-09-29T08:00:00.000Z";
let actor: ActorCtx;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/api/review", reviewRouter).route("/api/tags", tagsRouter).route("/api/nodes", nodesRouter);
const req = (path: string, method = "GET", body?: unknown) => app.request(path, {
  method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
// A real client names the reps it was showing (`seen_reps`, ReviewPanel); without it the card must be due and not put off.
const grade = (id: string, seenReps?: number) => req(`/api/review/${id}/grade`, "POST", { rating: 3, now: NOW, ...(seenReps === undefined ? {} : { seen_reps: seenReps }) });
const queue = async (tagId?: string) => (await req(`/api/review/queue?now=${NOW}${tagId ? `&tag_id=${tagId}` : ""}`)).json() as Promise<{ cards: { node_id: string; state: unknown }[] }>;
const stats = async (tagId?: string) => (await req(`/api/review/stats?now=${NOW}${tagId ? `&tag_id=${tagId}` : ""}`)).json() as Promise<{ new_available: number }>;

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("review cards are the notes' own references (a tag makes none)", () => {
  let admin: ActorCtx, nodeId: string;
  // The workspace's review module tag: where the daily limits are read from. It makes no card.
  const settingsTag = async (behaviour: Record<string, unknown> = {}) => {
    const { tagId } = await seedClassTag(context.workspaceId, { name: randomUUID(), behaviour });
    await seedQ(`UPDATE content_nodes SET tag_schema = tag_schema || '{"module":"review"}'::jsonb WHERE id = $1`, [tagId]);
    return tagId;
  };
  // The person's one daily cap (actor_prefs "reviewsPerDay"); null removes it.
  const setCap = async (limit: number | null) => {
    if (limit === null) await seedQ("DELETE FROM actor_prefs WHERE actor_id=$1 AND key='reviewsPerDay'", [admin.id]);
    else await seedQ(`INSERT INTO actor_prefs(actor_id,key,value) VALUES($1,'reviewsPerDay',$2::jsonb) ON CONFLICT(actor_id,key) DO UPDATE SET value=EXCLUDED.value`, [admin.id, JSON.stringify(limit)]);
  };
  const plainTag = async (behaviour: Record<string, unknown> = {}) => (await seedClassTag(context.workspaceId, { name: randomUUID(), behaviour })).tagId;
  // The notes live in the default space; leaving it is how a reader loses them.
  const leaveDefaultSpace = (run: (sql: string, params: unknown[]) => Promise<unknown>) => run(
    "DELETE FROM space_members WHERE actor_id=$2 AND space_id=(SELECT id FROM spaces WHERE workspace_id=$1 AND is_default)",
    [context.workspaceId, admin.id]);
  const note = async ({ card = true, tags = [], type = "content" }: { card?: boolean; tags?: string[]; type?: string } = {}) => {
    const id = randomUUID();
    await seedQ(`INSERT INTO content_nodes(id,workspace_id,source_type,node_type,title,slug)
      VALUES($1::uuid,$2,'manual',$3,'Module card',$1::text)`, [id, context.workspaceId, type]);
    for (const tag of tags) await seedQ("INSERT INTO node_tags(node_id,tag_id) VALUES($1,$2)", [id, tag]);
    if (card) await seedQ("INSERT INTO function_refs(workspace_id,function_id,holder_node_id) VALUES($1,'review',$2)", [context.workspaceId, id]);
    return id;
  };
  beforeAll(async () => {
    context.workspaceId = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Review modules',$1) RETURNING id", [randomUUID()])).rows[0].id;
    admin = await persistActor(context.workspaceId, { id: "review-admin", name: "Review admin", role: "admin", type: "human" });
  });
  beforeEach(async () => {
    await q(`INSERT INTO space_members(space_id,actor_id,permission)
      SELECT id,$2,'edit' FROM spaces WHERE workspace_id=$1 AND is_default ON CONFLICT DO NOTHING`, [context.workspaceId, admin.id]);
    actor = admin;
    nodeId = await note();
  });
  afterAll(async () => {
    await setCap(null);
    await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [context.workspaceId]);
    await deleteWorkspaceActors(context.workspaceId);
  });

  it("a card keeps its place in the queue, the agent queue and grading when its tags are renamed or removed", async () => {
    const tag = await plainTag();
    await seedQ("INSERT INTO node_tags(node_id,tag_id) VALUES($1,$2)", [nodeId, tag]);
    expect((await req(`/api/tags/${tag}`, "PATCH", { name: `Course-${randomUUID()}` })).status).toBe(200);
    expect((await req(`/api/nodes/${nodeId}/tags/${tag}`, "DELETE")).status).toBe(200);
    expect((await queue()).cards.map(card => card.node_id)).toContain(nodeId);
    const tool = await reviewQueueTool.handler({ due_only: false }, { actor, workspaceId: context.workspaceId });
    expect(tool.cards.map(card => card.node_id)).toContain(nodeId);
    expect((await grade(nodeId)).status).toBe(200);
  });

  it("a tag, its name or its old switch never makes a card", async () => {
    const legacy = await plainTag({ modules: { review: { enabled: true } }, review: { new_per_day: 10 } });
    await req(`/api/tags/${legacy}`, "PATCH", { name: "review" });
    const plainId = await note({ card: false, tags: [legacy] });
    expect((await queue()).cards.map(card => card.node_id)).not.toContain(plainId);
    expect((await grade(plainId)).status).toBe(409);
    expect((await req(`/api/tags/${legacy}/modules`, "PATCH", { review: true })).status).toBeGreaterThanOrEqual(400); // review is no tag function
  });

  it("stopping a card keeps every schedule, and making it a card again resumes it", async () => {
    expect((await grade(nodeId)).status).toBe(200);
    const original = (await q("SELECT state FROM review_states WHERE node_id=$1", [nodeId])).rows[0].state;
    expect((await req(`/api/review/cards/${nodeId}`, "DELETE")).status).toBe(200);
    expect((await grade(nodeId)).status).toBe(409);
    expect((await q("SELECT state FROM review_states WHERE node_id=$1", [nodeId])).rows[0].state).toBe(original);
    expect((await req(`/api/review/cards/${nodeId}`, "PUT")).status).toBe(200);
    expect((await q("SELECT state FROM review_states WHERE node_id=$1", [nodeId])).rows[0].state).toBe(original);
    const cards = await reviewQueueTool.handler({ due_only: false }, { actor, workspaceId: context.workspaceId });
    expect(cards.cards.find(card => card.node_id === nodeId)?.reps).toBe(1);
  });

  it("making a card is recorded as an event on the note, and History can undo it", async () => {
    const id = await note({ card: false });
    expect(((await (await req(`/api/review/cards/${id}`, "PUT")).json()) as { changed: boolean }).changed).toBe(true);
    expect(((await (await req(`/api/review/cards/${id}`, "PUT")).json()) as { changed: boolean }).changed).toBe(false);
    const event = (await q<{ id: string; event_type: string }>("SELECT id::text, event_type FROM domain_events WHERE target_id=$1 AND event_type LIKE 'FUNCTION_REF_%'", [id])).rows;
    expect(event.map(e => e.event_type)).toEqual(["FUNCTION_REF_ADDED"]);
    const { restoreEvent } = await import("../services/eventRestore/restore.js");
    const undone = await restoreEvent(event[0]!.id, { actor, workspaceId: context.workspaceId });
    expect("code" in undone ? undone : null).toBeNull();
    expect((await (await req(`/api/review/cards/${id}`)).json()) as { card: boolean }).toEqual({ node_id: id, card: false });
  });

  it("the person's daily cap applies to every card, whatever tag scope is asked for (a tag is only a filter)", async () => {
    const tag = await plainTag();
    await seedQ("INSERT INTO node_tags(node_id,tag_id) VALUES($1,$2)", [nodeId, tag]);
    await setCap(0);
    expect((await queue(tag)).cards.some(card => card.node_id === nodeId)).toBe(false);
    expect((await queue()).cards.some(card => card.node_id === nodeId)).toBe(false);
    expect((await stats(tag)).new_available).toBe(0);
    await setCap(null);
    expect((await queue(tag)).cards.some(card => card.node_id === nodeId)).toBe(true);
  });

  it("History refuses an undo that no longer fits, in words about the note, not a tag", async () => {
    const id = await note({ card: false });
    await req(`/api/review/cards/${id}`, "PUT");
    await req(`/api/review/cards/${id}`, "DELETE");
    const events = (await q<{ id: string; event_type: string }>("SELECT id::text, event_type FROM domain_events WHERE target_id=$1 AND event_type LIKE 'FUNCTION_REF_%' ORDER BY domain_events.id", [id])).rows;
    expect(events.map(e => e.event_type)).toEqual(["FUNCTION_REF_ADDED", "FUNCTION_REF_REMOVED"]);
    const { restoreEvent } = await import("../services/eventRestore/restore.js");
    // Undoing the first (made a card) when the note is no longer one: nothing to take away.
    const first = await restoreEvent(events[0]!.id, { actor, workspaceId: context.workspaceId });
    expect(first).toMatchObject({ code: "already_in_state", detail: "this note is no longer a review card" });
    // Make it a card again, then undo the removal: it already is one.
    await req(`/api/review/cards/${id}`, "PUT");
    const second = await restoreEvent(events[1]!.id, { actor, workspaceId: context.workspaceId });
    expect(second).toMatchObject({ code: "already_in_state", detail: "this note is a review card again" });
  });

  it("a tag scope picks the cards of notes carrying the tag or a tag under it", async () => {
    const parent = await plainTag();
    const child = await plainTag();
    await seedQ("UPDATE content_nodes SET parent_id=$2 WHERE id=$1", [child, parent]);
    const inParent = await note({ tags: [parent] });
    const inChild = await note({ tags: [child] });
    const other = await note();
    const ids = (await queue(parent)).cards.map(card => card.node_id);
    expect(ids).toEqual(expect.arrayContaining([inParent, inChild]));
    expect(ids).not.toContain(other);
    expect((await queue(child)).cards.map(card => card.node_id)).not.toContain(inParent);
  });

  it("the agent's reviewQueue returns the same cards, in the same order, as the HTTP queue", async () => {
    // One place a day (the person's cap): of two fresh cards only the first may be studied.
    await setCap(1);
    await seedQ("DELETE FROM function_refs WHERE workspace_id=$1 AND function_id='review'", [context.workspaceId]);
    const first = await note();
    const second = await note();
    const http = await (await req("/api/review/queue")).json() as { cards: { node_id: string }[]; total: number };
    const tool = await reviewQueueTool.handler({}, { actor, workspaceId: context.workspaceId });
    expect(tool.cards.map(card => card.node_id)).toEqual(http.cards.map(card => card.node_id));
    expect(tool.total).toBe(http.total);
    expect(tool.cards.map(card => card.node_id)).toContain(first);
    expect(tool.cards.map(card => card.node_id)).not.toContain(second);
    const one = await reviewQueueTool.handler({ limit: 1 }, { actor, workspaceId: context.workspaceId });
    expect(one.cards.map(card => card.node_id)).toEqual(http.cards.slice(0, 1).map(card => card.node_id));
    expect(one.total).toBe(http.total);
    await setCap(null);
  });

  it("the agent's reviewQueue answers inside a session's chain (a transaction), where a snapshot cannot start", async () => {
    // A tool called by an AI session runs in the session's transaction; on 2026-11-15 the tool failed there with
    // "read snapshot must start outside an existing transaction", so an AI asked for review cards got an error.
    await seedQ("DELETE FROM function_refs WHERE workspace_id=$1 AND function_id='review'", [context.workspaceId]);
    const card = await note();
    const ctx = { actor, workspaceId: context.workspaceId };
    const outside = await reviewQueueTool.handler({}, ctx);
    expect(await withTransaction(() => reviewQueueTool.handler({}, ctx))).toEqual(outside);
    const whole = await withTransaction(() => reviewQueueTool.handler({ due_only: false }, ctx));
    expect(whole.cards.map(c => c.node_id)).toContain(card);
  });

  it("one fresh card takes one place from the daily cap, and repeated grading does not release or double it", async () => {
    await setCap(2);
    await seedQ("DELETE FROM function_refs WHERE workspace_id=$1 AND function_id='review'", [context.workspaceId]);
    const graded = await note();
    await note();
    await note();
    expect((await queue()).cards).toHaveLength(2);
    expect((await grade(graded, 0)).status).toBe(200);
    expect((await grade(graded, 1)).status).toBe(200);
    // Graded twice, counted once: one place of the two is left for the two other new cards.
    expect((await queue()).cards.filter(card => card.state === null)).toHaveLength(1);
    expect(await stats()).toMatchObject({ new_available: 1 });
    await setCap(null);
  });

  it("card reads obey current space membership", async () => {
    await leaveDefaultSpace(q);
    expect((await queue()).cards).toEqual([]);
    expect((await grade(nodeId)).status).toBe(404);
  });

  it("grade rejects tag nodes even when they hold a review reference", async () => {
    const id = await note({ type: "class_tag" });
    expect((await queue()).cards.some(card => card.node_id === id)).toBe(false);
    expect((await grade(id)).status).toBe(409);
  });

  it.skipIf(needsSecondConnection).each(["remove", "scope"] as const)("rechecks %s after waiting for the event transaction", async change => {
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`event-append:${context.workspaceId}`]);
    const pending = grade(nodeId);
    try {
      await waitForEventLockWaiter(blocker, context.workspaceId);
      if (change === "remove") await blocker.query("DELETE FROM function_refs WHERE holder_node_id=$1 AND function_id='review'", [nodeId]);
      else await leaveDefaultSpace((sql, params) => blocker.query(sql, params));
      await blocker.query("COMMIT");
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    expect((await pending).status).toBe(change === "scope" ? 404 : 409);
    expect((await q("SELECT key FROM node_attributes WHERE node_id=$1", [nodeId])).rows).toEqual([]);
    expect((await q("SELECT id FROM domain_events WHERE target_id=$1", [nodeId])).rows).toEqual([]);
  });
});
