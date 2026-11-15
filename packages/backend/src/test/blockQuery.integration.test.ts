// Block nodes in queries (docs/architecture/block-nodes.md §5, §9): a tag query and a tag's page list the block nodes
// carrying the tag in their own `{…}`. None takes a tag from the block above it or from its note (owner 2026-11-09:
// a note takes none from its parent either). The rows are written directly, so this tests the SQL, not the parser.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import queryRouter from "../routes/query.js";
import { tagBlocks } from "../services/blockNodes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";

// 課程 is on the note; 複習 is a module tag and 閃卡 extends it, so a query for 複習 also lists 閃卡's block (as for
// notes: tagHierarchy.memberTagIds). ^mid has no tag of its own, and ^s1 → ^a1 → ^mid → ^a2 is one nesting.
const TAGS: Record<string, { module?: boolean; extends?: string }> = { 課程: {}, 考點: {}, 易錯: {}, 複習: { module: true }, 閃卡: { extends: "複習" } };
const NOTE_TAGS = ["課程"];
const BLOCKS: Array<{ ref: string; parent: string | null; tags: string[] }> = [
  { ref: "s1", parent: null, tags: ["考點", "複習"] },
  { ref: "a1", parent: "s1", tags: ["閃卡"] },
  { ref: "mid", parent: "a1", tags: [] },
  { ref: "a2", parent: "mid", tags: ["易錯"] },
  { ref: "p1", parent: null, tags: ["易錯", "課程"] },
];
/** Each query's blocks: those tagged themselves, never one under a tagged block or in a tagged note. */
const QUERIES: Array<{ tags: string[]; blocks: string[] }> = [
  { tags: ["課程"], blocks: ["p1"] },
  { tags: ["考點"], blocks: ["s1"] },
  { tags: ["易錯"], blocks: ["a2", "p1"] },
  { tags: ["複習"], blocks: ["s1", "a1"] },
  { tags: ["閃卡"], blocks: ["a1"] },
  { tags: ["考點", "易錯"], blocks: ["s1", "a2", "p1"] },
];

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);
let workspaceId = "";
let actor: ActorCtx = { id: "bq-owner", name: "Owner", role: "admin", type: "human" };
let outsider: ActorCtx = { id: "bq-outsider", name: "Outsider", role: "editor", type: "human" };
let current: ActorCtx = actor;
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", current); await next(); });
app.route("/query", queryRouter);
const query = async (body: unknown) => {
  const res = await app.request("/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  const page = (await res.json()) as { rows: Array<{ id: string; block?: { id: string; ref: string; label: string } }>; total: number; next: number | null };
  // One list: a block's row carries its note's id and the block.
  return { ...page, notes: page.rows.filter((r) => !r.block), blocks: page.rows.flatMap((r) => (r.block ? [{ ...r.block, note_id: r.id }] : [])) };
};

describe.skipIf(!isTestDb)("block nodes in tag queries follow the shared rule (DB)", () => {
  const tagId = new Map<string, string>();
  const blockId = new Map<string, string>();
  let noteId = "";

  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Block query',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    outsider = await persistActor(workspaceId, outsider);
    actor = await persistActor(workspaceId, actor); // the last human admin persisted is the owner
    current = actor;
    for (const [name, spec] of Object.entries(TAGS)) {
      const id = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, tag_schema)
         VALUES ($1,'manual','class_tag',$2,$3,'',$4) RETURNING id::text`,
        [workspaceId, name, `t-${randomUUID().slice(0, 8)}`,
          spec.module ? JSON.stringify({ module: "review" })
            : spec.extends ? JSON.stringify({ extends: [tagId.get(spec.extends)] }) : null],
      )).rows[0]!.id;
      tagId.set(name, id);
    }
    const privateSpace = await makeSpace(workspaceId, `own-${randomUUID()}`, [{ id: actor.id, role: "manager" }], { publish: false, external_ai: false, backup: true });
    noteId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1,'manual','content','Algorithms',$2,'') RETURNING id::text`,
      [workspaceId, `alg-${randomUUID().slice(0, 8)}`])).rows[0]!.id;
    await putInSpace(noteId, privateSpace);
    for (const t of NOTE_TAGS) await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [noteId, tagId.get(t)]);
    for (const b of BLOCKS) {
      const id = (await seedQ<{ id: string }>(
        `INSERT INTO block_nodes (workspace_id, note_id, block_ref, parent_block_id, kind, label) VALUES ($1,$2,$3,$4,'paragraph',$3) RETURNING id::text`,
        [workspaceId, noteId, b.ref, b.parent ? blockId.get(b.parent) : null])).rows[0]!.id;
      blockId.set(b.ref, id);
      for (const t of b.tags) await q(`INSERT INTO block_node_tags (block_node_id, tag_id, workspace_id) VALUES ($1,$2,$3)`, [id, tagId.get(t), workspaceId]);
    }
  });

  it.each(QUERIES)("query tags $tags lists the blocks tagged themselves", async ({ tags, blocks }) => {
    const res = await query({ tags });
    expect(res.blocks.map((b) => b.ref).sort()).toEqual([...blocks].sort());
    expect(res.blocks.every((b) => b.note_id === noteId)).toBe(true);
    // A page open from before 2026-11-09 still asks for inherited blocks: the answer is the same.
    expect((await query({ tags, include_blocks: true })).rows).toEqual(res.rows);
  });

  it("notes still match by their own tags only", async () => {
    expect((await query({ tags: ["課程"] })).notes.map((r) => r.id)).toEqual([noteId]);
    expect((await query({ tags: ["易錯"] })).notes).toEqual([]);
  });

  it("a reader who can't read the note sees none of its blocks", async () => {
    current = outsider;
    try {
      expect((await query({ tags: ["易錯"] })).rows).toEqual([]);
    } finally { current = actor; }
  });

  it("blocks page and count with the notes, each right after its note; `where` lists notes only", async () => {
    const all = await query({ tags: ["課程"] });
    expect(all.total).toBe(all.rows.length);
    expect(all.rows[0]).toEqual(expect.objectContaining({ id: noteId }));
    expect(all.rows[0]!.block).toBeUndefined();
    expect(all.blocks.length).toBeGreaterThan(0);
    // One row a page walks the same list, and `next` stops after the last.
    const walked: typeof all.rows = [];
    for (let offset: number | null = 0; offset !== null;) {
      const page = await query({ tags: ["課程"], limit: 1, offset });
      expect(page.total).toBe(all.total);
      walked.push(...page.rows);
      offset = page.next;
    }
    expect(walked).toEqual(all.rows);
    expect((await query({ tags: ["課程"], where: { status: "x" } })).rows).toEqual([]);
  });

  it("a tag's page lists the blocks carrying it themselves, the reader's only, a page at a time", async () => {
    for (const { tags, blocks } of QUERIES.filter((x) => x.tags.length === 1)) {
      const listed = await tagBlocks(actor, workspaceId, tagId.get(tags[0]!)!, { limit: 200, offset: 0 });
      expect(listed.rows.map((r) => r.label).sort(), tags.join()).toEqual([...blocks].sort());
      expect(listed.total).toBe(blocks.length);
      expect(listed.rows.every((r) => r.note_id === noteId && r.note_title === "Algorithms")).toBe(true);
    }
    const all = await tagBlocks(actor, workspaceId, tagId.get("易錯")!, { limit: 200, offset: 0 });
    const first = await tagBlocks(actor, workspaceId, tagId.get("易錯")!, { limit: 1, offset: 0 });
    expect(first.rows).toEqual(all.rows.slice(0, 1));
    expect(first.next).toBe(all.rows.length > 1 ? 1 : null);
    expect((await tagBlocks(outsider, workspaceId, tagId.get("易錯")!, { limit: 200, offset: 0 })).rows).toEqual([]);
  });
});
