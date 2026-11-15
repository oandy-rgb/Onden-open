// Write stamps and the structure log for attributes, tag applications, hand-made edges, pointers and board cards
// (db/migrations/194_stamps_s2.sql, causal-stamps proposal S2), through the real routes: what each kind of write stamps,
// that a transaction shares one stamp, that an unchanged field keeps its stamp, that deletes leave a tombstone, what the
// structure log records, and that none of it shows in a response, the sync content or a backup.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { getWorkspaceId, pool, q } from "../db.js";
import nodeRouter from "../routes/nodes.js";
import tagRouter from "../routes/tags.js";
import edgeRouter from "../routes/edges.js";
import pointerRouter from "../routes/pointers.js";
import boardRouter from "../routes/boards.js";
import canvasRouter from "../routes/canvases.js";
import backupRouter from "../routes/backup.js";
import syncRouter from "../routes/sync.js";
import bootstrapRouter from "../routes/bootstrap.js";
import { withRequestDevice } from "../requestContext.js";
import type { ActorCtx } from "../types.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { stampTransaction } from "../spine/stamps.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";
import { zipEntries } from "./helpers/zipEntries.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const DEVICE = randomUUID();

type Stamp = { field: string; origin: string; seq: number; hlc_wall: number; hlc_counter: number; author: string | null; device: string | null; deleted: boolean };
type LogRow = { field: string; old_value: string | null; new_value: string | null; seq: number; author: string | null };

describe.skipIf(!isTestDb)("write stamps on attributes, tags, edges, pointers and board cards", () => {
  let ws = "";
  let owner!: ActorCtx;
  let space = "";
  const server = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  server.onError(apiOnError);
  server.use("*", async (c, next) => { c.set("actor", owner); await withRequestDevice(DEVICE, next); });
  server.route("/api/nodes", nodeRouter);
  server.route("/api/tags", tagRouter);
  server.route("/api/edges", edgeRouter);
  server.route("/api/pointers", pointerRouter);
  server.route("/api/boards", boardRouter);
  server.route("/api/canvases", canvasRouter);
  server.route("/api/backup", backupRouter);
  server.route("/api/sync", syncRouter);
  server.route("/api/bootstrap", bootstrapRouter);

  const call = async (method: string, path: string, body?: unknown) => {
    const res = await server.request(path, {
      method, headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* plain text */ }
    return { status: res.status, json };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, body);
    expect(r.status, `${method} ${path}: ${JSON.stringify(r.json)}`).toBeLessThan(300);
    return r.json;
  };
  const note = async () => (await ok("POST", "/api/nodes", { id: randomUUID(), title: `s2 ${randomUUID().slice(0, 8)}`, markdown: "x", space_id: space })).id as string;
  const tag = async () => (await ok("POST", "/api/tags", { name: `s2tag-${randomUUID().slice(0, 8)}` })).id as string;
  const canvas = async () => (await ok("POST", "/api/canvases", { space_id: space })).id as string;
  const stampsOf = async (table: string, key: string): Promise<Map<string, Stamp>> => new Map((await q<Stamp>(
    `SELECT field, origin, seq::int, hlc_wall::float8 AS hlc_wall, hlc_counter, author, device::text, deleted
       FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3`, [ws, table, key])).rows.map((r) => [r.field, r]));
  const logOf = async (table: string, key: string): Promise<LogRow[]> => (await q<LogRow>(
    `SELECT field, old_value, new_value, seq::int, author FROM structure_log WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 ORDER BY id`,
    [ws, table, key])).rows;
  const setAttr = (id: string, key: string, value: string) => ok("PUT", `/api/nodes/${id}/attributes/${key}`, { value });
  const placeCards = (board: string, cards: Record<string, unknown>[]) => ok("PATCH", `/api/boards/${board}`, { cards: { upsert: cards } });
  const dropCards = (board: string, ids: string[]) => ok("PATCH", `/api/boards/${board}`, { cards: { remove: ids } });
  /** A write that carries a stamp, as a root write through mutate() does, for the tables no route here reaches. */
  const stamped = (write: () => Promise<unknown>) => withEventTransaction(ws, async () => { await stampTransaction(ws, owner.id); await write(); });

  beforeAll(async () => {
    registerShippedModules();
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test', 'default') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`);
    ws = await getWorkspaceId();
    owner = await persistActor(ws, { id: "", name: "S2 Owner", role: "admin", type: "human" });
    space = await makeSpace(ws, `s2 ${Date.now()}`, [{ id: owner.id, permission: "edit" }]);
  });
  afterAll(async () => { await pool.end(); });

  describe("node attributes", () => {
    it("a person's value is stamped as a whole, then per changed field; an unchanged field keeps its stamp", async () => {
      const id = await note();
      await setAttr(id, "mood", "calm");
      const created = (await stampsOf("node_attributes", `${id}/mood`)).get("*")!;
      expect(created).toMatchObject({ author: owner.id, device: DEVICE, deleted: false });

      await setAttr(id, "mood", "tense");
      const afterValue = await stampsOf("node_attributes", `${id}/mood`);
      expect([...afterValue.keys()].sort()).toEqual(["*", "value"]);
      expect(afterValue.get("*")).toEqual(created);
      const valueStamp = afterValue.get("value")!;
      expect(valueStamp.seq).toBeGreaterThan(created.seq);

      await setAttr(id, "mood", "tense"); // the same value again: nothing changed
      expect((await stampsOf("node_attributes", `${id}/mood`)).get("value")).toEqual(valueStamp);
    });

    it("deleting leaves a tombstone and no field stamps", async () => {
      const id = await note();
      await setAttr(id, "mood", "calm");
      await setAttr(id, "mood", "tense");
      await ok("DELETE", `/api/nodes/${id}/attributes/mood`);
      const left = await stampsOf("node_attributes", `${id}/mood`);
      expect([...left.keys()]).toEqual(["*"]);
      expect(left.get("*")).toMatchObject({ deleted: true, author: owner.id });
    });

    it("a value the note's text produced or Onden computed is not stamped; one that changes kind counts as made / removed", async () => {
      const id = await note();
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, source) VALUES ($1, $2, 'fromtext', 'a', 'markdown')`, [ws, id]);
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, source) VALUES ($1, $2, 'computed', 'a', 'derived')`, [ws, id]);
      expect((await stampsOf("node_attributes", `${id}/fromtext`)).size).toBe(0);
      expect((await stampsOf("node_attributes", `${id}/computed`)).size).toBe(0);
      await seedQ(`UPDATE node_attributes SET value = 'b' WHERE node_id = $1 AND key = 'fromtext'`, [id]);
      expect((await stampsOf("node_attributes", `${id}/fromtext`)).size).toBe(0);

      await stamped(() => q(`UPDATE node_attributes SET source = 'ui' WHERE node_id = $1 AND key = 'fromtext'`, [id]));
      expect((await stampsOf("node_attributes", `${id}/fromtext`)).get("*")).toMatchObject({ deleted: false, author: owner.id });
      await stamped(() => q(`UPDATE node_attributes SET source = 'markdown' WHERE node_id = $1 AND key = 'fromtext'`, [id]));
      expect((await stampsOf("node_attributes", `${id}/fromtext`)).get("*")).toMatchObject({ deleted: true });
    });

    it("a board's section frames keep their old and new value in the structure log; other attributes do not", async () => {
      const board = await canvas();
      const frame = (title: string) => ({ id: "f1", title, x: 0, y: 0, width: 100, height: 80 });
      await ok("PATCH", `/api/boards/${board}`, { sections: { upsert: [frame("one")] } });
      await ok("PATCH", `/api/boards/${board}`, { sections: { upsert: [frame("two")] } });
      await ok("PATCH", `/api/boards/${board}`, { sections: { remove: ["f1"] } });
      const log = (await logOf("node_attributes", `${board}/_canvas_sections`)).filter((r) => r.field === "sections");
      expect(log.map((r) => [r.old_value === null ? null : JSON.parse(r.old_value)[0]?.title ?? "none", r.new_value === null ? null : JSON.parse(r.new_value)[0]?.title ?? "none"]))
        .toEqual([[null, "one"], ["one", "two"], ["two", null]]);
      const other = await note();
      await setAttr(other, "mood", "calm");
      expect(await logOf("node_attributes", `${other}/mood`)).toEqual([]);
    });
  });

  describe("tag applications", () => {
    it("applying stamps the pair and logs it; removing leaves a tombstone and logs it; applying again revives it", async () => {
      const id = await note();
      const t = await tag();
      await ok("PUT", `/api/nodes/${id}/tags/${t}`);
      const applied = (await stampsOf("node_tags", `${id}/${t}`)).get("*")!;
      // applyTagToNode writes the row before any mutate() root of its own, so the trigger made this stamp (no author) and counted it:
      // one of the write points S4 brings under a root (listed in the PR).
      expect(applied).toMatchObject({ deleted: false });
      await ok("DELETE", `/api/nodes/${id}/tags/${t}`);
      const removed = (await stampsOf("node_tags", `${id}/${t}`)).get("*")!;
      expect(removed).toMatchObject({ deleted: true });
      expect(removed.seq).toBeGreaterThan(applied.seq);
      await ok("PUT", `/api/nodes/${id}/tags/${t}`);
      const again = (await stampsOf("node_tags", `${id}/${t}`)).get("*")!;
      expect(again).toMatchObject({ deleted: false });
      expect(again.seq).toBeGreaterThan(removed.seq);
      expect((await logOf("node_tags", id)).map((r) => [r.field, r.old_value, r.new_value]))
        .toEqual([["tag", null, t], ["tag", t, null], ["tag", null, t]]);
    });

    it("purging a note takes its tags along: each leaves a tombstone and a removal in the log", async () => {
      const id = await note();
      const t = await tag();
      await ok("PUT", `/api/nodes/${id}/tags/${t}`);
      await ok("DELETE", `/api/nodes/${id}`);
      const preview = await ok("GET", `/api/nodes/${id}/purge-preview`);
      await ok("POST", `/api/nodes/${id}/purge`, { expected_ids: preview.ids ?? [id] });
      expect((await stampsOf("node_tags", `${id}/${t}`)).get("*")).toMatchObject({ deleted: true });
      expect((await logOf("node_tags", id)).at(-1)).toMatchObject({ old_value: t, new_value: null });
    });

    it("a paragraph's tags are stamped per (paragraph, tag) with a tombstone on removal", async () => {
      const id = await note();
      const t = await tag();
      const block = randomUUID();
      await seedQ(`INSERT INTO block_nodes (id, workspace_id, note_id, block_ref, kind) VALUES ($1, $2, $3, 'b1', 'paragraph')`, [block, ws, id]);
      await stamped(() => q(`INSERT INTO block_node_tags (block_node_id, tag_id, workspace_id) VALUES ($1, $2, $3)`, [block, t, ws]));
      const first = (await stampsOf("block_node_tags", `${block}/${t}`)).get("*")!;
      expect(first).toMatchObject({ deleted: false, author: owner.id });
      await stamped(() => q(`DELETE FROM block_node_tags WHERE block_node_id = $1 AND tag_id = $2`, [block, t]));
      expect((await stampsOf("block_node_tags", `${block}/${t}`)).get("*")).toMatchObject({ deleted: true });
    });
  });

  describe("paragraph tags written through a note's text", () => {
    it("dropping one tag from a paragraph tombstones that tag only; the tag that stays keeps its stamp", async () => {
      const id = (await ok("POST", "/api/nodes", { id: randomUUID(), title: `s2 blocks ${randomUUID().slice(0, 6)}`, markdown: "- item {s2alpha, s2beta}", space_id: space })).id as string;
      const tagsOf = async () => new Map((await q<{ block: string; tag: string; name: string }>(
        `SELECT t.block_node_id::text AS block, t.tag_id::text AS tag, n.title AS name FROM block_node_tags t
           JOIN block_nodes b ON b.id = t.block_node_id JOIN content_nodes n ON n.id = t.tag_id WHERE b.note_id = $1`, [id])).rows.map((r) => [r.name.toLowerCase(), r]));
      const before = await tagsOf();
      expect([...before.keys()].sort()).toEqual(["s2alpha", "s2beta"]);
      const alpha = before.get("s2alpha")!; const beta = before.get("s2beta")!;
      const kept = (await stampsOf("block_node_tags", `${alpha.block}/${alpha.tag}`)).get("*")!;
      await ok("PATCH", `/api/nodes/${id}`, { markdown: "- item {s2alpha}" });
      expect((await stampsOf("block_node_tags", `${alpha.block}/${alpha.tag}`)).get("*")).toEqual(kept);
      expect((await stampsOf("block_node_tags", `${beta.block}/${beta.tag}`)).get("*")).toMatchObject({ deleted: true });
    });
  });

  describe("hand-made edges", () => {
    it("a hand-made edge is stamped by what it connects, its status on its own, and removing it leaves a tombstone", async () => {
      const [a, b] = [await note(), await note()];
      const edge = await ok("POST", "/api/edges", { source_node_id: a, target_node_id: b, edge_type: "relates_to" });
      const key = `${a}/${b}/relates_to`;
      const created = (await stampsOf("node_edges", key)).get("*")!;
      expect(created).toMatchObject({ deleted: false, author: owner.id, device: DEVICE });
      await stamped(() => q(`UPDATE node_edges SET status = 'rejected' WHERE id = $1`, [edge.id]));
      const after = await stampsOf("node_edges", key);
      expect([...after.keys()].sort()).toEqual(["*", "status"]);
      expect(after.get("*")).toEqual(created);
      await ok("DELETE", `/api/edges/${edge.id}`);
      expect([...(await stampsOf("node_edges", key)).entries()].map(([f, s]) => [f, s.deleted])).toEqual([["*", true]]);
    });

    it("an automatic edge is not stamped", async () => {
      const [a, b] = [await note(), await note()];
      await seedQ(`INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, origin) VALUES ($1, $2, $3, 'wikilink', 'active', 'wikilink')`, [ws, a, b]);
      expect((await stampsOf("node_edges", `${a}/${b}/wikilink`)).size).toBe(0);
    });
  });

  describe("pointers", () => {
    it("a pointer's id is worked out from its parent and target, and it is stamped by that id", async () => {
      const [parent, target] = [await note(), await note()];
      const made = await ok("POST", "/api/pointers", { target_id: target, parent_id: parent });
      const derived = (await q<{ id: string }>(`SELECT derive_row_id('note_pointer', $1, $2)::text AS id`, [parent, target])).rows[0]!.id;
      expect(made.id).toBe(derived);
      expect((await stampsOf("note_pointers", derived)).get("*")).toMatchObject({ deleted: false, author: owner.id, device: DEVICE });
      await ok("DELETE", `/api/pointers/${derived}`);
      expect((await stampsOf("note_pointers", derived)).get("*")).toMatchObject({ deleted: true });
      // the same pin made again is the same pointer
      expect((await ok("POST", "/api/pointers", { target_id: target, parent_id: parent })).id).toBe(derived);
      expect((await stampsOf("note_pointers", derived)).get("*")).toMatchObject({ deleted: false });
    });

    // Before migration 194 a second top-level pin of one note was allowed (the table's unique index ignores a NULL parent);
    // the derived id is the primary key, so now it is refused like a second pin under a parent.
    it("pinning the same note a second time at the top level is refused as already pinned", async () => {
      const target = await note();
      await ok("POST", "/api/pointers", { target_id: target, parent_id: null });
      const again = await call("POST", "/api/pointers", { target_id: target, parent_id: null });
      expect(again.status).toBe(409);
      expect(again.json.error).toBe("pointer already exists at this location");
      expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM note_pointers WHERE target_id = $1`, [target])).rows[0]!.n).toBe(1);
    });

    it("the sort position and the label are stamped on their own", async () => {
      const [parent, target] = [await note(), await note()];
      const { id } = await ok("POST", "/api/pointers", { target_id: target, parent_id: parent });
      const created = (await stampsOf("note_pointers", id)).get("*")!;
      await stamped(() => q(`UPDATE note_pointers SET sort_order = 5 WHERE id = $1`, [id]));
      await stamped(() => q(`UPDATE note_pointers SET display_prefix = 'x', created_at = now() WHERE id = $1`, [id]));
      const after = await stampsOf("note_pointers", id);
      expect([...after.keys()].sort()).toEqual(["*", "prefix", "sort"]);
      expect(after.get("*")).toEqual(created);
    });
  });

  describe("board cards", () => {
    it("a card is stamped whole when it is placed, then position, look and sub-board each on their own", async () => {
      const board = await canvas();
      const card = await note();
      const key = `${card}/${board}`;
      await placeCards(board, [{ nodeId: card, x: 10, y: 20 }]);
      const created = (await stampsOf("node_positions", key)).get("*")!;
      expect(created).toMatchObject({ deleted: false, author: owner.id, device: DEVICE });

      await placeCards(board, [{ nodeId: card, x: 30, y: 40 }]);
      const moved = await stampsOf("node_positions", key);
      expect([...moved.keys()].sort()).toEqual(["*", "position"]);
      const positionStamp = moved.get("position")!;

      await placeCards(board, [{ nodeId: card, x: 30, y: 40, color: "red" }]); // the position did not change
      const colored = await stampsOf("node_positions", key);
      expect(colored.get("position")).toEqual(positionStamp);
      expect(colored.get("look")!.seq).toBeGreaterThan(positionStamp.seq);

      await dropCards(board, [card]);
      expect([...(await stampsOf("node_positions", key)).entries()].map(([f, s]) => [f, s.deleted])).toEqual([["*", true]]);
    });

    it("the cards of one request share one stamp", async () => {
      const board = await canvas();
      const [a, b] = [await note(), await note()];
      await placeCards(board, [{ nodeId: a, x: 1, y: 1 }, { nodeId: b, x: 2, y: 2 }]);
      const [sa, sb] = [(await stampsOf("node_positions", `${a}/${board}`)).get("*")!, (await stampsOf("node_positions", `${b}/${board}`)).get("*")!];
      expect({ seq: sa.seq, origin: sa.origin, hlc_counter: sa.hlc_counter }).toEqual({ seq: sb.seq, origin: sb.origin, hlc_counter: sb.hlc_counter });
    });

    it("a run of moves of one card keeps its first old value and its last new value; a change by someone else or a removal does not merge", async () => {
      const board = await canvas();
      const card = await note();
      const key = `${card}/${board}`;
      const where = (log: LogRow[]) => log.map((r) => [r.old_value === null ? null : JSON.parse(r.old_value).x, r.new_value === null ? null : JSON.parse(r.new_value).x]);
      await placeCards(board, [{ nodeId: card, x: 1, y: 0 }]);
      await placeCards(board, [{ nodeId: card, x: 2, y: 0 }]);
      await placeCards(board, [{ nodeId: card, x: 3, y: 0 }]);
      await placeCards(board, [{ nodeId: card, x: 4, y: 0 }]);
      // the placement and the moves after it are one run: created at 1 ... ends at 4
      expect(where(await logOf("node_positions", key))).toEqual([[null, 4]]);
      await dropCards(board, [card]);
      await placeCards(board, [{ nodeId: card, x: 9, y: 0 }]);
      expect(where(await logOf("node_positions", key))).toEqual([[null, 4], [4, null], [null, 9]]);

      // another author's move is its own row
      const other = await persistActor(ws, { id: "s2-other", name: "S2 Other", role: "editor", type: "human" });
      await withEventTransaction(ws, async () => { await stampTransaction(ws, other.id); await q(`UPDATE node_positions SET x = 10 WHERE node_id = $1 AND surface = $2`, [card, board]); });
      expect(where(await logOf("node_positions", key)).at(-1)).toEqual([9, 10]);
      expect((await logOf("node_positions", key)).at(-1)!.author).toBe(other.id);
    });

    it("a move after the merge window starts a new row", async () => {
      const board = await canvas();
      const card = await note();
      const key = `${card}/${board}`;
      await placeCards(board, [{ nodeId: card, x: 1, y: 0 }]);
      await placeCards(board, [{ nodeId: card, x: 2, y: 0 }]);
      // the merge allowance is the one way to rewrite a row; a test uses it to age the row past the window
      await seedQ(`SELECT set_config('onden.structure_merge', 'on', true); UPDATE structure_log SET at = now() - interval '1 minute' WHERE table_name = 'node_positions' AND row_key = '${key}'`);
      await placeCards(board, [{ nodeId: card, x: 3, y: 0 }]);
      expect((await logOf("node_positions", key)).map((r) => [r.old_value === null ? null : JSON.parse(r.old_value).x, JSON.parse(r.new_value!).x])).toEqual([[null, 2], [2, 3]]);
    });

    it("the structure log is append-only apart from the merge", async () => {
      const board = await canvas();
      const card = await note();
      await placeCards(board, [{ nodeId: card, x: 1, y: 0 }]);
      await expect(seedQ(`UPDATE structure_log SET new_value = 'x' WHERE table_name = 'node_positions' AND row_key = $1`, [`${card}/${board}`])).rejects.toThrow(/append-only/);
      await expect(seedQ(`DELETE FROM structure_log WHERE table_name = 'node_positions' AND row_key = $1`, [`${card}/${board}`])).rejects.toThrow(/append-only/);
    });
  });

  // As S1's check, for every table this migration wires: attributes, tag applications (note and paragraph), hand-made edges,
  // pointers and board cards. The words are the stamps' own names, the installation's node id (every stamp carries it) and the
  // structure log's column names; each place that serves the data must carry the data (so the check is not vacuous) and none of them.
  it("stamps and the structure log appear in no response, no sync content, no bootstrap and no backup", async () => {
    const head = (await q<{ n: string }>(`SELECT COALESCE(max(id), 0)::text AS n FROM domain_events`)).rows[0]!.n;
    const [a, b] = [await note(), await note()];
    const t = await tag();
    const board = await canvas();
    const block = randomUUID();
    await seedQ(`INSERT INTO block_nodes (id, workspace_id, note_id, block_ref, kind) VALUES ($1, $2, $3, 'b1', 'paragraph')`, [block, ws, a]);
    await stamped(() => q(`INSERT INTO block_node_tags (block_node_id, tag_id, workspace_id) VALUES ($1, $2, $3)`, [block, t, ws]));
    await setAttr(a, "mood", "visible mood");
    await ok("PUT", `/api/nodes/${a}/tags/${t}`);
    const edge = await ok("POST", "/api/edges", { source_node_id: a, target_node_id: b, edge_type: "relates_to" });
    const pointer = await ok("POST", "/api/pointers", { target_id: b, parent_id: a });
    await placeCards(board, [{ nodeId: a, x: 5, y: 6 }]);
    await ok("PATCH", `/api/boards/${board}`, { sections: { upsert: [{ id: "frame-1", title: "frame", x: 0, y: 0, width: 50, height: 50 }] } });
    const origin = (await stampsOf("node_tags", `${a}/${t}`)).get("*")!.origin;
    expect(origin).toMatch(/\S/);
    const words = ["sync_stamps", "structure_log", "hlc_wall", "hlc_counter", "writes_without_mutate", "row_key", "onden.stamp", origin];
    const notClaimed = (label: string, text: string) => { for (const w of words) expect(text.includes(w), `${label} mentions ${w}`).toBe(false); };
    const claimed = (label: string, text: string, ...needles: string[]) => { for (const n of needles) expect(text.includes(n), `${label} no longer carries ${n}: the check would pass for nothing`).toBe(true); };

    const each: Array<[string, unknown, string[]]> = [
      ["edge write", edge, [b]],
      ["pointer write", pointer, [b]],
      ["node", await ok("GET", `/api/nodes/${a}`), [a]],
      ["node patch", await ok("PATCH", `/api/nodes/${a}`, { title: "visible title" }), ["visible title"]],
      ["attributes", await ok("GET", `/api/nodes/${a}/attributes`), ["visible mood"]],
      ["tags", await ok("GET", "/api/tags"), [t]],
      ["board", await ok("GET", `/api/boards/${board}`), [a]],
    ];
    for (const [label, body, needles] of each) { const text = JSON.stringify(body); claimed(label, text, ...needles); notClaimed(label, text); }

    // the whole bootstrap and the membership read carry the rows of every wired table and none of their stamps
    const boot = JSON.stringify(await ok("GET", "/api/bootstrap"));
    claimed("bootstrap", boot, a, b, t, "visible mood");
    claimed("bootstrap pointers", boot, pointer.id ?? b);
    notClaimed("bootstrap", boot);
    notClaimed("sync membership", JSON.stringify(await ok("GET", "/api/sync/membership")));

    const delta = await ok("GET", `/api/sync?since=${head}`);
    claimed("sync delta", JSON.stringify(delta), a, b, "visible mood");
    notClaimed("sync delta", JSON.stringify(delta));

    const res = await server.request("/api/backup/full.zip");
    expect(res.status).toBe(200);
    const zip = zipEntries(Buffer.from(await res.arrayBuffer()));
    expect([...zip.values()].some((data) => data.toString("utf8").includes("visible mood"))).toBe(true);
    for (const [name, data] of zip) notClaimed(`backup file ${name}`, data.toString("utf8"));
    // Long, not stuck: about 35 sequential committed writes (each takes the event lock and fsyncs), then the bootstrap, a sync read
    // and a full backup. ~0.5 s on PGlite; a 2-core runner's real Postgres took more than the default 5 s.
  }, 60_000);

  it("a write that skips mutate on these tables is stamped without an author and counted", async () => {
    const [a, b] = [await note(), await note()];
    const { countWritesWithoutStamp } = await import("../spine/stamps.js");
    const before = await countWritesWithoutStamp();
    await seedQ(`INSERT INTO node_positions (node_id, surface, x, y, workspace_id) VALUES ($1, 'graph', 1, 2, $2)`, [a, ws]);
    expect((await stampsOf("node_positions", `${a}/graph`)).get("*")).toMatchObject({ author: null, deleted: false });
    expect(await countWritesWithoutStamp()).toBe(before + 1);
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [b, await tag()]);
    expect(await countWritesWithoutStamp()).toBe(before + 2);
  });
});
