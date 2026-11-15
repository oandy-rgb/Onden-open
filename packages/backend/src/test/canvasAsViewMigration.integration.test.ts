// Migration 138: the whiteboard is a view of a note, not a kind of note. A
// workspace with boards of node_type 'canvas' goes on as it was, and the
// conversion can be undone:
//   (a) every board becomes a plain note — id, title, slug, text, parent, space,
//       tags, children, cards (position, colour, fold), sections, ink, links —
//       and has a whiteboard tab that it opens on; a trashed board too;
//   (b) a board that already had a (hidden, renamed) whiteboard tab keeps that
//       tab, shown and opening first; a note that was never a board is untouched;
//   (c) the cards are still on the board when read through the whiteboard tab
//       (/api/boards/:id) and through the routes clients from before 138 use
//       (/api/canvases: list, read, rename, delete, layout writes); an old
//       whole-document save is refused (410) and changes nothing;
//   (d) no event is written, changed or deleted; re-running changes nothing;
//   (e) scripts/restoreCanvasNotes.sql puts the boards back as they were,
//       keeping the views, cards and edits made since, and runs only once;
//   (f) a canvas made now (POST /api/canvases) is a plain note with the tab.
// Each test seeds its own boards (tests run in any order) and runs the
// migration / the restore on those ids only: the shared database may hold
// other files' rows.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { q, getWorkspaceId } from "../db.js";
import { apiOnError } from "../httpError.js";
import boardsRouter from "../routes/boards.js";
import canvasRouter from "../routes/canvases.js";
import { getCanvasMemberships } from "../services/canvasMemberships.js";
import { listNoteViews } from "../services/noteViews.js";
import { holderViewsSql } from "../services/functionRefSql.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";
import { moveViewsIntoRefs } from "./helpers/migration188.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(resolve(here, "../../db/migrations/138_canvas_is_a_view.sql"), "utf8");
const RESTORE = readFileSync(resolve(here, "../../scripts/restoreCanvasNotes.sql"), "utf8");

const admin: ActorCtx = { id: "m138-admin", name: "Admin", role: "admin", type: "human" };
let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/boards", boardsRouter);
app.route("/api/canvases", canvasRouter);
const json = { "content-type": "application/json" };

type View = { id: string; layout: string; name: string; layout_config: Record<string, unknown>; node_id?: string };

describe.skipIf(!isTestDatabase())("migration 138 — the whiteboard is a view of a note (DB)", () => {
  const stamp = Date.now();
  let WS = "";
  let space = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    Object.assign(admin, await persistActor(WS, admin));
    currentActor = admin;
    space = await makeSpace(WS, `m138-${stamp}`, [{ id: admin.id, role: "manager" }]);
  });

  /** A set of old-shape rows with ids of their own. */
  async function world() {
    const row: Record<string, string> = {};
    const tag = `${stamp}-${randomUUID().slice(0, 6)}`;
    async function node(key: string, opts: { type?: string; title?: string; parent?: string; markdown?: string; deleted?: boolean; views?: View[] } = {}) {
      row[key] = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id, deleted_at, collection_views)
         VALUES ($1, 'manual', $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING id::text`,
        [WS, opts.type ?? "content", opts.title ?? `${key} ${tag}`, opts.type === "canvas" ? `canvas-${randomUUID()}` : `m138-${randomUUID()}`, opts.markdown ?? "",
          opts.parent ? row[opts.parent] : null, opts.deleted ? new Date() : null,
          opts.views ? JSON.stringify(opts.views) : null])).rows[0]!.id;
      await putInSpace(row[key]!, space);
    }
    const place = (surface: string, card: string, x: number, y: number, color: string | null = null) =>
      q(`INSERT INTO node_positions (node_id, surface, x, y, width, height, color, folded, workspace_id) VALUES ($1, $2, $3, $4, 200, 100, $5, $6, $7)`,
        [row[card], row[surface], x, y, color, color === "red", WS]);

    // _Inbox: text, a tag, a child note, three cards (one coloured and folded, one with ink),
    // a section frame, a link between two cards.
    await node("inbox", { type: "canvas", title: `_Inbox ${tag}`, markdown: "inbox text\n" });
    await node("child", { parent: "inbox", markdown: "a sub-note\n" });
    await node("cardA", { markdown: "card A" });
    await node("cardB", { markdown: "card B" });
    await node("cardC", { markdown: "card C" });
    await node("tag", { type: "class_tag", title: `m138tag ${tag}` });
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [row.inbox, row.tag]);
    await place("inbox", "cardA", 10, 20);
    await place("inbox", "cardB", 300, 40, "red");
    await place("inbox", "cardC", -50, 600);
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, '_canvas_sections', $3, 'text', 'ui')`,
      [WS, row.inbox, JSON.stringify([{ id: "s1", title: "Todo", x: 0, y: 0, width: 400, height: 300 }])]);
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, 'ink_data', 'ink-strokes', 'text', 'ui')`, [WS, row.cardC]);
    await seedQ(`INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, origin) VALUES ($1, $2, $3, 'related', 'active', 'manual')`,
      [WS, row.cardA, row.cardB]);
    // 1.Project: under a note, with a card that is itself a board.
    await node("parent", { markdown: "parent" });
    await node("project", { type: "canvas", title: `1.Project ${tag}`, parent: "parent" });
    await place("project", "inbox", 0, 0);
    // A trashed board, and a board whose tab was renamed and hidden while it was still a board.
    await node("trashed", { type: "canvas", deleted: true });
    await place("trashed", "cardA", 5, 5);
    const hiddenTab: View = { id: randomUUID(), layout: "canvas", name: "My map", layout_config: { hidden: true } };
    const table: View = { id: randomUUID(), layout: "table", name: "Rows", layout_config: {} };
    await node("renamed", { type: "canvas", views: [table, hiddenTab] });
    await place("renamed", "cardB", 1, 1);
    // A note that was never a board, with a view of its own.
    await node("plain", { views: [table] });

    const boards = ["inbox", "project", "trashed", "renamed"].map((k) => row[k]!);
    const noteRow = async (key: string) => (await q<Record<string, unknown>>(
      `SELECT id::text, node_type, title, slug, markdown, parent_id::text, space_id::text, hidden, sort_order, deleted_at, created_at, updated_at, collection_views
         FROM content_nodes WHERE id = $1`, [row[key]])).rows[0]!;
    const before: Record<string, Record<string, unknown>> = {};
    for (const key of Object.keys(row)) before[key] = await noteRow(key);
    return {
      row, boards, before, noteRow,
      views: async (key: string) => (await noteRow(key)).collection_views as View[] | null,
      cards: async (key: string) => (await q<{ node_id: string; x: number; y: number; color: string | null; folded: boolean }>(
        `SELECT node_id::text, x, y, color, folded FROM node_positions WHERE surface = $1 ORDER BY node_id`, [row[key]])).rows,
      migrate: async () => {
        const only = MIGRATION.replace(`WHERE n.node_type = 'canvas'`, `WHERE n.node_type = 'canvas' AND n.id = ANY('{${boards.join(",")}}'::uuid[])`);
        expect(only).not.toBe(MIGRATION);
        await seedQ(only);
      },
      restore: async () => {
        const only = RESTORE.replace(`WHERE c.restored_at IS NULL`, `WHERE c.restored_at IS NULL AND c.node_id = ANY('{${boards.join(",")}}'::uuid[])`);
        expect(only).not.toBe(RESTORE);
        return (await seedQ<{ restored_id: string }>(only)).rows.map((r) => r.restored_id);
      },
    };
  }
  /** Every event's id and type: any write, change or delete shows. Other tests
   *  may append while this one runs, so compare what existed before. */
  const eventsUpTo = async (maxId: string) => (await q<{ id: string; event_type: string }>(
    `SELECT id::text AS id, event_type FROM domain_events WHERE id <= $1 ORDER BY domain_events.id`, [maxId])).rows;
  const maxEventId = async () => (await q<{ m: string }>(`SELECT COALESCE(max(id),0)::text AS m FROM domain_events`)).rows[0]!.m;
  const conversions = (ids: string[]) => q(`SELECT node_id::text, added_view_id, prev_view, prev_collection_views, converted_at FROM canvas_note_conversions WHERE node_id = ANY($1::uuid[]) ORDER BY node_id`, [ids]);

  it("(a) a board becomes a plain note with a whiteboard tab that opens first; nothing else about it changes", async () => {
    const w = await world();
    await w.migrate();
    for (const key of ["inbox", "project", "trashed"]) {
      const { node_type, collection_views, ...rest } = await w.noteRow(key);
      const { node_type: _was, collection_views: _views, ...unchanged } = w.before[key]!;
      expect(node_type, key).toBe("content");
      expect(rest, key).toEqual(unchanged);
      expect(collection_views, key).toMatchObject([{ layout: "canvas", name: "Canvas", node_id: w.row[key], layout_config: { opens_first: true } }]);
    }
    const inbox = await w.noteRow("inbox");
    expect(inbox.slug).toMatch(/^canvas-/);
    expect(inbox.markdown).toBe("inbox text\n");
    expect((await q(`SELECT tag_id::text FROM node_tags WHERE node_id = $1`, [w.row.inbox])).rows).toEqual([{ tag_id: w.row.tag }]);
    expect((await q(`SELECT id::text FROM content_nodes WHERE parent_id = $1`, [w.row.inbox])).rows).toEqual([{ id: w.row.child }]);
    expect((await q(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = '_canvas_sections'`, [w.row.inbox])).rows[0]!.value).toContain("Todo");
    expect((await q(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = 'ink_data'`, [w.row.cardC])).rows[0]!.value).toBe("ink-strokes");
    expect((await q(`SELECT 1 FROM node_edges WHERE source_node_id = $1 AND target_node_id = $2`, [w.row.cardA, w.row.cardB])).rowCount).toBe(1);
    expect(await w.cards("inbox")).toEqual([
      { node_id: w.row.cardA, x: 10, y: 20, color: null, folded: false },
      { node_id: w.row.cardB, x: 300, y: 40, color: "red", folded: true },
      { node_id: w.row.cardC, x: -50, y: 600, color: null, folded: false },
    ].sort((l, r) => (l.node_id! < r.node_id! ? -1 : 1)));
  });

  it("(b) an existing whiteboard tab is kept, shown and opens first; a note that was never a board is untouched", async () => {
    const w = await world();
    await w.migrate();
    const tabs = (await w.views("renamed"))!;
    expect(tabs.map((v) => v.layout)).toEqual(["table", "canvas"]);
    expect(tabs[1]).toMatchObject({ name: "My map", layout_config: { opens_first: true } });
    expect(tabs[1]!.layout_config).not.toHaveProperty("hidden");
    expect(tabs[0]!.name).toBe("Rows");
    expect(await w.noteRow("plain")).toEqual(w.before.plain);
  });

  it("(c) the whiteboard tab shows the same board — through /api/boards and the routes older clients use", async () => {
    const w = await world();
    await w.migrate();
    currentActor = admin;
    const read = await app.request(`/api/boards/${w.row.inbox}`);
    expect(read.status).toBe(200);
    const body = await read.json() as { kind: string; cards: Array<{ nodeId: string; x: number; y: number; color?: string; folded?: boolean }>; sections: Array<{ id: string }> };
    expect(body.kind).toBe("canvas");
    expect(body.cards.find((c) => c.nodeId === w.row.cardB)).toMatchObject({ x: 300, y: 40, color: "red", folded: true });
    expect(body.cards.map((c) => c.nodeId).sort()).toEqual([w.row.cardA, w.row.cardB, w.row.cardC].sort());
    expect(body.sections.map((s) => s.id)).toEqual(["s1"]);

    // The tab record is the note's own view (the page's tab row reads it) — once migration 188 moved it to function_refs.
    await moveViewsIntoRefs();
    expect(await listNoteViews(admin, WS, w.row.inbox!)).toMatchObject([{ layout: "canvas" }]);
    // "Appears on canvases": the cards still name the board.
    const memberships = await getCanvasMemberships(WS, [w.row.inbox!, w.row.cardA!, w.row.cardB!]);
    expect(memberships.map((m) => `${m.canvas_id}|${m.node_id}`).sort())
      .toEqual([`${w.row.inbox}|${w.row.cardA}`, `${w.row.inbox}|${w.row.cardB}`].sort());

    // Older clients: list, read, write.
    const list = await (await app.request("/api/canvases")).json() as Array<{ id: string; title: string }>;
    expect(list.map((c) => c.id)).toEqual(expect.arrayContaining([w.row.inbox, w.row.project, w.row.renamed]));
    expect(list.map((c) => c.id)).not.toContain(w.row.plain);
    expect(list.map((c) => c.id)).not.toContain(w.row.trashed);
    const old = await (await app.request(`/api/canvases/${w.row.inbox}`)).json() as { title: string; data: { nodes: Array<{ nodeId: string }>; sections?: unknown[] } };
    expect(old.title).toMatch(/^_Inbox /);
    expect(old.data.nodes.map((n) => n.nodeId).sort()).toEqual([w.row.cardA, w.row.cardB, w.row.cardC].sort());
    expect(old.data.sections).toHaveLength(1);
    expect((await app.request(`/api/canvases/${w.row.plain}`)).status).toBe(404);

    const move = await app.request(`/api/boards/${w.row.inbox}`, { method: "PATCH", headers: json,
      body: JSON.stringify({ cards: { upsert: [{ nodeId: w.row.cardA, x: 11, y: 22 }] } }) });
    expect(move.status).toBe(200);
    expect((await w.cards("inbox")).find((c) => c.node_id === w.row.cardA)).toMatchObject({ x: 11, y: 22 });
    const rename = await app.request(`/api/canvases/${w.row.inbox}`, { method: "PATCH", headers: json, body: JSON.stringify({ title: "_Inbox renamed" }) });
    expect(rename.status).toBe(200);
    expect((await w.noteRow("inbox")).title).toBe("_Inbox renamed");
    // An old whole-document save would replace every placement: refused, nothing changes.
    const whole = await app.request(`/api/canvases/${w.row.inbox}`, { method: "PATCH", headers: json, body: JSON.stringify({ data: { nodes: [] } }) });
    expect(whole.status).toBe(410);
    expect(await w.cards("inbox")).toHaveLength(3);
    expect((await w.noteRow("inbox")).node_type).toBe("content");
    // An old client's delete trashes the note like any note, tab and cards kept.
    expect((await app.request(`/api/canvases/${w.row.project}`, { method: "DELETE" })).status).toBe(200);
    expect((await w.noteRow("project")).deleted_at).not.toBeNull();
    expect(await w.views("project")).toMatchObject([{ layout: "canvas" }]);
  });

  it("(d) the migration writes, changes and deletes no event; running it again changes nothing", async () => {
    const w = await world();
    const upTo = await maxEventId();
    const eventsBefore = await eventsUpTo(upTo);
    await w.migrate();
    expect(await eventsUpTo(upTo)).toEqual(eventsBefore);
    expect(await maxEventId()).toBe(upTo);
    const recorded = await conversions(w.boards);
    expect(recorded.rows).toHaveLength(4);
    const viewsOf = () => Promise.all(w.boards.map(async (id) => (await q(`SELECT collection_views FROM content_nodes WHERE id = $1`, [id])).rows[0]));
    const viewsBefore = await viewsOf();
    await w.migrate();
    expect((await conversions(w.boards)).rows).toEqual(recorded.rows);
    expect(await viewsOf()).toEqual(viewsBefore);
  });

  it("(e) the restore script puts the boards back as they were and keeps what was added since", async () => {
    const w = await world();
    await w.migrate();
    // Edits after the conversion: a table view on _Inbox, a new card, a new text.
    const since: View = { id: randomUUID(), layout: "table", name: "Rows since", layout_config: {} };
    await seedQ(`UPDATE content_nodes SET collection_views = collection_views || $2::jsonb, markdown = 'edited since' WHERE id = $1`, [w.row.inbox, JSON.stringify([since])]);
    await q(`INSERT INTO node_positions (node_id, surface, x, y, workspace_id) VALUES ($1, $2, 7, 8, $3)`, [w.row.child, w.row.inbox, WS]);
    const upTo = await maxEventId();
    const eventsBefore = await eventsUpTo(upTo);

    expect((await w.restore()).sort()).toEqual([...w.boards].sort());
    expect(await eventsUpTo(upTo)).toEqual(eventsBefore);

    for (const key of ["project", "trashed"]) {
      const now = await w.noteRow(key);
      expect(now.node_type, key).toBe("canvas");
      expect(now.collection_views, key).toBeNull();
      const { node_type: _a, collection_views: _b, ...rest } = now;
      const { node_type: _c, collection_views: _d, ...was } = w.before[key]!;
      expect(rest, key).toEqual(was);
    }
    // _Inbox: the tab the migration added is gone; the view and the edit made since stay.
    const inbox = await w.noteRow("inbox");
    expect(inbox.node_type).toBe("canvas");
    expect((inbox.collection_views as View[]).map((v) => v.name)).toEqual(["Rows since"]);
    expect(inbox.markdown).toBe("edited since");
    expect((await w.cards("inbox")).map((c) => c.node_id)).toEqual(expect.arrayContaining([w.row.cardA, w.row.cardB, w.row.cardC, w.row.child]));
    // The board that already had its tab: the original (renamed, hidden) one is back.
    expect(await w.views("renamed")).toEqual(w.before.renamed!.collection_views);
    expect((await w.noteRow("renamed")).node_type).toBe("canvas");
    // Once only: a second run restores nothing.
    expect(await w.restore()).toEqual([]);
    // And the boards still read through the same routes.
    currentActor = admin;
    expect((await app.request(`/api/canvases/${w.row.inbox}`)).status).toBe(200);
    expect((await app.request(`/api/boards/${w.row.inbox}`)).status).toBe(200);
  });

  it("(e) a restored board can be converted again", async () => {
    const w = await world();
    await w.migrate();
    await w.restore();
    await q(`DELETE FROM canvas_note_conversions WHERE node_id = ANY($1::uuid[])`, [w.boards]);
    await w.migrate();
    for (const key of ["inbox", "project", "trashed", "renamed"]) expect((await w.noteRow(key)).node_type, key).toBe("content");
    expect((await w.views("inbox"))!.filter((v) => v.layout === "canvas")).toHaveLength(1);
  });

  it("(f) a canvas made now is a plain note with the whiteboard tab, written with the note", async () => {
    currentActor = admin;
    const w = await world();
    const id = randomUUID();
    const res = await app.request("/api/canvases", { method: "POST", headers: json, body: JSON.stringify({ id, title: `Fresh ${stamp}`, space_id: space }) });
    expect(res.status).toBe(201);
    const made = (await q<{ node_type: string; collection_views: View[] }>(`SELECT node_type, ${holderViewsSql("content_nodes")} AS collection_views FROM content_nodes WHERE id = $1`, [id])).rows[0]!;
    expect(made.node_type).toBe("content");
    expect(made.collection_views).toMatchObject([{ layout: "canvas", name: "Canvas", node_id: id, layout_config: { opens_first: true } }]);
    expect(await listNoteViews(admin, WS, id)).toMatchObject([{ layout: "canvas" }]);
    // Its board is its own id, and it is on the canvas list.
    const put = await app.request(`/api/boards/${id}`, { method: "PATCH", headers: json, body: JSON.stringify({ cards: { upsert: [{ nodeId: w.row.cardA, x: 3, y: 4 }] } }) });
    expect(put.status).toBe(200);
    expect(((await (await app.request(`/api/boards/${id}`)).json()) as { cards: unknown[] }).cards).toHaveLength(1);
    expect(((await (await app.request("/api/canvases")).json()) as Array<{ id: string }>).map((c) => c.id)).toContain(id);
  });
});
