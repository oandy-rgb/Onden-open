// Migration 141: a whiteboard copy B whose only child is the note it copied (S)
// — the case 139 left alone — is folded too:
//   (a) S goes back to the top level in B's place, with a NODE_UPDATED event that
//       records the previous parent and position; then B is folded into S as 139
//       does it (cards, sections, tab; B in the trash);
//   (b) a copy with any other child is left alone;
//   (c) scripts/restoreFoldedBoards.sql undoes the fold and puts S back under B;
//   (d) it runs twice with the same result;
//   (e) an open device sees S move and B go with its next sync.
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
const MIGRATION = readFileSync(resolve(here, "../../db/migrations/141_fold_parented_board_copy.sql"), "utf8");
const RESTORE = readFileSync(resolve(here, "../../scripts/restoreFoldedBoards.sql"), "utf8");

const admin: ActorCtx = { id: "m141-admin", name: "Admin", role: "admin", type: "human" };

describe.skipIf(!isTestDatabase())("migration 141 — fold a whiteboard copy whose only child is the original (DB)", () => {
  const stamp = Date.now();
  let WS = "";
  let space = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    Object.assign(admin, await persistActor(WS, admin));
    space = await makeSpace(WS, `m141-${stamp}`, [{ id: admin.id, role: "manager" }]);
  });

  /** A top-level copy B (a converted board) with the original S as its only child and a card on it. */
  async function world(title = `1.Project ${stamp}-${randomUUID().slice(0, 6)}`) {
    const row: Record<string, string> = {};
    async function node(key: string, opts: { title?: string; markdown?: string; parent?: string; sort?: number } = {}) {
      row[key] = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id, sort_order)
         VALUES ($1, 'manual', 'content', $2, $3, $4, $5, $6) RETURNING id::text`,
        [WS, opts.title ?? `${key} ${randomUUID().slice(0, 6)}`, `m141-${randomUUID()}`, opts.markdown ?? "",
         opts.parent ? row[opts.parent] : null, opts.sort ?? 0])).rows[0]!.id;
      await putInSpace(row[key]!, space);
    }
    const place = (surface: string, card: string, x: number, y: number) =>
      q(`INSERT INTO node_positions (node_id, surface, x, y, width, height, workspace_id) VALUES ($1, $2, $3, $4, 200, 100, $5)`,
        [row[card], row[surface], x, y, WS]);
    await node("board", { title, sort: 7 });
    await node("orig", { title, markdown: "the real note\n", parent: "board", sort: 3 });
    await node("child", { markdown: "under the original", parent: "orig" });
    const view = { id: randomUUID(), node_id: row.board, name: "Canvas", layout: "canvas", filters: [], sorts: [], group_by: null, visible_fields: [], layout_config: { opens_first: true }, pin_order: 0 };
    await seedQ(`UPDATE content_nodes SET collection_views = $2::jsonb WHERE id = $1`, [row.board, JSON.stringify([view])]);
    await q(`INSERT INTO canvas_note_conversions (node_id, workspace_id, added_view_id) VALUES ($1, $2, $3)`, [row.board, WS, view.id]);
    await place("board", "orig", 0, 0);
    await place("board", "child", 40, 50);

    const noteRow = async (key: string) => (await q<{ parent_id: string | null; sort_order: number; deleted: boolean; markdown: string }>(
      `SELECT parent_id::text, sort_order, deleted_at IS NOT NULL AS deleted, markdown FROM content_nodes WHERE id = $1`, [row[key]])).rows[0]!;
    const cards = async (key: string) => (await q<{ node_id: string; x: number; y: number }>(
      `SELECT node_id::text, x, y FROM node_positions WHERE surface = $1 ORDER BY node_id`, [row[key]])).rows;
    return {
      row, node, noteRow, cards,
      migrate: async () => {
        const only = MIGRATION.replaceAll(`WHERE c.restored_at IS NULL`, `WHERE c.restored_at IS NULL AND c.node_id = '${row.board}'`);
        expect(only).not.toBe(MIGRATION);
        await seedQ(only);
      },
      restore: async () => {
        const marker = `WHERE restored_at IS NULL ORDER BY`;
        const first = RESTORE.indexOf(marker);
        const second = RESTORE.indexOf(marker, first + marker.length);
        expect(first).toBeGreaterThan(-1);
        expect(second).toBeGreaterThan(first);
        const only = RESTORE.slice(0, first) + `WHERE restored_at IS NULL AND node_id = '${row.board}' ORDER BY`
          + RESTORE.slice(first + marker.length, second) + `WHERE restored_at IS NULL AND node_id = '${row.orig}' ORDER BY`
          + RESTORE.slice(second + marker.length);
        await seedQ(only);
      },
      snapshot: async () => ({
        board: await noteRow("board"), orig: await noteRow("orig"),
        boardCards: await cards("board"), origCards: await cards("orig"),
      }),
    };
  }
  const maxEventId = async () => Number((await q<{ m: string }>(`SELECT COALESCE(max(id),0)::text AS m FROM domain_events`)).rows[0]!.m);

  it("(a) the original goes back to the top level in the copy's place; the copy is folded into it", async () => {
    const w = await world();
    await w.migrate();

    const orig = await w.noteRow("orig");
    expect(orig).toMatchObject({ parent_id: null, sort_order: 7, deleted: false, markdown: "the real note\n" });
    expect((await w.noteRow("child")).parent_id).toBe(w.row.orig);
    expect((await w.noteRow("board")).deleted).toBe(true);
    expect(await w.cards("board")).toEqual([]);
    expect(await w.cards("orig")).toEqual([{ node_id: w.row.child, x: 40, y: 50 }]);

    const move = (await q<{ event_type: string; payload: Record<string, unknown>; tx_meta: Record<string, unknown> }>(
      `SELECT e.event_type, e.payload, e.tx_meta FROM board_copy_unparents u JOIN domain_events e ON e.id = u.event_id WHERE u.node_id = $1`,
      [w.row.orig])).rows[0]!;
    expect(move.event_type).toBe("NODE_UPDATED");
    expect(move.payload).toMatchObject({ parent_id: null, sort_order: 7 });
    expect(move.tx_meta.prev_field_values).toEqual({ parent_id: w.row.board, sort_order: 3 });
    expect((await q(`SELECT 1 FROM board_copy_folds WHERE node_id = $1 AND folded_into = $2`, [w.row.board, w.row.orig])).rowCount).toBe(1);
  });

  it("(b) a copy with another child is left alone", async () => {
    const w = await world();
    await w.node("other", { parent: "board" });
    const before = await w.snapshot();
    const events = await maxEventId();
    await w.migrate();
    expect(await w.snapshot()).toEqual(before);
    expect(await maxEventId()).toBe(events);
  });

  it("(c) the restore script undoes the fold and puts the original back under the copy", async () => {
    const w = await world();
    const before = await w.snapshot();
    await w.migrate();
    await w.restore();
    expect(await w.snapshot()).toEqual(before);
    expect((await q(`SELECT restored_at FROM board_copy_unparents WHERE node_id = $1`, [w.row.orig])).rows[0]!.restored_at).not.toBeNull();
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

  it("(e) an open device sees the original move and the copy go with its next sync", async () => {
    const w = await world();
    const since = await maxEventId();
    await w.migrate();
    const delta = await buildSyncDelta(admin, WS, { since, known: [w.row.board, w.row.orig, w.row.child] });
    expect(delta.nodes.delete).toContain(w.row.board);
    const shipped = delta.nodes.upsert.find((n) => n.id === w.row.orig) as { parent_id?: string | null } | undefined;
    expect(shipped).toBeTruthy();
    expect(shipped!.parent_id ?? null).toBeNull();
  });
});
