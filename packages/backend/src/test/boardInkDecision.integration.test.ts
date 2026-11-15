// Migration 179: migration 172's ambiguous notes that have text are boards.
//   (a) `ink_data` goes, `board_ink` stays, and the record reads as a move;
//   (b) strokes drawn on the content tab since 172 are added to `board_ink`, with their erasures;
//   (c) strokes drawn on the board since 172 stay;
//   (d) a note with no text, a page with text boxes or pictures, and a move 172 already
//       made are left as they are; an empty text-box layer does not count;
//   (e) note text, note updated_at and events do not change; a second run changes nothing;
//   (f) scripts/restoreBoardInk.sql puts a decided note's drawing back in `ink_data`.
// Each test seeds its own notes and runs the SQL on those ids only.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getWorkspaceId } from "../db.js";
import { seedQ } from "./helpers/seedQ.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(resolve(here, path), "utf8");
const COPY = read("../../db/migrations/172_board_ink_attribute.sql");
const DECIDE = read("../../db/migrations/179_decide_ambiguous_board_ink.sql");
const RESTORE = read("../../scripts/restoreBoardInk.sql");

const stroke = (id: string, x = 5, y = 5) => ({ id, points: [[x, y, 0.5], [x + 10, y + 10, 0.5]], color: "#000", size: 4, toolId: "pen" });
const page = (strokes: unknown[], erased: Record<string, unknown> = {}) => JSON.stringify({ version: 1, strokes, erased, page: { width: 1000 } });
const BOARD_VIEW = [{ id: "v1", name: "Canvas", layout: "canvas", layout_config: {} }];
const FULL = page([stroke("a"), stroke("b", 50, 50)]);

describe.skipIf(!isTestDatabase())("migration 179 — decide ambiguous board ink (DB)", () => {
  let WS = "";
  beforeAll(async () => {
    await seedQ(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
  });

  async function world() {
    const row: Record<string, string> = {};
    const attr = (key: string, name: string, value: string) =>
      seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source, updated_at) VALUES ($1, $2, $3, $4, 'text', 'ui', now() - interval '3 days')`,
        [WS, row[key], name, value]);
    async function note(key: string, markdown: string, extra: Array<[string, string]> = []) {
      row[key] = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, collection_views)
         VALUES ($1, 'manual', 'content', $2, $3, $4, $5::jsonb) RETURNING id::text`,
        [WS, `${key} m179`, `m179-${randomUUID()}`, markdown, JSON.stringify(BOARD_VIEW)])).rows[0]!.id;
      await attr(key, "ink_data", FULL);
      for (const [name, value] of extra) await attr(key, name, value);
    }
    await note("untouched", "text");
    await note("drawnOnContent", "text");
    await note("drawnOnBoard", "text");
    await note("noText", "   ");
    await note("textBoxes", "text", [["page_text", JSON.stringify({ v: 1, pages: { page: { boxes: [{ id: "t", text: "hi" }] } } })]]);
    await note("pictures", "text", [["page_images", JSON.stringify({ v: 1, pages: { page: { images: [{ id: "i", src: "/api/media/x" }] } } })]]);
    await note("emptyBoxes", "text", [["page_text", JSON.stringify({ v: 1, pages: { page: { boxes: [] } } })]]);
    // 172 moves this one for certain: strokes off the page.
    await note("offPage", "text");
    await seedQ(`UPDATE node_attributes SET value = $2 WHERE node_id = $1 AND key = 'ink_data'`, [row.offPage, page([stroke("a", -400, 2500)])]);

    const ids = Object.values(row);
    const scoped = (sql: string, from: string, column: string) => {
      const out = sql.replace(from, `${from} AND ${column} = ANY('{${ids.join(",")}}'::uuid[])`);
      expect(out).not.toBe(sql);
      return out;
    };
    await seedQ(scoped(COPY, `WHERE a.key = 'ink_data'`, "a.node_id"));

    const value = async (key: string, name: string) => (await seedQ<{ value: string }>(
      `SELECT value FROM node_attributes WHERE node_id = $1 AND key = $2`, [row[key], name])).rows[0]?.value ?? null;
    const record = async (key: string) => (await seedQ<Record<string, any>>(
      `SELECT action, reason, decision, decided_at, moved_at, restored_at FROM board_ink_moves WHERE node_id = $1`, [row[key]])).rows[0]!;
    const snapshot = async () => ({
      attrs: (await seedQ(`SELECT id::text, key, value, updated_at FROM node_attributes WHERE node_id = ANY($1::uuid[]) ORDER BY id`, [ids])).rows,
      moves: (await seedQ(`SELECT * FROM board_ink_moves WHERE node_id = ANY($1::uuid[]) ORDER BY node_id`, [ids])).rows,
    });
    const notes = async () => (await seedQ(`SELECT id::text, markdown, updated_at FROM content_nodes WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids])).rows;
    const maxEvent = async () => (await seedQ<{ m: string }>(`SELECT COALESCE(max(id), 0)::text AS m FROM domain_events`)).rows[0]!.m;
    return {
      row, value, record, snapshot, notes, maxEvent,
      setValue: (key: string, name: string, next: string) =>
        seedQ(`UPDATE node_attributes SET value = $3 WHERE node_id = $1 AND key = $2`, [row[key], name, next]),
      decide: () => seedQ(scoped(DECIDE, `WHERE m.action = 'copied' AND m.decision IS NULL`, "m.node_id")),
      restore: () => seedQ(scoped(RESTORE, `WHERE m.restored_at IS NULL`, "m.node_id")),
    };
  }

  it("removes ink_data from a note with text, keeps the drawing in board_ink and records the move", async () => {
    const w = await world();
    const board = await w.value("untouched", "board_ink");
    const before = await w.record("untouched");
    await w.decide();

    expect(await w.value("untouched", "ink_data")).toBeNull();
    expect(await w.value("untouched", "board_ink")).toBe(board);
    const after = await w.record("untouched");
    expect(after).toMatchObject({ action: "moved", reason: "ambiguous", decision: "board", restored_at: null });
    expect(after.decided_at).not.toBeNull();
    expect(after.moved_at.getTime()).toBeGreaterThanOrEqual(before.moved_at.getTime());
  });

  it("adds what was drawn on the content tab since 172 to board_ink, and keeps what was drawn on the board", async () => {
    const w = await world();
    await w.setValue("drawnOnContent", "ink_data", page([stroke("a"), stroke("b", 50, 50), stroke("c", 90, 90)], { c: [[0, 0]], a: [[1, 1]] }));
    await w.setValue("drawnOnBoard", "board_ink", page([stroke("a"), stroke("b", 50, 50), stroke("z", 70, 70)]));
    await w.decide();

    const joined = JSON.parse((await w.value("drawnOnContent", "board_ink"))!);
    expect(joined.strokes.map((s: { id: string }) => s.id)).toEqual(["a", "b", "c"]);
    expect(joined.erased).toEqual({ c: [[0, 0]] });
    expect(joined.page).toEqual({ width: 1000 });
    expect(await w.value("drawnOnContent", "ink_data")).toBeNull();

    expect(JSON.parse((await w.value("drawnOnBoard", "board_ink"))!).strokes.map((s: { id: string }) => s.id)).toEqual(["a", "b", "z"]);
    expect(await w.value("drawnOnBoard", "ink_data")).toBeNull();
  });

  it("leaves a note with no text, a page with text boxes or pictures, and 172's own moves", async () => {
    const w = await world();
    const moved = await w.record("offPage");
    await w.decide();

    for (const key of ["noText", "textBoxes", "pictures"]) {
      expect(await w.value(key, "ink_data")).toBe(FULL);
      expect(await w.record(key)).toMatchObject({ action: "copied", decision: null, decided_at: null });
    }
    expect(await w.record("offPage")).toEqual(moved);
    expect(await w.value("emptyBoxes", "ink_data")).toBeNull();
  });

  it("changes no note and no event, and a second run changes nothing", async () => {
    const w = await world();
    const notes = await w.notes();
    const events = await w.maxEvent();
    await w.decide();
    const once = await w.snapshot();
    await w.decide();

    expect(await w.snapshot()).toEqual(once);
    expect(await w.notes()).toEqual(notes);
    expect(await w.maxEvent()).toBe(events);
  });

  it("undoing 172 puts a decided note's drawing back in ink_data instead of deleting it", async () => {
    const w = await world();
    await w.decide();
    const board = await w.value("untouched", "board_ink");
    await w.restore();

    expect(await w.value("untouched", "ink_data")).toBe(board);
    expect(await w.value("untouched", "board_ink")).toBeNull();
    expect((await w.record("untouched")).restored_at).not.toBeNull();
  });
});
