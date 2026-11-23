// Review scope by tag: a card is under tag T when it carries T, its note does, or a note above its note does
// (read-time; nothing is written onto cards — block-nodes.md §5). One rule serves the groups route, the queue
// and stats, so a group's counts are the cards its session serves.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import reviewRouter from "../modules/review/routes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /_test\b/.test(DB);

const admin: ActorCtx = { id: "rts-admin", name: "Admin", role: "admin", type: "human" };
let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/review", reviewRouter);

type Group = { id: string | null; title: string; due: number; new: number };

describe.skipIf(!isTestDb)("review scope by tag (DB)", () => {
  let WS = "";
  const stamp = Date.now();
  let tagId = "";
  let courseCard = "", courseFolderCard = "", loneCard = "", tagBlockCard = "";

  const mkNote = async (title: string, parent: string | null = null): Promise<string> =>
    (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id)
       VALUES ($1,'manual','content',$2,$3,'body',$4) RETURNING id`,
      [WS, title, `rts-${stamp}-${title}`, parent])).rows[0]!.id;
  const makeCard = (noteId: string) => seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1,'review',$2) ON CONFLICT DO NOTHING`, [WS, noteId]);
  const get = async <T,>(path: string): Promise<T> => (await (await app.request(path)).json()) as T;
  const tagGroups = async () => (await get<{ groups: Group[] }>("/api/review/groups?by=tag")).groups;

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    await setModulesOn(WS, null);
    Object.assign(admin, await persistActor(WS, admin));
    currentActor = admin;
    tagId = (await seedClassTag(WS, { name: `試用課程-${stamp}` })).tagId;

    // A tagged lecture holding a card note; a card note two levels below it; an untagged tree with a card.
    const lecture = await mkNote("lecture");
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2)`, [lecture, tagId]);
    courseCard = await mkNote("course-card", lecture);
    const section = await mkNote("section", lecture);
    courseFolderCard = await mkNote("deep-card", section);
    loneCard = await mkNote("lone-card", await mkNote("plain-folder"));
    for (const id of [courseCard, courseFolderCard, loneCard]) await makeCard(id);
    // A paragraph card whose own paragraph carries the tag, in an untagged note.
    const plain = await mkNote("plain-note");
    const block = (await seedQ<{ id: string }>(
      `INSERT INTO block_nodes (workspace_id, note_id, block_ref, anchor_id, kind, label) VALUES ($1,$2,'b1','b1','listItem','para') RETURNING id`, [WS, plain])).rows[0]!.id;
    await seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_block_id) VALUES ($1,'review',$2)`, [WS, block]);
    await seedQ(`INSERT INTO block_node_tags (workspace_id, block_node_id, tag_id) VALUES ($1,$2,$3)`, [WS, block, tagId]);
    tagBlockCard = block;
  });

  it("a card under a tagged note, at any depth, or tagged itself, is in that tag's scope; an untagged tree's card is not", async () => {
    const queue = await get<{ cards: Array<{ node_id: string; block: { id: string } | null }>; total: number }>(`/api/review/queue?tag_id=${tagId}`);
    const ids = queue.cards.map((card) => card.block?.id ?? card.node_id);
    expect(ids.sort()).toEqual([courseCard, courseFolderCard, tagBlockCard].sort());
    expect(new Set(ids).size).toBe(ids.length); // never counted twice
    expect(queue.total).toBe(3);
  });

  it("the picker counts equal what the queue serves, and the untagged scope holds only the untagged card", async () => {
    const groups = await tagGroups();
    const row = groups.find((group) => group.id === tagId)!;
    expect(row).toMatchObject({ due: 0, new: 3 });
    expect((await get<{ total: number }>(`/api/review/queue?tag_id=${tagId}`)).total).toBe(row.due + row.new);
    const none = groups.find((group) => group.id === null)!;
    const untagged = await get<{ cards: Array<{ node_id: string }> }>("/api/review/queue?untagged=true");
    expect(untagged.cards.map((card) => card.node_id)).toContain(loneCard);
    expect(untagged.cards.map((card) => card.node_id)).not.toContain(courseCard);
    expect(untagged.cards.map((card) => card.node_id)).not.toContain(courseFolderCard);
    expect(none.due + none.new).toBe((await get<{ total: number }>("/api/review/queue?untagged=true")).total);
    expect((await get<{ new: number }>(`/api/review/stats?tag_id=${tagId}`)).new).toBe(3);
    // 複習狀況 follows the scope too: the untagged scope counts only its card, all cards count every one.
    expect((await get<{ new_available: number }>("/api/review/status?untagged=true")).new_available).toBe(none.due + none.new);
    expect((await get<{ new_available: number }>(`/api/review/status?tag_id=${tagId}`)).new_available).toBe(3);
    expect((await get<{ new_available: number }>("/api/review/status")).new_available).toBeGreaterThanOrEqual(4);
  });
});
