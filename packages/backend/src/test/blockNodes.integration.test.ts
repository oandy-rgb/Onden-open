// Block nodes follow the note's text on every save (B1b,
// docs/architecture/block-nodes.md):
//   * a save gives a `{tags}` block an anchor (its identity; the text stays as
//     written, no `^id`), and its row, parent and own tags (found
//     case-insensitively, or created);
//   * a text-only edit keeps every block node as it is;
//   * a save that carries no ids at all (an editor, an import) still finds its rows;
//   * `{…}` removed: hidden with its data, back as the same row;
//   * undoing the edit undoes the block nodes;
//   * bootstrap and sync ship them with their note; import keeps text as is.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import syncRouter from "../routes/sync.js";
import bootstrapRouter from "../routes/bootstrap.js";
import { duplicateNote } from "../services/noteDuplicate.js";
import { restoreEvent } from "../services/eventRestore/restore.js";
import { createNote } from "../services/noteCreate.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);
let workspaceId = "";
let actor: ActorCtx = { id: "blocks-admin", name: "Blocks", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/nodes", nodesRouter);
app.route("/sync", syncRouter);
app.route("/bootstrap", bootstrapRouter);
registerShippedModules();
const send = (url: string, method: string, body: unknown = {}) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

type Block = { block_ref: string; parent_ref: string | null; kind: string; label: string; tags: string[]; hidden: boolean };
const blocksOf = async (noteId: string): Promise<Block[]> => (await q<Block>(
  `SELECT b.block_ref, p.block_ref AS parent_ref, b.kind, b.label, b.hidden_at IS NOT NULL AS hidden,
          coalesce(array_agg(t.title ORDER BY t.title) FILTER (WHERE t.title IS NOT NULL), '{}') AS tags
     FROM block_nodes b
     LEFT JOIN block_nodes p ON p.id = b.parent_block_id
     LEFT JOIN block_node_tags bt ON bt.block_node_id = b.id
     LEFT JOIN content_nodes t ON t.id = bt.tag_id
    WHERE b.note_id = $1 GROUP BY b.id, p.block_ref ORDER BY b.created_at, b.block_ref`, [noteId])).rows;
const bodyOf = async (id: string) => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;
/** The ref (anchor id) the server gave the block with this label. */
const refOf = async (noteId: string, label: string) => (await q<{ block_ref: string }>(
  `SELECT block_ref FROM block_nodes WHERE note_id = $1 AND label = $2`, [noteId, label])).rows[0]!.block_ref;
const blockEvents = async (noteId: string) => (await q<{ event_type: string }>(
  `SELECT event_type FROM domain_events WHERE target_type = 'node' AND target_id = $1 AND event_type LIKE 'BLOCK_NODE_%' ORDER BY id`, [noteId])).rows.map((r) => r.event_type);

describe.skipIf(!isTestDb)("block nodes follow the note's text (DB)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Blocks',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
    // An existing tag in other case: `{重要}` and `{Exam}` must find, not duplicate.
    await seedQ(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1,'manual','class_tag','exam','exam','')`, [workspaceId]);
  });

  // Every test starts from its own freshly created note (its saved body is
  // `first`), never from the edits another test made to a shared one.
  let noteId = "";
  let first = "";
  beforeEach(async () => {
    const res = await send("/nodes", "POST", {
      title: `Search ${randomUUID().slice(0, 6)}`,
      markdown: "## 搜尋 {Exam}\n- 二分搜尋 {重要, Exam}\n  - plain\n    - 邊界 lo <= hi {易錯}\n\nplain text {}",
    });
    expect(res.status).toBe(201);
    noteId = ((await res.json()) as { id: string }).id;
    first = await bodyOf(noteId);
  });

  it("a new note's {tags} blocks get anchors, rows, parents and tags (the text stays as written)", async () => {
    const [s1, a1, a2] = [await refOf(noteId, "搜尋"), await refOf(noteId, "二分搜尋"), await refOf(noteId, "邊界 lo <= hi")];
    expect([s1, a1, a2].every((r) => /^[0-9a-f]{6}$/.test(r))).toBe(true);
    expect(first).toBe("## 搜尋 {Exam}\n- 二分搜尋 {重要, Exam}\n  - plain\n    - 邊界 lo <= hi {易錯}\n\nplain text {}"); // no ^id written; empty braces: not a block
    // The row's ref is its anchor's id.
    expect((await q<{ n: string }>(`SELECT count(*) AS n FROM block_nodes b JOIN block_anchors a ON a.note_id = b.note_id AND a.anchor_id = b.block_ref
      WHERE b.note_id = $1 AND b.anchor_id = b.block_ref`, [noteId])).rows[0]!.n).toBe("3");
    const byRef = (rows: Block[]) => [...rows].sort((x, y) => x.block_ref.localeCompare(y.block_ref));
    expect(byRef(await blocksOf(noteId))).toEqual(byRef([
      { block_ref: s1, parent_ref: null, kind: "heading", label: "搜尋", tags: ["exam"], hidden: false },
      { block_ref: a1, parent_ref: s1, kind: "listItem", label: "二分搜尋", tags: ["exam", "重要"], hidden: false },
      { block_ref: a2, parent_ref: a1, kind: "listItem", label: "邊界 lo <= hi", tags: ["易錯"], hidden: false },
    ] as Block[]));
    expect((await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND lower(title) = 'exam'`, [workspaceId])).rows).toHaveLength(1);
    expect(await blockEvents(noteId)).toEqual(["BLOCK_NODE_CREATED", "BLOCK_NODE_CREATED", "BLOCK_NODE_CREATED"]);
  });

  it("a text-only edit keeps every block node, with no block events", async () => {
    const before = await blocksOf(noteId);
    const events = (await blockEvents(noteId)).length;
    const edited = first.replace("邊界 lo <= hi", "邊界 lo <= hi，注意溢位");
    expect((await send(`/nodes/${noteId}`, "PATCH", { markdown: edited })).status).toBe(200);
    expect(await bodyOf(noteId)).toBe(edited);
    expect((await blocksOf(noteId)).map((b) => b.block_ref).sort()).toEqual(before.map((b) => b.block_ref).sort());
    expect(await blockEvents(noteId)).toHaveLength(events);
    first = edited;
  });

  it("a save whose text carries no ids at all keeps the same rows (the identity is the anchor, not the text)", async () => {
    const before = (await blocksOf(noteId)).map((b) => b.block_ref).sort();
    expect((await send(`/nodes/${noteId}`, "PATCH", { markdown: `${first}\n\nmore` })).status).toBe(200);
    const body = await bodyOf(noteId);
    expect(body).toBe(`${first}\n\nmore`);
    expect((await blocksOf(noteId)).every((b) => !b.hidden)).toBe(true);
    expect((await blocksOf(noteId)).map((b) => b.block_ref).sort()).toEqual(before);
    first = body;
  });

  it("{…} removed: the block is hidden with its data; back: the same row", async () => {
    const a2 = await refOf(noteId, "邊界 lo <= hi");
    const idBefore = (await q<{ id: string }>(`SELECT id FROM block_nodes WHERE note_id = $1 AND block_ref = $2`, [noteId, a2])).rows[0]!.id;
    const removed = first.replace(" {易錯}", "");
    expect((await send(`/nodes/${noteId}`, "PATCH", { markdown: removed })).status).toBe(200);
    expect((await blocksOf(noteId)).find((b) => b.block_ref === a2)?.hidden).toBe(true);
    expect((await blockEvents(noteId)).at(-1)).toBe("BLOCK_NODE_REMOVED");

    expect((await send(`/nodes/${noteId}`, "PATCH", { markdown: first })).status).toBe(200);
    const back = await q<{ id: string; hidden: boolean }>(`SELECT id, hidden_at IS NOT NULL AS hidden FROM block_nodes WHERE note_id = $1 AND block_ref = $2`, [noteId, a2]);
    expect(back.rows).toEqual([{ id: idBefore, hidden: false }]);
    expect((await blockEvents(noteId)).at(-1)).toBe("BLOCK_NODE_RESTORED");
  });

  it("undoing an edit undoes its block nodes", async () => {
    const a1 = await refOf(noteId, "二分搜尋");
    const retagged = first.replace("{重要, Exam}", "{重要}");
    expect((await send(`/nodes/${noteId}`, "PATCH", { markdown: retagged })).status).toBe(200);
    expect((await blocksOf(noteId)).find((b) => b.block_ref === a1)?.tags).toEqual(["重要"]);
    const edit = (await q<{ id: string }>(
      `SELECT id::text FROM domain_events WHERE target_id = $1 AND event_type = 'NODE_UPDATED' ORDER BY domain_events.id DESC LIMIT 1`, [noteId])).rows[0]!.id;
    const result = await restoreEvent(edit, { actor, workspaceId, cascade: true });
    expect(result, JSON.stringify(result)).toMatchObject({ restored: true });
    expect(await bodyOf(noteId)).toBe(first);
    expect((await blocksOf(noteId)).find((b) => b.block_ref === a1)?.tags).toEqual(["exam", "重要"]);
  });

  it("sync, by-id reads and bootstrap carry no block-node channel (clients cut blocks from the note text)", async () => {
    const since = (await q<{ id: string }>(`SELECT coalesce(max(id),0)::text AS id FROM domain_events WHERE workspace_id = $1`, [workspaceId])).rows[0]!.id;
    expect((await send(`/nodes/${noteId}`, "PATCH", { markdown: `${first}\n\nlater {新標籤}` })).status).toBe(200);
    const delta = (await (await app.request(`/sync?since=${since}`)).json()) as Record<string, unknown>;
    expect(delta).not.toHaveProperty("blocks");
    const byId = (await (await send("/sync/nodes", "POST", { ids: [noteId] })).json()) as Record<string, unknown>;
    expect(byId).not.toHaveProperty("blocks");
  });

  it("bootstrap still says block nodes are on (features.block_nodes, for cached older shells), without the rows", async () => {
    const boot = (await (await app.request("/bootstrap?bodies=none")).json()) as Record<string, unknown> & { features: { block_nodes: boolean } };
    expect(boot.features.block_nodes).toBe(true);
    expect(boot).not.toHaveProperty("blocks");
  });

  it("a copy gets its own block node rows and its own anchors (same labels, tags and shape, new ids)", async () => {
    const { node: copy } = await duplicateNote({ workspaceId, actor, sourceId: noteId });
    const copyId = String(copy.id);
    const mine = await blocksOf(noteId);
    const theirs = await blocksOf(copyId);
    const shape = (rows: Block[]) => rows.map((b) => ({ kind: b.kind, label: b.label, tags: b.tags })).sort((x, y) => x.label.localeCompare(y.label));
    expect(shape(theirs)).toEqual(shape(mine));
    // An anchor id belongs to one note: the copy's blocks are known by ids of their own.
    expect(theirs.map((b) => b.block_ref).filter((r) => mine.some((m) => m.block_ref === r))).toEqual([]);
    expect(theirs).toHaveLength(3);
  });

  it("an imported note keeps its text as the file has it", async () => {
    const { node } = await createNote({ actor, workspaceId, title: `Imported ${randomUUID().slice(0, 6)}`, markdown: "kept {重要}", event: { uiContext: "test.import" } });
    expect(await bodyOf(node.id as string)).toBe("kept {重要}");
    // The server gave the block its anchor; the text is as the file has it.
    expect((await blocksOf(node.id as string)).map((b) => b.label)).toEqual(["kept"]);
  });

  it("a note over BLOCK_PARSE_MAX keeps its block nodes as they are", async () => {
    const before = await blocksOf(noteId);
    const long = `${first}\n\n${"x".repeat(33_000)}`;
    expect((await send(`/nodes/${noteId}`, "PATCH", { markdown: long.replace(" {重要, Exam}", "") })).status).toBe(200);
    expect(await blocksOf(noteId)).toEqual(before); // not hidden, not changed
  });

  it("an editor save (it sends its base) is not rewritten: the server anchors the block, the text has no id", async () => {
    const res = await send("/nodes", "POST", { title: `Editor ${randomUUID().slice(0, 6)}`, markdown: "" });
    const id = ((await res.json()) as { id: string }).id;
    expect((await send(`/nodes/${id}`, "PATCH", { markdown: "- typed {重要}", base_markdown: "" })).status).toBe(200);
    expect(await bodyOf(id)).toBe("- typed {重要}");
    const [row] = await blocksOf(id);
    expect(row).toMatchObject({ label: "typed", tags: ["重要"] });
    expect(row!.block_ref).toMatch(/^[0-9a-f]{6}$/);
    // A later edit of the same block keeps its row and ref.
    expect((await send(`/nodes/${id}`, "PATCH", { markdown: "- typed more {重要}", base_markdown: "- typed {重要}" })).status).toBe(200);
    expect((await blocksOf(id)).map((b) => b.block_ref)).toEqual([row!.block_ref]);
  });

  it("tag paths match case-insensitively at every segment", async () => {
    const res = await send("/nodes", "POST", { title: `Paths ${randomUUID().slice(0, 6)}`, markdown: "a {Course/Week1}\n\nb {course/WEEK1}" });
    const id = ((await res.json()) as { id: string }).id;
    const tags = (await blocksOf(id)).map((b) => b.tags);
    expect(tags).toEqual([["Week1"], ["Week1"]]);
    expect((await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND lower(title) = 'week1' AND deleted_at IS NULL`, [workspaceId])).rows).toHaveLength(1);
  });

  it("a tag a block save created goes again when the block drops it before anything uses it", async () => {
    const res = await send("/nodes", "POST", { title: `Typing ${randomUUID().slice(0, 6)}`, markdown: "" });
    const id = ((await res.json()) as { id: string }).id;
    const alive = async (name: string) => (await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND title = $2 AND deleted_at IS NULL`, [workspaceId, name])).rows.length;
    const stray = `重${randomUUID().slice(0, 4)}`;
    expect((await send(`/nodes/${id}`, "PATCH", { markdown: `p {${stray}}`, base_markdown: "" })).status).toBe(200);
    expect(await alive(stray)).toBe(1);
    expect((await send(`/nodes/${id}`, "PATCH", { markdown: `p {${stray}要}`, base_markdown: `p {${stray}}` })).status).toBe(200);
    expect(await alive(stray)).toBe(0); // caught mid-typing: gone
    expect(await alive(`${stray}要`)).toBe(1);
    // A tag something else uses stays.
    expect((await send(`/nodes/${id}`, "PATCH", { markdown: "p {exam}", base_markdown: `p {${stray}要}` })).status).toBe(200);
    expect((await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND title = 'exam' AND deleted_at IS NULL`, [workspaceId])).rows).toHaveLength(1);
  });
});

