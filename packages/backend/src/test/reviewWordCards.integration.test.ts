// A paragraph with the review word (`{review}`) is a card through its own reference, and the reference follows the word
// (docs/architecture/proposals/function-refs-b3-2026-11-12.md): taking the word out ends the card but keeps every person's schedule,
// putting it back resumes the same schedule. A paragraph gone from the text keeps its reference; a card made another way (migration
// 195 from a tag) is not tied to the word.
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const context = vi.hoisted(() => ({ workspaceId: "" }));
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => context.workspaceId }));
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import reviewRouter from "../modules/review/routes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";

registerShippedModules();
let actor: ActorCtx = { id: "review-word-admin", name: "Admin", role: "admin", type: "human" };
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/nodes", nodesRouter);
app.route("/api/review", reviewRouter);
const send = (url: string, method: string, body?: unknown) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
type QueueCard = { block: { id: string; ref: string } | null; title: string };
const queueBlocks = async (): Promise<string[]> => ((await (await send("/api/review/queue?now=2026-11-13T02:00:00.000Z", "GET")).json()) as { cards: QueueCard[] }).cards
  .flatMap((card) => (card.block ? [card.title] : []));
const reviewRefs = async (noteId: string) => (await q<{ label: string; via: string | null }>(
  `SELECT b.label, r.config->>'via' AS via FROM function_refs r JOIN block_nodes b ON b.id = r.holder_block_id
    WHERE b.note_id = $1 AND r.function_id = 'review' ORDER BY b.label`, [noteId])).rows;
const scheduleRows = async (noteId: string) => (await q<{ label: string; state: string }>(
  `SELECT b.label, s.state FROM review_states s JOIN block_nodes b ON b.id = s.block_id WHERE b.note_id = $1 ORDER BY b.label`, [noteId])).rows;

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("the review word makes a paragraph a card, and its reference follows the word", () => {
  beforeAll(async () => {
    context.workspaceId = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Review word',$1) RETURNING id", [randomUUID()])).rows[0]!.id;
    actor = await persistActor(context.workspaceId, actor);
  });

  const makeNote = async (markdown: string) => {
    const res = await send("/nodes", "POST", { title: `Words ${randomUUID().slice(0, 6)}`, markdown });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const save = async (noteId: string, markdown: string) => expect((await send(`/nodes/${noteId}`, "PATCH", { markdown })).status).toBe(200);
  const gradeOne = async (noteId: string, label: string) => {
    const blockId = (await q<{ id: string }>("SELECT id::text FROM block_nodes WHERE note_id = $1 AND label = $2", [noteId, label])).rows[0]!.id;
    expect((await send(`/api/review/blocks/${blockId}/grade`, "POST", { rating: 3, now: "2026-11-13T02:00:00.000Z" })).status).toBe(200);
  };

  it("adding the word makes the paragraph a card; taking it out ends the card but keeps the schedule; putting it back resumes it", async () => {
    const noteId = await makeNote("背景\n\n二分搜尋的複雜度 {review}\n\n其他\n");
    expect(await reviewRefs(noteId)).toEqual([{ label: "二分搜尋的複雜度", via: "word" }]);
    expect(await queueBlocks()).toContain("二分搜尋的複雜度");
    await gradeOne(noteId, "二分搜尋的複雜度");
    const schedule = await scheduleRows(noteId);
    expect(schedule).toHaveLength(1);

    // The word is taken out: no longer a card, and nothing of anyone's schedule changed.
    await save(noteId, "背景\n\n二分搜尋的複雜度\n\n其他\n");
    expect(await reviewRefs(noteId)).toEqual([]);
    expect(await queueBlocks()).not.toContain("二分搜尋的複雜度");
    expect(await scheduleRows(noteId)).toEqual(schedule);
    // …and it cannot be graded as a card now (its block is hidden, as a paragraph with no mark left).
    const blockId = (await q<{ id: string }>("SELECT id::text FROM block_nodes WHERE note_id = $1 AND label = $2", [noteId, "二分搜尋的複雜度"])).rows[0]!.id;
    expect((await send(`/api/review/blocks/${blockId}/grade`, "POST", { rating: 3 })).status).toBe(404);

    // The word comes back: the same card, the same schedule.
    await save(noteId, "背景\n\n二分搜尋的複雜度 {review}\n\n其他\n");
    expect(await reviewRefs(noteId)).toEqual([{ label: "二分搜尋的複雜度", via: "word" }]);
    expect(await scheduleRows(noteId)).toEqual(schedule);
    expect(await queueBlocks()).not.toContain("二分搜尋的複雜度"); // graded today: not due again today
    const state = JSON.parse(schedule[0]!.state) as { reps: number };
    expect(state.reps).toBe(1);
  });

  it("a paragraph that keeps another tag stays visible but is no longer a card, until the word is back", async () => {
    const noteId = await makeNote("要背的 {review, 考點}\n\n其他\n");
    await gradeOne(noteId, "要背的");
    const schedule = await scheduleRows(noteId);
    const blockId = (await q<{ id: string }>("SELECT id::text FROM block_nodes WHERE note_id = $1 AND label = $2", [noteId, "要背的"])).rows[0]!.id;
    await save(noteId, "要背的 {考點}\n\n其他\n");
    expect(await reviewRefs(noteId)).toEqual([]);
    expect((await send(`/api/review/blocks/${blockId}/grade`, "POST", { rating: 3 })).status).toBe(409); // visible, not a card
    expect(await scheduleRows(noteId)).toEqual(schedule);
    await save(noteId, "要背的 {review, 考點}\n\n其他\n");
    expect(await reviewRefs(noteId)).toEqual([{ label: "要背的", via: "word" }]);
    expect(await scheduleRows(noteId)).toEqual(schedule);
  });

  it("a paragraph gone from the text keeps its reference and schedule (the hidden-paragraph rule)", async () => {
    const noteId = await makeNote("留著 {review}\n\n另一段\n");
    await gradeOne(noteId, "留著");
    const schedule = await scheduleRows(noteId);
    await save(noteId, "另一段\n");
    expect(await reviewRefs(noteId)).toEqual([{ label: "留著", via: "word" }]);
    expect(await scheduleRows(noteId)).toEqual(schedule);
  });

  it("a card made another way (no word behind it, as migration 195 leaves it) is not ended by editing the text", async () => {
    const noteId = await makeNote("舊卡 {考點}\n\n其他\n");
    const blockId = (await q<{ id: string }>("SELECT id::text FROM block_nodes WHERE note_id = $1 AND label = $2", [noteId, "舊卡"])).rows[0]!.id;
    await seedQ("INSERT INTO function_refs(workspace_id,function_id,holder_block_id) VALUES($1,'review',$2)", [context.workspaceId, blockId]);
    await save(noteId, "舊卡 {考點}\n\n其他，改了字\n");
    expect(await reviewRefs(noteId)).toEqual([{ label: "舊卡", via: null }]);
  });
});
