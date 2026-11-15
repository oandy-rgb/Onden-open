// Review cards on block nodes (docs/architecture/block-nodes.md, B3): a
// block node carrying a review tag is a card in the queue, its sides cut
// from the note's text; grading, state and undo are per person in
// review_states (block_id; migration 120, one table since 183). Block rows and their anchors (a card's
// id; the sides are cut at the anchor's place in the text) are written directly,
// so this tests the review service, not the save path.
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const context = vi.hoisted(() => ({ workspaceId: "" }));
vi.mock("../db.js", async original => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => context.workspaceId }));
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import type { ActorCtx } from "../types.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { persistActor } from "./helpers/persistActor.js";
import reviewRouter from "../modules/review/routes.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { deleteWorkspaceActors } from "./helpers/setOwner.js";
import { seedQ } from "./helpers/seedQ.js";
import { parseBlocks } from "@onden/markdown";
import { createHash } from "node:crypto";

registerShippedModules();

const NOW = "2026-10-19T08:00:00.000Z";
let actor: ActorCtx;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/api/review", reviewRouter);
const req = (path: string, method = "GET", body?: unknown) => app.request(path, {
  method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
type QueueCard = { node_id: string; title: string; markdown: string; state: unknown; block: { id: string; ref: string } | null };
const queue = async () => (await (await req(`/api/review/queue?now=${NOW}`)).json() as { cards: QueueCard[] }).cards;

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("review cards on block nodes (B3)", () => {
  let plainTag = "", noteId = "", cardBlock = "", plainBlock = "";
  const block = async (ref: string, tagIds: string[], card = false) => {
    // The block's anchor: where the paragraph is in the saved text (the text itself carries no `^id`).
    const markdown = (await q<{ markdown: string }>("SELECT markdown FROM content_nodes WHERE id=$1", [noteId])).rows[0]!.markdown;
    const span = parseBlocks(markdown).find(b => b.label === (ref === "q1" ? "二分搜尋的時間複雜度？" : "只是分類"))!;
    await seedQ(`INSERT INTO block_anchors(workspace_id,anchor_id,note_id,from_utf16,to_utf16,at_body_hash,quote)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [context.workspaceId, ref, noteId, span.start, span.end, createHash("sha256").update(markdown).digest("hex"), markdown.slice(span.start, span.end)]);
    const id = (await seedQ<{ id: string }>(
      "INSERT INTO block_nodes(workspace_id,note_id,block_ref,anchor_id,kind,label) VALUES($1,$2,$3,$3,'listItem',$3) RETURNING id::text",
      [context.workspaceId, noteId, ref])).rows[0]!.id;
    if (card) await q("INSERT INTO function_refs(workspace_id,function_id,holder_block_id) VALUES($1,'review',$2)", [context.workspaceId, id]);
    for (const t of tagIds) await q("INSERT INTO block_node_tags(block_node_id,tag_id,workspace_id) VALUES($1,$2,$3)", [id, t, context.workspaceId]);
    return id;
  };

  beforeAll(async () => {
    context.workspaceId = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Block review',$1) RETURNING id", [randomUUID()])).rows[0]!.id;
    actor = await persistActor(context.workspaceId, { id: "block-review-admin", name: "Admin", role: "admin", type: "human" });
    await q(`INSERT INTO space_members(space_id,actor_id,permission)
      SELECT id,$2,'edit' FROM spaces WHERE workspace_id=$1 AND is_default ON CONFLICT DO NOTHING`, [context.workspaceId, actor.id]);
    plainTag = (await seedClassTag(context.workspaceId, { name: `考點-${randomUUID().slice(0, 6)}` })).tagId;
    noteId = randomUUID();
    const markdown = "- 二分搜尋的時間複雜度？ {卡}\n  - O(log n)\n- 只是分類 {考點}\n";
    await seedQ(`INSERT INTO content_nodes(id,workspace_id,source_type,node_type,title,slug,markdown)
      VALUES($1::uuid,$2,'manual','content','演算法',$1::text,$3)`, [noteId, context.workspaceId, markdown]);
    cardBlock = await block("q1", [], true);
    plainBlock = await block("p1", [plainTag]);
  });
  afterAll(async () => {
    await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [context.workspaceId]);
    await deleteWorkspaceActors(context.workspaceId);
  });

  it("a block holding its own review reference is a card; its sides come from the note's text", async () => {
    const cards = await queue();
    const card = cards.find(c => c.block?.id === cardBlock);
    expect(card).toMatchObject({ node_id: noteId, title: "二分搜尋的時間複雜度？", markdown: "- O(log n)", state: null, block: { ref: "q1" } });
    // A block with only an ordinary tag is not a card; the note itself isn't either.
    expect(cards.some(c => c.block?.id === plainBlock)).toBe(false);
    expect(cards.some(c => c.block === null && c.node_id === noteId)).toBe(false);
  });

  it("grades, reads and undoes per person in review_states (block_id)", async () => {
    const graded = await req(`/api/review/blocks/${cardBlock}/grade`, "POST", { rating: 3, now: NOW });
    expect(graded.status).toBe(200);
    expect(await graded.json()).toMatchObject({ node_id: noteId, block_id: cardBlock, rating: 3 });
    const state = await (await req(`/api/review/blocks/${cardBlock}/state`)).json() as { state: { reps: number } | null };
    expect(state.state?.reps).toBe(1);
    // The note's own review row is untouched.
    expect((await q("SELECT 1 FROM review_states WHERE node_id=$1", [noteId])).rows).toHaveLength(0);
    expect((await req(`/api/review/blocks/${cardBlock}/undo-grade`, "POST")).status).toBe(200);
    expect((await (await req(`/api/review/blocks/${cardBlock}/state`)).json() as { state: unknown }).state).toBeNull();
  });

  it("a block without a review tag is refused (409); a hidden one is not a card (404)", async () => {
    expect((await req(`/api/review/blocks/${plainBlock}/grade`, "POST", { rating: 3, now: NOW })).status).toBe(409);
    await seedQ("UPDATE block_nodes SET hidden_at=now() WHERE id=$1", [cardBlock]);
    try {
      expect((await queue()).some(c => c.block?.id === cardBlock)).toBe(false);
      expect((await req(`/api/review/blocks/${cardBlock}/grade`, "POST", { rating: 3, now: NOW })).status).toBe(404);
    } finally {
      await seedQ("UPDATE block_nodes SET hidden_at=NULL WHERE id=$1", [cardBlock]);
    }
  });
});
