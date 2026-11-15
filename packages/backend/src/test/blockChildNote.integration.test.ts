// A block ↔ a child note (docs/architecture/block-nodes.md 「搬成子筆記／展開回內文」):
// one operation each way, one restorable event, references that follow, the
// block's data that goes along (tags, review schedules), what is refused.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import { AuthorityError } from "../spine/authority.js";
import { restoreEvent } from "../services/eventRestore/restore.js";
import { createNote } from "../services/noteCreate.js";
import { ensureBlockAnchor } from "../services/blockAnchors/index.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /_test\b/.test(database);
let workspaceId = "";
let actor: ActorCtx = { id: "child-admin", name: "Child", role: "admin", type: "human" };
// Notes this actor may not write (a permission that changed, a scope): the
// authority check answers for them as it would for a denied note.
const denied = new Set<string>();
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
vi.mock("../spine/authority.js", async (original) => {
  const real = await original<typeof import("../spine/authority.js")>();
  return {
    ...real,
    assertAuthority: async (a: ActorCtx, authority: Parameters<typeof real.assertAuthority>[1]) => {
      if (authority.kind === "node" && authority.op === "write_node" && denied.has(authority.nodeId)) throw new real.AuthorityError("space", "denied");
      return real.assertAuthority(a, authority);
    },
  };
});
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/nodes", nodesRouter);
registerShippedModules();
void AuthorityError;

const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
type Done = { note: { id: string; markdown: string }; child_id: string; event_id: string; rewritten: Array<{ id: string; title: string }>; left: Array<{ id: string; title: string }> };

const note = async (title: string, markdown: string, parentId?: string) =>
  String((await createNote({ actor, workspaceId, title, markdown, parentId, event: { uiContext: "test" } })).node.id);
const row = async (id: string) => (await q<{ title: string; markdown: string; parent_id: string | null; deleted_at: string | null }>(
  `SELECT title, markdown, parent_id::text, deleted_at::text FROM content_nodes WHERE id = $1`, [id])).rows[0]!;
const tagsOf = async (id: string) => (await q<{ title: string }>(
  `SELECT t.title FROM node_tags nt JOIN content_nodes t ON t.id = nt.tag_id WHERE nt.node_id = $1 ORDER BY t.title`, [id])).rows.map((r) => r.title);
/** The ref (anchor id) of the block labelled `label` (a block with `{…}` gets its anchor when the note is saved). */
const refByLabel = async (noteId: string, label: string) => {
  const r = (await q<{ block_ref: string }>(`SELECT block_ref FROM block_nodes WHERE note_id = $1 AND label = $2`, [noteId, label])).rows[0];
  expect(r, `no block labelled ${label}`).toBeTruthy();
  return r!.block_ref;
};
/** Anchors the block of `noteId` that contains `needle` (a block without `{…}` has no anchor until someone links to it). */
const anchorAt = async (noteId: string, needle: string) => {
  const markdown = (await row(noteId)).markdown;
  const id = await ensureBlockAnchor(workspaceId, noteId, markdown, markdown.indexOf(needle), { actor });
  expect(id, `no block holds ${needle}`).toBeTruthy();
  return id!;
};
const anchorHolder = async (anchorId: string) => (await q<{ note_id: string; status: string }>(
  `SELECT note_id::text, status FROM block_anchors WHERE workspace_id = $1 AND anchor_id = $2`, [workspaceId, anchorId])).rows[0];
const blockRow = async (noteId: string, ref: string) => (await q<{ id: string; hidden: boolean }>(
  `SELECT id::text, hidden_at IS NOT NULL AS hidden FROM block_nodes WHERE note_id = $1 AND block_ref = $2`, [noteId, ref])).rows[0];

const notes = (w: string) => [
  "# 筆記", "", `## ${w} {考點}`, "", "二分搜尋每次砍半。", "", "- 邊界要用 lo <= hi", "- 別忘了空陣列", "", "## 排序", "", "快速排序。", "",
].join("\n");

describe.skipIf(!isTestDb)("block ↔ child note (DB)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Child note',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
  });

  it("moves a section out, rewrites references, and one restore undoes it all", async () => {
    const title = `算法-${randomUUID().slice(0, 6)}`;
    const w = `搜尋${randomUUID().slice(0, 6)}`, NOTES = notes(w);
    const source = await note(title, NOTES);
    const s1 = await refByLabel(source, w);
    const a2 = await anchorAt(source, "邊界要用"); // an untagged item inside the section, linked to by id
    const other = await note(`複習-${randomUUID().slice(0, 6)}`,
      `見 [[${title}#^${s1}]]、![[${title}#^${s1}|摘錄]]、[[${title}#^${a2}]]、[[${title}#${w}]]、[[${title}#排序]]。\n\n\`[[${title}#^${s1}]]\`\n`);
    const bystander = await note(`無關-${randomUUID().slice(0, 6)}`, "沒有引用。\n");

    const res = await post(`/nodes/${source}/block-to-child`, { block_ref: s1 });
    expect(res.status).toBe(200);
    const done = await res.json() as Done;

    // The note reads the same through the embed; the section's text is the child's.
    expect(done.note.markdown).toBe(`# 筆記\n\n![[${w}]]\n\n## 排序\n\n快速排序。\n`);
    const child = await row(done.child_id);
    expect(child).toMatchObject({ title: w, parent_id: source, deleted_at: null });
    expect(child.markdown).toBe(`## ${w}\n\n二分搜尋每次砍半。\n\n- 邊界要用 lo <= hi\n- 別忘了空陣列`);
    // {考點} became the child's tag; the anchor of the item inside travelled with its text.
    expect(await tagsOf(done.child_id)).toEqual(["考點"]);

    // References followed — links, embeds with their label, ids that travelled,
    // the heading by its text; code and other headings stayed.
    expect(done.rewritten.map((n) => n.id)).toEqual([other]);
    expect((await row(other)).markdown).toBe(
      `見 [[${w}]]、![[${w}|摘錄]]、[[${w}#^${a2}]]、[[${w}]]、[[${title}#排序]]。\n\n\`[[${title}#^${s1}]]\`\n`);
    expect((await row(bystander)).markdown).toBe("沒有引用。\n");

    // One undo, all of it.
    const undone = await restoreEvent(done.event_id, { actor, workspaceId, cascade: true });
    expect(undone).toMatchObject({ restored: true });
    expect((await row(source)).markdown).toBe(NOTES);
    expect((await row(done.child_id)).deleted_at).not.toBeNull();
    expect((await row(other)).markdown).toContain(`[[${title}#^${s1}]]、![[${title}#^${s1}|摘錄]]`);
  });

  it("moves a selection across paragraphs and half of one: references follow, one restore undoes it", async () => {
    const title = `算法-${randomUUID().slice(0, 6)}`;
    // `^h3` mid-line is plain text, not an id; the anchors are rows: h1 on a paragraph the selection only half takes,
    // h2 on one it takes whole.
    const NOTES = "前文\n\n第一段開頭 選到的一半\n\n第二段全選。\n\n第三段 ^h3 的後半留下\n\n後文\n";
    const source = await note(title, NOTES);
    const h1 = await anchorAt(source, "第一段開頭"), h2 = await anchorAt(source, "第二段全選");
    const other = await note(`複習-${randomUUID().slice(0, 6)}`, `見 [[${title}#^${h1}]]、[[${title}#^${h2}]] 與 [[${title}#^h3]]。\n`);
    const from = NOTES.indexOf("選到的一半"), to = NOTES.indexOf("的後半留下") - 1;
    const text = NOTES.slice(from, to);

    // The saved note no longer says what the person selected: nothing is moved on a guess.
    const stale = await post(`/nodes/${source}/block-to-child`, { selection: { from, to, text: `${text}!` } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "selection_changed" });
    expect((await row(source)).markdown).toBe(NOTES);

    const res = await post(`/nodes/${source}/block-to-child`, { selection: { from, to, text } });
    expect(res.status).toBe(200);
    const done = await res.json() as Done;
    const child = await row(done.child_id);
    expect(child).toMatchObject({ parent_id: source, deleted_at: null });
    expect(child.markdown).toBe("選到的一半\n\n第二段全選。\n\n第三段 ^h3");
    expect(done.note.markdown).toBe(`前文\n\n第一段開頭\n\n![[${child.title}]]\n\n的後半留下\n\n後文\n`);
    // h2 starts inside the selection, so its anchor travelled: its link reaches the child now. h1 starts before it,
    // so it stays with its paragraph. `^h3` sat mid-line — plain text, not an id — so its link is left as it was.
    expect(await anchorHolder(h1)).toMatchObject({ note_id: source });
    expect((await row(other)).markdown).toBe(`見 [[${title}#^${h1}]]、[[${child.title}#^${h2}]] 與 [[${title}#^h3]]。\n`);

    expect(await restoreEvent(done.event_id, { actor, workspaceId, cascade: true })).toMatchObject({ restored: true });
    expect((await row(source)).markdown).toBe(NOTES);
    expect((await row(done.child_id)).deleted_at).not.toBeNull();
    expect((await row(other)).markdown).toBe(`見 [[${title}#^${h1}]]、[[${title}#^${h2}]] 與 [[${title}#^h3]]。\n`);
  });

  it("an anchor inside the moved text goes with it (the child holds it, a link to it still resolves), and comes back with the undo", async () => {
    const title = `算法-${randomUUID().slice(0, 6)}`;
    const w = `搜尋${randomUUID().slice(0, 6)}`;
    const source = await note(title, notes(w));
    const s1 = await refByLabel(source, w);
    const a2 = await anchorAt(source, "邊界要用");
    const done = await (await post(`/nodes/${source}/block-to-child`, { block_ref: s1 })).json() as Done;
    // The links to the item were rewritten to the child (see the test above): so the child must hold that anchor.
    expect(await anchorHolder(a2)).toMatchObject({ note_id: done.child_id, status: "valid" });
    expect(await restoreEvent(done.event_id, { actor, workspaceId, cascade: true })).toMatchObject({ restored: true });
    expect(await anchorHolder(a2)).toMatchObject({ note_id: source, status: "valid" });
    // The section's own row and anchor are back too, the row visible.
    expect(await anchorHolder(s1)).toMatchObject({ note_id: source, status: "valid" });
    expect((await blockRow(source, s1))?.hidden).toBe(false);
  });

  it("an anchor that starts inside a moved selection goes with it, one that starts before it stays", async () => {
    const title = `算法-${randomUUID().slice(0, 6)}`;
    const NOTES = "前文\n\n第一段開頭 選到的一半\n\n第二段全選。\n\n後文\n";
    const source = await note(title, NOTES);
    const h1 = await anchorAt(source, "第一段開頭"), h2 = await anchorAt(source, "第二段全選");
    const from = NOTES.indexOf("選到的一半"), to = NOTES.indexOf("第二段全選。") + "第二段全選。".length;
    const done = await (await post(`/nodes/${source}/block-to-child`, { selection: { from, to, text: NOTES.slice(from, to) } })).json() as Done;
    expect(await anchorHolder(h2)).toMatchObject({ note_id: done.child_id, status: "valid" });
    expect(await anchorHolder(h1)).toMatchObject({ note_id: source, status: "valid" });
  });

  it("takes exactly one of a block or a selection", async () => {
    const source = await note(`算法-${randomUUID().slice(0, 6)}`, "一段\n");
    expect((await post(`/nodes/${source}/block-to-child`, {})).status).toBe(400);
    expect((await post(`/nodes/${source}/block-to-child`, { block_ref: "p1", selection: { from: 0, to: 1, text: "一" } })).status).toBe(400);
  });

  it("expands the embed back: text and tags return, the block is anchored, references follow back, the child is trashed", async () => {
    const title = `算法-${randomUUID().slice(0, 6)}`;
    // Punctuation a LIKE on the text index mishandles (pgroonga): the candidates must still be found.
    const w = `搜尋${randomUUID().slice(0, 6)}，O(log n)。`, NOTES = notes(w);
    const source = await note(title, NOTES);
    const moved = await (await post(`/nodes/${source}/block-to-child`, { block_ref: await refByLabel(source, w) })).json() as Done;
    const other = await note(`複習-${randomUUID().slice(0, 6)}`, `看 [[${w}]] 與 ![[${w}|摘錄]]。\n`);

    const res = await post(`/nodes/${source}/expand-child`, { child_id: moved.child_id });
    expect(res.status).toBe(200);
    const done = await res.json() as Done;
    expect(done.note.markdown).toBe(NOTES); // no `^id` written: the text is what it was
    expect((await row(moved.child_id)).deleted_at).not.toBeNull();
    // The block is a block node again, known by an anchor; the links that named the child reach it by that id.
    // (the section's old row stays hidden beside it: a plain move hides its source row, see 搬成子筆記)
    const ref = (await q<{ block_ref: string }>(`SELECT block_ref FROM block_nodes WHERE note_id = $1 AND label = $2 AND hidden_at IS NULL`, [source, w])).rows[0]?.block_ref;
    expect(ref).toBeTruthy();
    expect((await row(other)).markdown).toBe(`看 [[${title}#^${ref}]] 與 ![[${title}#^${ref}|摘錄]]。\n`);

    // And the expand is one event too.
    expect(await restoreEvent(done.event_id, { actor, workspaceId, cascade: true })).toMatchObject({ restored: true });
    expect((await row(moved.child_id)).deleted_at).toBeNull();
    expect((await row(source)).markdown).toContain(`![[${w}]]`);
    expect((await row(other)).markdown).toBe(`看 [[${w}]] 與 ![[${w}|摘錄]]。\n`);
  });

  it("names the child so [[title]] reaches only it", async () => {
    const source = await note(`算法-${randomUUID().slice(0, 6)}`, "前文\n\n同名的一段 {考點}\n\n後文\n");
    await note("同名的一段", "已經有這篇。\n");
    const done = await (await post(`/nodes/${source}/block-to-child`, { block_ref: await refByLabel(source, "同名的一段") })).json() as Done;
    expect((await row(done.child_id)).title).toBe("同名的一段 (2)");
    expect(done.note.markdown).toContain("![[同名的一段 (2)]]");
  });

  it("carries review schedules: the block's goes to the child note, a block inside keeps its own", async () => {
    const tag = await seedClassTag(workspaceId, { name: `卡-${randomUUID().slice(0, 6)}`, behaviour: { modules: { review: { enabled: true } } } });
    const name = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [tag.tagId])).rows[0]!.title;
    const source = await note(`算法-${randomUUID().slice(0, 6)}`, `## 卡片 {${name}}\n\n- 內層 {${name}}\n`);
    // The save made the block rows and their anchors (the text carries no ids).
    const c1 = await refByLabel(source, "卡片"), c2 = await refByLabel(source, "內層");
    const outer = (await blockRow(source, c1))!, inner = (await blockRow(source, c2))!;
    const state = JSON.stringify({ reps: 3, due: "2026-11-01T00:00:00.000Z" });
    for (const id of [outer.id, inner.id]) {
      await seedQ(`INSERT INTO review_states(workspace_id, block_id, actor_id, state) VALUES ($1,$2,$3,$4)`, [workspaceId, id, actor.id, state]);
    }

    const done = await (await post(`/nodes/${source}/block-to-child`, { block_ref: c1 })).json() as Done;
    expect(await tagsOf(done.child_id)).toEqual([name]);
    expect((await q<{ state: string }>(`SELECT state FROM review_states WHERE node_id = $1 AND actor_id = $2`, [done.child_id, actor.id])).rows[0]?.state).toBe(state);
    // The inner block is a block of the child now (its own row there: the moved text got its own anchors).
    const innerNow = (await q<{ id: string }>(`SELECT id::text FROM block_nodes WHERE note_id = $1 AND label = '內層'`, [done.child_id])).rows[0]!;
    expect((await q<{ state: string }>(`SELECT state FROM review_states WHERE block_id = $1`, [innerNow.id])).rows[0]?.state).toBe(state);
    // The source rows are still there (hidden): undoing finds the schedule.
    expect((await q(`SELECT 1 FROM review_states WHERE block_id = $1`, [outer.id])).rowCount).toBe(1);

    // Reviewed more in the child; expanding takes the newer schedule back to the block.
    const newer = JSON.stringify({ reps: 4, due: "2026-12-01T00:00:00.000Z" });
    await seedQ(`UPDATE review_states SET state = $3, updated_at = now() + interval '1 hour' WHERE node_id = $1 AND actor_id = $2`, [done.child_id, actor.id, newer]);
    const back = await (await post(`/nodes/${source}/expand-child`, { child_id: done.child_id })).json() as Done;
    expect(back.note.markdown).toContain("## 卡片");
    const block = (await blockRow(source, await refByLabel(source, "卡片")))!;
    expect((await q<{ state: string }>(`SELECT state FROM review_states WHERE block_id = $1`, [block.id])).rows[0]?.state).toBe(newer);
  });

  it("refuses what it cannot carry without losing something, and writes nothing", async () => {
    const source = await note(`算法-${randomUUID().slice(0, 6)}`, "- [ ] 寫作業 {task}\n\n> 引用\n\n第三段\n");
    // A task line: its block row links the task node that hangs on the note (a child of the note, so the count below starts at 1).
    const t1 = await refByLabel(source, "寫作業");
    expect((await blockRow(source, t1))).toBeTruthy();
    const q1 = await anchorAt(source, "引用"); // a quote can be anchored, but not carried out as text
    const before = (await row(source)).markdown;
    const move = async (block_ref: string) => { const r = await post(`/nodes/${source}/block-to-child`, { block_ref }); return [r.status, (await r.json() as { error: string }).error] as const; };
    expect(await move("zz")).toEqual([409, "block_not_found"]);
    expect(await move(q1)).toEqual([422, "block_unsupported"]);
    expect(await move(t1)).toEqual([409, "block_has_task_line"]);
    expect((await row(source)).markdown).toBe(before);
    expect((await q(`SELECT 1 FROM content_nodes WHERE parent_id = $1`, [source])).rowCount).toBe(1); // only the task's own note, no child made
  });

  it("refuses a block with {tags} the note was never saved with", async () => {
    const source = await note(`算法-${randomUUID().slice(0, 6)}`, "只在文字裡 {新標籤}\n");
    const n1 = await refByLabel(source, "只在文字裡"); // the anchor is the note's; only the block row is taken away
    await seedQ(`DELETE FROM block_nodes WHERE note_id = $1`, [source]);
    const r = await post(`/nodes/${source}/block-to-child`, { block_ref: n1 });
    expect([r.status, (await r.json() as { error: string }).error]).toEqual([409, "block_not_saved"]);
  });

  it("refuses to rewrite where the person may not write: by default nothing happens, 'leave' goes on", async () => {
    const title = `算法-${randomUUID().slice(0, 6)}`;
    const source = await note(title, "一段\n\n另一段\n");
    const p1 = await anchorAt(source, "一段");
    const locked = await note(`鎖住-${randomUUID().slice(0, 6)}`, `參照 [[${title}#^${p1}]]\n`);
    const open = await note(`可寫-${randomUUID().slice(0, 6)}`, `參照 [[${title}#^${p1}]]\n`);
    denied.add(locked);
    try {
      const refused = await post(`/nodes/${source}/block-to-child`, { block_ref: p1 });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: "references_unwritable", notes: [{ id: locked }], hidden_count: 0 });
      expect((await row(source)).markdown).toBe("一段\n\n另一段\n");
      expect((await row(open)).markdown).toBe(`參照 [[${title}#^${p1}]]\n`);

      const done = await (await post(`/nodes/${source}/block-to-child`, { block_ref: p1, unwritable: "leave" })).json() as Done;
      expect(done.left.map((n) => n.id)).toEqual([locked]);
      expect(done.rewritten.map((n) => n.id)).toEqual([open]);
      expect((await row(locked)).markdown).toBe(`參照 [[${title}#^${p1}]]\n`);
      expect((await row(open)).markdown).toBe("參照 [[一段]]\n");

      // Expanding never leaves a reference behind: the child note is going away.
      const stuck = await note(`又鎖住-${randomUUID().slice(0, 6)}`, "指向 [[一段]]\n");
      denied.add(stuck);
      const expand = await post(`/nodes/${source}/expand-child`, { child_id: done.child_id });
      expect(expand.status).toBe(409);
      expect(await expand.json()).toMatchObject({ error: "references_unwritable", notes: [{ id: stuck }] });
      expect((await row(done.child_id)).deleted_at).toBeNull();
    } finally { denied.clear(); }
  });

  it("refuses to expand a child that would lose something", async () => {
    const source = await note(`算法-${randomUUID().slice(0, 6)}`, "![[甲]]\n");
    const expand = async (child: string, body: Record<string, unknown> = {}) => {
      const r = await post(`/nodes/${source}/expand-child`, { child_id: child, ...body });
      return [r.status, (await r.json() as { error: string }).error] as const;
    };
    const withKids = await note("甲", "文字\n", source);
    await note("甲的子筆記", "深一層\n", withKids);
    expect(await expand(withKids)).toEqual([409, "child_has_children"]);
    expect(await expand((await note("不是子筆記", "x\n")))).toEqual([409, "child_not_child"]);

    const props = await note("乙", "文字\n", source);
    await seedQ(`INSERT INTO node_attributes(workspace_id, node_id, key, value, value_type, source) VALUES ($1,$2,'priority','high','text','ui')`, [workspaceId, props]);
    await seedQ(`UPDATE content_nodes SET markdown = '![[甲]]\n\n![[乙]]\n' WHERE id = $1`, [source]);
    expect(await expand(props)).toEqual([409, "child_has_properties"]);

    const many = await note("丙", "第一段\n\n第二段\n", source);
    await seedQ(`UPDATE content_nodes SET markdown = '![[丙]]\n' WHERE id = $1`, [source]);
    expect(await expand(many)).toEqual([422, "child_not_one_block"]);

    const lost = await note("丁", "文字\n", source);
    expect(await expand(lost)).toEqual([409, "embed_not_found"]);
    await seedQ(`UPDATE content_nodes SET markdown = '![[丁]]\n\n![[丁]]\n' WHERE id = $1`, [source]);
    expect(await expand(lost)).toEqual([409, "embed_ambiguous"]);
    expect((await row(lost)).deleted_at).toBeNull();
  });

  it("refuses to take a kept-off child back into a note that is on the site, unless that note is kept off too", async () => {
    const keepOff = (id: string) => seedQ(`INSERT INTO node_attributes(workspace_id, node_id, key, value, value_type, source) VALUES ($1,$2,'_published','false','text','ui')`, [workspaceId, id]);
    const setup = async (name: string) => {
      const childTitle = `子-${randomUUID().slice(0, 6)}`;
      const source = await note(`${name}-${randomUUID().slice(0, 6)}`, `![[${childTitle}]]\n`);
      const child = await note(childTitle, "文字\n", source);
      await keepOff(child);
      const spaceId = (await q<{ space_id: string }>(`SELECT space_id::text FROM content_nodes WHERE id = $1`, [source])).rows[0]!.space_id;
      return { source, child, spaceId };
    };
    const expand = async (source: string, child: string) => {
      const r = await post(`/nodes/${source}/expand-child`, { child_id: child });
      return [r.status, r.status === 200 ? null : (await r.json() as { error: string }).error] as const;
    };
    const publishing = async (spaceId: string, on: boolean) => seedQ(`UPDATE spaces SET capabilities = capabilities || $2::jsonb WHERE id = $1`, [spaceId, JSON.stringify({ publish: on })]);

    const onSite = await setup("上網站");
    await publishing(onSite.spaceId, true);
    try {
      expect(await expand(onSite.source, onSite.child)).toEqual([409, "child_kept_off"]);
      expect((await row(onSite.child)).deleted_at).toBeNull();
      // The same note kept off the site: nothing would become public.
      const bothOff = await setup("都不發布");
      await keepOff(bothOff.source);
      expect(await expand(bothOff.source, bothOff.child)).toEqual([200, null]);
      // Putting the child on the site first is the person's way through.
      await seedQ(`UPDATE node_attributes SET value = 'true' WHERE node_id = $1 AND key = '_published'`, [onSite.child]);
      expect(await expand(onSite.source, onSite.child)).toEqual([200, null]);
    } finally { await publishing(onSite.spaceId, false); }
    // A space that does not publish: the child was never on a site.
    const private_ = await setup("不公開空間");
    expect(await expand(private_.source, private_.child)).toEqual([200, null]);
  });

  it("is refused for a person who may not write the note, with nothing written", async () => {
    const source = await note(`算法-${randomUUID().slice(0, 6)}`, "一段\n");
    const p1 = await anchorAt(source, "一段");
    const viewer = await persistActor(workspaceId, { id: "child-viewer", name: "Viewer", role: "viewer", type: "human" });
    const asAdmin = actor;
    actor = viewer;
    try {
      expect((await post(`/nodes/${source}/block-to-child`, { block_ref: p1 })).status).toBe(403);
    } finally { actor = asAdmin; }
    expect((await row(source)).markdown).toBe("一段\n");
    expect((await q(`SELECT 1 FROM content_nodes WHERE parent_id = $1`, [source])).rowCount).toBe(0);
  });
});
