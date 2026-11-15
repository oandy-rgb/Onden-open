// Migration 139: the whiteboard copies "make a board from the sub-notes" left
// (migration 138 turned them into plain notes) are folded back into the note
// they copied:
//   (a) a copy is folded: its cards move to the original's board with their
//       position, colour and fold; the original's own card on it is dropped; the
//       sections move; the original gets a whiteboard tab that does not open
//       first; the copy is in the trash, restorable, and its text is untouched;
//   (b) a card the original already had keeps the original's;
//   (c) anything not certainly a copy is left alone: two same-title notes besides
//       the board, a board with text, a child, a tag, another attribute, a link,
//       a note that is not a card of the board, a board that was not converted;
//   (d) it runs twice with the same result;
//   (e) scripts/restoreFoldedBoards.sql puts everything back as it was, once;
//   (f) a device that is open sees the delete, the tab and the board with its next
//       sync (a sync delta), including one that holds the copy as node_type 'canvas'.
// Each test seeds its own notes and runs the migration / the restore on those ids
// only: the shared database may hold other files' rows.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { q, getWorkspaceId } from "../db.js";
import { buildSyncDelta } from "../services/sync/index.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(resolve(here, "../../db/migrations/139_fold_board_copies.sql"), "utf8");
const RESTORE = readFileSync(resolve(here, "../../scripts/restoreFoldedBoards.sql"), "utf8");

const admin: ActorCtx = { id: "m139-admin", name: "Admin", role: "admin", type: "human" };

describe.skipIf(!isTestDatabase())("migration 139 — fold whiteboard copies into the note (DB)", () => {
  const stamp = Date.now();
  let WS = "";
  let space = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    Object.assign(admin, await persistActor(WS, admin));
    space = await makeSpace(WS, `m139-${stamp}`, [{ id: admin.id, role: "manager" }]);
  });

  /** One copy B (a converted board) with the original S on it, plus cards and sections. */
  async function world(title = `_Inbox ${stamp}-${randomUUID().slice(0, 6)}`) {
    const row: Record<string, string> = {};
    async function node(key: string, opts: { title?: string; markdown?: string; parent?: string } = {}) {
      row[key] = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id)
         VALUES ($1, 'manual', 'content', $2, $3, $4, $5) RETURNING id::text`,
        [WS, opts.title ?? `${key} ${randomUUID().slice(0, 6)}`, `m139-${randomUUID()}`, opts.markdown ?? "", opts.parent ? row[opts.parent] : null])).rows[0]!.id;
      await putInSpace(row[key]!, space);
    }
    const place = (surface: string, card: string, x: number, y: number, color: string | null = null) =>
      q(`INSERT INTO node_positions (node_id, surface, x, y, width, height, color, folded, workspace_id) VALUES ($1, $2, $3, $4, 200, 100, $5, $6, $7)`,
        [row[card], row[surface], x, y, color, color === "red", WS]);
    await node("board", { title });
    await node("orig", { title, markdown: "the real note\n" });
    await node("cardA", { markdown: "A" });
    await node("cardB", { markdown: "B" });
    const view = { id: randomUUID(), node_id: row.board, name: "Canvas", layout: "canvas", filters: [], sorts: [], group_by: null, visible_fields: [], layout_config: { opens_first: true }, pin_order: 0 };
    await seedQ(`UPDATE content_nodes SET collection_views = $2::jsonb WHERE id = $1`, [row.board, JSON.stringify([view])]);
    await q(`INSERT INTO canvas_note_conversions (node_id, workspace_id, added_view_id) VALUES ($1, $2, $3)`, [row.board, WS, view.id]);
    await place("board", "orig", 0, 0);
    await place("board", "cardA", 10, 20);
    await place("board", "cardB", 300, 40, "red");
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, '_canvas_sections', $3, 'text', 'ui')`,
      [WS, row.board, JSON.stringify([{ id: "s1", title: "Todo", x: 0, y: 0, width: 400, height: 300 }])]);

    const ids = () => `{${row.board},${row.orig}}`;
    const noteRow = async (key: string) => (await q<Record<string, unknown>>(
      `SELECT id::text, node_type, title, slug, markdown, parent_id::text, hidden, sort_order, deleted_at IS NOT NULL AS deleted, deleted_by_event_id, collection_views
         FROM content_nodes WHERE id = $1`, [row[key]])).rows[0]!;
    const cards = async (key: string) => (await q<{ node_id: string; x: number; y: number; color: string | null; folded: boolean }>(
      `SELECT node_id::text, x, y, color, folded FROM node_positions WHERE surface = $1 ORDER BY node_id`, [row[key]])).rows;
    const sections = async (key: string) => (await q<{ value: string }>(
      `SELECT value FROM node_attributes WHERE node_id = $1 AND key = '_canvas_sections'`, [row[key]])).rows.map((r) => r.value);
    return {
      row, node, place, noteRow, cards, sections,
      migrate: async () => {
        const only = MIGRATION.replace(`WHERE c.restored_at IS NULL`, `WHERE c.restored_at IS NULL AND c.node_id = '${row.board}'`);
        expect(only).not.toBe(MIGRATION);
        await seedQ(only);
      },
      restore: async () => {
        const only = RESTORE.replace(`WHERE restored_at IS NULL ORDER BY`, `WHERE restored_at IS NULL AND node_id = '${row.board}' ORDER BY`);
        expect(only).not.toBe(RESTORE);
        await seedQ(only);
      },
      folded: async () => (await q(`SELECT 1 FROM board_copy_folds WHERE node_id = $1`, [row.board])).rowCount === 1,
      snapshot: async () => ({
        board: await noteRow("board"), orig: await noteRow("orig"),
        boardCards: await cards("board"), origCards: await cards("orig"),
        boardSections: await sections("board"), origSections: await sections("orig"),
        ids: ids(),
      }),
    };
  }
  const maxEventId = async () => Number((await q<{ m: string }>(`SELECT COALESCE(max(id),0)::text AS m FROM domain_events`)).rows[0]!.m);

  it("(a) a copy is folded: cards, sections and tab move to the original; the copy is in the trash", async () => {
    const w = await world();
    await w.migrate();

    expect(await w.folded()).toBe(true);
    expect(await w.cards("board")).toEqual([]);
    expect(await w.cards("orig")).toEqual([
      { node_id: w.row.cardA, x: 10, y: 20, color: null, folded: false },
      { node_id: w.row.cardB, x: 300, y: 40, color: "red", folded: true },
    ].sort((l, r) => (l.node_id! < r.node_id! ? -1 : 1)));
    expect(await w.sections("board")).toEqual([]);
    expect((await w.sections("orig"))[0]).toContain("Todo");

    const orig = await w.noteRow("orig");
    expect(orig.markdown).toBe("the real note\n");
    expect(orig.deleted).toBe(false);
    expect(orig.collection_views).toMatchObject([{ layout: "canvas", name: "Canvas", node_id: w.row.orig }]);
    expect((orig.collection_views as Array<{ layout_config: Record<string, unknown> }>)[0]!.layout_config.opens_first).toBeUndefined();

    const board = await w.noteRow("board");
    expect(board.deleted).toBe(true);
    expect(board.markdown).toBe("");
    const event = (await q<{ event_type: string; target_id: string }>(`SELECT event_type, target_id FROM domain_events WHERE id = $1`, [board.deleted_by_event_id])).rows[0]!;
    expect(event).toEqual({ event_type: "NODE_DELETED", target_id: w.row.board });
  });

  it("(b) a card the original already has keeps the original's; an existing hidden tab is kept and shown", async () => {
    const w = await world();
    await w.place("orig", "cardA", 999, 888, "blue");
    const view = { id: randomUUID(), node_id: w.row.orig, name: "My map", layout: "canvas", filters: [], sorts: [], group_by: null, visible_fields: [], layout_config: { hidden: true }, pin_order: 0 };
    await seedQ(`UPDATE content_nodes SET collection_views = $2::jsonb WHERE id = $1`, [w.row.orig, JSON.stringify([view])]);
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, '_canvas_sections', 'mine', 'text', 'ui')`, [WS, w.row.orig]);
    await w.migrate();

    const cards = await w.cards("orig");
    expect(cards.find((c) => c.node_id === w.row.cardA)).toMatchObject({ x: 999, y: 888, color: "blue" });
    expect(cards.find((c) => c.node_id === w.row.cardB)).toMatchObject({ x: 300, y: 40 });
    expect(await w.cards("board")).toEqual([]);
    expect(await w.sections("orig")).toEqual(["mine"]);
    const views = (await w.noteRow("orig")).collection_views as Array<{ id: string; name: string; layout_config: Record<string, unknown> }>;
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ id: view.id, name: "My map" });
    expect(views[0]!.layout_config.hidden).toBeUndefined();
  });

  describe("(c) anything not certainly a copy stays as it is", () => {
    const untouched = async (w: Awaited<ReturnType<typeof world>>, change: () => Promise<void>) => {
      await change();
      const before = await w.snapshot();
      await w.migrate();
      expect(await w.folded()).toBe(false);
      expect(await w.snapshot()).toEqual(before);
    };
    it("a second note with the same title", async () => {
      const w = await world();
      await untouched(w, async () => { await w.node("twin", { title: String((await w.noteRow("orig")).title) }); });
    });
    it("a board with text", async () => {
      const w = await world();
      await untouched(w, () => seedQ(`UPDATE content_nodes SET markdown = 'notes' WHERE id = $1`, [w.row.board]).then(() => undefined));
    });
    it("a board with a child note", async () => {
      const w = await world();
      await untouched(w, async () => { await w.node("kid", { parent: "board" }); });
    });
    it("a board with a tag", async () => {
      const w = await world();
      await untouched(w, async () => {
        await w.node("tag");
        await seedQ(`UPDATE content_nodes SET node_type = 'class_tag' WHERE id = $1`, [w.row.tag]);
        await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [w.row.board, w.row.tag]);
      });
    });
    it("a board with an attribute besides its sections", async () => {
      const w = await world();
      await untouched(w, () => seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, 'status', 'x', 'text', 'ui')`, [WS, w.row.board]).then(() => undefined));
    });
    it("a board that is linked", async () => {
      const w = await world();
      await untouched(w, () => seedQ(`INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, origin) VALUES ($1, $2, $3, 'related', 'active', 'manual')`, [WS, w.row.cardA, w.row.board]).then(() => undefined));
    });
    it("a board that is a card elsewhere or is opened as a sub-board", async () => {
      const w = await world();
      await untouched(w, async () => { await w.node("other"); await w.place("other", "board", 0, 0); });
      const v = await world();
      await untouched(v, () => q(`UPDATE node_positions SET sub_canvas_id = $1 WHERE node_id = $2`, [v.row.board, v.row.cardA]).then(() => undefined));
    });
    it("a same-titled note that is not a card of the board", async () => {
      const w = await world();
      await untouched(w, () => q(`DELETE FROM node_positions WHERE node_id = $1 AND surface = $2`, [w.row.orig, w.row.board]).then(() => undefined));
    });
    it("a board that was never converted, or a trashed original", async () => {
      const w = await world();
      await untouched(w, () => q(`DELETE FROM canvas_note_conversions WHERE node_id = $1`, [w.row.board]).then(() => undefined));
      const v = await world();
      await untouched(v, () => seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [v.row.orig]).then(() => undefined));
    });
  });

  it("(d) a second run changes nothing", async () => {
    const w = await world();
    await w.migrate();
    const once = await w.snapshot();
    const events = await maxEventId();
    await w.migrate();
    expect(await w.snapshot()).toEqual(once);
    expect(await maxEventId()).toBe(events);
  });

  it("(e) the restore script puts the copy, cards, sections and tab back as they were, once", async () => {
    const w = await world();
    const before = await w.snapshot();
    await w.migrate();
    expect((await w.snapshot()).boardCards).toEqual([]);
    await w.restore();
    const after = await w.snapshot();
    expect({ ...after, board: { ...after.board, deleted_by_event_id: null }, orig: { ...after.orig } })
      .toEqual({ ...before, board: { ...before.board, deleted_by_event_id: null } });
    expect((await q(`SELECT restored_at FROM board_copy_folds WHERE node_id = $1`, [w.row.board])).rows[0]!.restored_at).not.toBeNull();
    // Once only: a later edit survives a second run.
    await w.place("board", "cardA", 1, 1).catch(() => undefined);
    await q(`UPDATE node_positions SET x = 77 WHERE node_id = $1 AND surface = $2`, [w.row.cardA, w.row.board]);
    await w.restore();
    expect((await w.cards("board")).find((c) => c.node_id === w.row.cardA)!.x).toBe(77);
  });

  it("(e2) the restore keeps what was done since: cards placed on the original's board and its other tabs", async () => {
    const w = await world();
    await w.migrate();
    await w.node("late");
    await w.place("orig", "late", 5, 5);
    const table = { id: randomUUID(), node_id: w.row.orig, name: "Rows", layout: "table", filters: [], sorts: [], group_by: null, visible_fields: [], layout_config: {}, pin_order: 1 };
    await seedQ(`UPDATE content_nodes SET collection_views = collection_views || $2::jsonb WHERE id = $1`, [w.row.orig, JSON.stringify([table])]);
    await w.restore();
    expect((await w.cards("orig")).map((c) => c.node_id)).toEqual([w.row.late]);
    expect(((await w.noteRow("orig")).collection_views as Array<{ layout: string }>).map((v) => v.layout)).toEqual(["table"]);
  });

  it("(f) an open device sees the copy go and the original's tab and board with its next sync", async () => {
    const w = await world();
    const since = await maxEventId();
    // The device holds the copy (as a board node) and the original's old membership.
    await w.migrate();
    const delta = await buildSyncDelta(admin, WS, { since, known: [w.row.board, w.row.orig, w.row.cardA] });
    expect(delta.nodes.delete).toContain(w.row.board);
    const shippedOrig = delta.nodes.upsert.find((n) => n.id === w.row.orig);
    expect(shippedOrig).toBeTruthy();
    expect(JSON.stringify(shippedOrig)).toContain("canvas");
    const pairs = (delta.canvas_memberships?.upsert ?? []).map((m) => `${m.canvas_id}|${m.node_id}`);
    expect(delta.canvas_memberships?.replace_for).toContain(w.row.orig);
    expect(pairs).toContain(`${w.row.orig}|${w.row.cardA}`);
    expect(pairs).toContain(`${w.row.orig}|${w.row.cardB}`);
    expect(pairs).not.toContain(`${w.row.board}|${w.row.cardA}`);
    expect(pairs).not.toContain(`${w.row.orig}|${w.row.orig}`);
  });
});
