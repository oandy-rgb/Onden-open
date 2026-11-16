// The context of a review card shows its neighbours' FRONTS only (packages/markdown blockCard.ts blockNeighbours), so
// reviewing one card never reads the next card's answer. The cards here are two-line paragraphs: the first line asks,
// the rest answers.
// Block rows and anchors are written directly, like blockReview.integration.test.ts: this tests the review service.
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { randomUUID, createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const context = vi.hoisted(() => ({ workspaceId: "" }));
vi.mock("../db.js", async original => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => context.workspaceId }));
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import reviewRouter from "../modules/review/routes.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { deleteWorkspaceActors } from "./helpers/setOwner.js";
import { seedQ } from "./helpers/seedQ.js";
import { parseBlocks } from "@onden/markdown";

registerShippedModules();

const NOW = "2026-10-19T08:00:00.000Z";
let actor: ActorCtx;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/api/review", reviewRouter);
type QueueCard = { title: string; markdown: string; block: { ref: string } | null; context: { before: string | null; after: string | null } };
const queue = async () => (await (await app.request(`/api/review/queue?now=${NOW}`)).json() as { cards: QueueCard[] }).cards;

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("review card neighbours", () => {
  beforeAll(async () => {
    context.workspaceId = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Card neighbours',$1) RETURNING id", [randomUUID()])).rows[0]!.id;
    actor = await persistActor(context.workspaceId, { id: "neighbours-admin", name: "Admin", role: "admin", type: "human" });
    await q(`INSERT INTO space_members(space_id,actor_id,permission)
      SELECT id,$2,'edit' FROM spaces WHERE workspace_id=$1 AND is_default ON CONFLICT DO NOTHING`, [context.workspaceId, actor.id]);
    const noteId = randomUUID();
    const markdown = [
      "`if` 匹配哪條？\n長度相同，取先寫的 {卡}", "`ifx` 匹配哪條？\n`{ID}`，最長匹配 {卡}", "`x` 呢？\n也是 `{ID}` {卡}",
    ].join("\n\n") + "\n";
    await seedQ(`INSERT INTO content_nodes(id,workspace_id,source_type,node_type,title,slug,markdown)
      VALUES($1::uuid,$2,'manual','content','Lex教學',$1::text,$3)`, [noteId, context.workspaceId, markdown]);
    const blocks = parseBlocks(markdown);
    for (const [i, b] of blocks.entries()) {
      const ref = `c${i}`;
      await seedQ(`INSERT INTO block_anchors(workspace_id,anchor_id,note_id,from_utf16,to_utf16,at_body_hash,quote)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [context.workspaceId, ref, noteId, b.start, b.end, createHash("sha256").update(markdown).digest("hex"), markdown.slice(b.start, b.end)]);
      const id = (await seedQ<{ id: string }>(
        "INSERT INTO block_nodes(workspace_id,note_id,block_ref,anchor_id,kind,label) VALUES($1,$2,$3,$3,'paragraph',$3) RETURNING id::text",
        [context.workspaceId, noteId, ref])).rows[0]!.id;
      await q("INSERT INTO function_refs(workspace_id,function_id,holder_block_id) VALUES($1,'review',$2)", [context.workspaceId, id]);
    }
  });
  afterAll(async () => {
    await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [context.workspaceId]);
    await deleteWorkspaceActors(context.workspaceId);
  });

  it("each card has its front and its back", async () => {
    const cards = (await queue()).filter(c => c.block);
    expect(cards.map(c => [c.title, c.markdown])).toEqual([
      ["`if` 匹配哪條？", "長度相同，取先寫的"],
      ["`ifx` 匹配哪條？", "`{ID}`，最長匹配"],
      ["`x` 呢？", "也是 `{ID}`"],
    ]);
  });

  it("the neighbours are fronts only: no answer of another card in the context", async () => {
    const cards = (await queue()).filter(c => c.block);
    expect(cards[0]!.context).toMatchObject({ before: null, after: "ifx 匹配哪條？" });
    expect(cards[1]!.context).toMatchObject({ before: "if 匹配哪條？", after: "x 呢？" });
    expect(cards[2]!.context).toMatchObject({ before: "ifx 匹配哪條？", after: null });
    for (const c of cards) expect(JSON.stringify(c.context)).not.toMatch(/取先寫|最長匹配|也是/);
  });
});
