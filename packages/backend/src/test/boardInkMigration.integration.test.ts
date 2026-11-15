// Migration 172: the whiteboard's pen layer is its own attribute (board_ink).
//   (a) a note that 138 turned from a board into a note: its ink_data is renamed to
//       board_ink (same row, value and updated_at) and recorded as 'moved';
//   (b) a note with a whiteboard tab that is not in that list is ambiguous: the page
//       is COPIED to board_ink, ink_data stays, and the evidence is recorded
//       (a note with text and strokes outside the page → 'board'; a page born with
//       the note → 'handwriting'; nothing to go on → 'unknown');
//   (c) a PDF's envelope, a note with a pdf_url, a note without a whiteboard tab, an
//       unreadable value, a page with no strokes and a note that already has board_ink
//       are not touched and not recorded;
//   (d) no updated_at and no event changes; a second run changes nothing;
//   (e) scripts/restoreBoardInk.sql puts every attribute back as it was, keeps a board
//       drawn on since, and runs only once.
// Each test seeds its own notes and runs the migration / restore on those ids only.
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
const MIGRATION = readFileSync(resolve(here, "../../db/migrations/172_board_ink_attribute.sql"), "utf8");
const RESTORE = readFileSync(resolve(here, "../../scripts/restoreBoardInk.sql"), "utf8");

const stroke = (id: string, x: number, y: number) => ({ id, points: [[x, y, 0.5], [x + 10, y + 10, 0.5]], color: "#000", size: 4, toolId: "pen" });
const page = (strokes: unknown[], width = 1000) => JSON.stringify({ version: 1, strokes, erased: {}, page: { width } });
const BOARD_VIEW = [{ id: "v1", name: "Canvas", layout: "canvas", layout_config: {} }];

describe.skipIf(!isTestDatabase())("migration 172 — board_ink (DB)", () => {
  let WS = "";
  beforeAll(async () => {
    await seedQ(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
  });

  async function world() {
    const row: Record<string, string> = {};
    async function node(key: string, opts: { markdown?: string; views?: boolean; ink?: string; extra?: Array<[string, string]> } = {}) {
      row[key] = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, collection_views)
         VALUES ($1, 'manual', 'content', $2, $3, $4, $5::jsonb) RETURNING id::text`,
        [WS, `${key} m172`, `m172-${randomUUID()}`, opts.markdown ?? "", opts.views === false ? null : JSON.stringify(BOARD_VIEW)])).rows[0]!.id;
      if (opts.ink !== undefined) await attr(key, "ink_data", opts.ink);
      for (const [k, v] of opts.extra ?? []) await attr(key, k, v);
    }
    const attr = (key: string, name: string, value: string) =>
      seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source, updated_at) VALUES ($1, $2, $3, $4, 'text', 'ui', now() - interval '3 days')`,
        [WS, row[key], name, value]);
    const event = async (key: string, type: string, payload: Record<string, unknown>, cause: string | null = null) =>
      (await seedQ<{ id: string }>(
        `INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, triggered_by_event_id)
         VALUES ($1, 'user', 'm172', $2, 'node', $3, $4::jsonb, $5) RETURNING id::text`,
        [WS, type, row[key], JSON.stringify(payload), cause])).rows[0]!.id;

    const full = page([stroke("a", 5, 5), stroke("b", 50, 50)]);
    await node("converted", { markdown: "text", ink: full });
    await seedQ(`INSERT INTO canvas_note_conversions (node_id, workspace_id) VALUES ($1, $2)`, [row.converted, WS]);
    // Off the page: strokes far outside the page — only a board holds those → moved.
    await node("offPage", { ink: page([stroke("a", -400, 2500)]) });
    await event("offPage", "ATTRIBUTE_SET", { key: "ink_data", value: page([stroke("a", -400, 2500)]) });
    // Off the page even though the first write came with the note's creation (production's _Inbox) → moved.
    await node("offPageBorn", { ink: page([stroke("a", 5000, 5)]) });
    const bornCreated = await event("offPageBorn", "NODE_CREATED", {});
    await event("offPageBorn", "ATTRIBUTE_SET", { key: "ink_data", value: page([]) }, bornCreated);
    // Ambiguous: a note with text whose first ink write came later, strokes on the page.
    await node("boardish", { markdown: "some text", ink: full });
    await event("boardish", "ATTRIBUTE_SET", { key: "ink_data", value: full });
    // Ambiguous: a handwritten note (its first ink write came with NODE_CREATED), then a board tab was added.
    await node("handwriting", { ink: full });
    const created = await event("handwriting", "NODE_CREATED", {});
    await event("handwriting", "ATTRIBUTE_SET", { key: "ink_data", value: page([]) }, created);
    // Ambiguous: nothing to go on.
    await node("unknown", { ink: full });
    // Not touched.
    await node("noTab", { views: false, ink: full });
    await node("pdfEnvelope", { ink: JSON.stringify({ version: 1, pages: { 1: JSON.parse(full) }, annotations: [] }) });
    await node("pdfUrl", { ink: full, extra: [["pdf_url", "/media/x.pdf"]] });
    await node("garbage", { ink: "not json {" });
    await node("emptyPage", { ink: page([]) });
    await node("hasBoardInk", { ink: full, extra: [["board_ink", page([stroke("z", 1, 1)])]] });

    const ids = Object.values(row);
    const attrs = async () => (await seedQ<Record<string, unknown>>(
      `SELECT id::text, node_id::text, key, value, updated_at FROM node_attributes WHERE node_id = ANY($1::uuid[]) ORDER BY node_id, key`, [ids])).rows;
    const notes = async () => (await seedQ<Record<string, unknown>>(
      `SELECT id::text, markdown, updated_at, collection_views FROM content_nodes WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids])).rows;
    const records = async () => (await seedQ<Record<string, any>>(
      `SELECT node_id::text, action, reason, suggested, signals, restored_at FROM board_ink_moves WHERE node_id = ANY($1::uuid[]) ORDER BY node_id`, [ids])).rows;
    const maxEvent = async () => (await seedQ<{ m: string }>(`SELECT COALESCE(max(id), 0)::text AS m FROM domain_events`)).rows[0]!.m;
    const only = (sql: string, from: string) => {
      const out = sql.replace(from, `${from} AND ${from.includes("a.key") ? "a.node_id" : "m.node_id"} = ANY('{${ids.join(",")}}'::uuid[])`);
      expect(out).not.toBe(sql);
      return out;
    };
    return {
      row, attrs, notes, records, maxEvent,
      migrate: () => seedQ(only(MIGRATION, `WHERE a.key = 'ink_data'`)),
      restore: async () => (await seedQ<{ restored_node_id: string; kept_reason: string | null }>(only(RESTORE, `WHERE m.restored_at IS NULL`))).rows,
    };
  }

  it("moves a converted board and boards drawn off the page, copies the ambiguous ones with their evidence, leaves everything else", async () => {
    const w = await world();
    const before = await w.attrs();
    const notesBefore = await w.notes();
    const eventsBefore = await w.maxEvent();
    await w.migrate();

    const after = await w.attrs();
    const byNode = (rows: Record<string, unknown>[], key: string) => rows.filter((r) => r.node_id === w.row[key]);
    // (a) renamed in place
    for (const key of ["converted", "offPage", "offPageBorn"]) {
      const moved = byNode(after, key);
      expect(moved.map((r) => r.key)).toEqual(["board_ink"]);
      expect(moved[0]).toEqual({ ...byNode(before, key)[0], key: "board_ink" });
    }
    // (b) copied: ink_data kept, board_ink the same value
    for (const key of ["boardish", "handwriting", "unknown"]) {
      const rows = byNode(after, key);
      expect(rows.map((r) => r.key).sort()).toEqual(["board_ink", "ink_data"]);
      expect(rows.find((r) => r.key === "board_ink")!.value).toBe(rows.find((r) => r.key === "ink_data")!.value);
      expect(byNode(before, key)).toEqual(rows.filter((r) => r.key === "ink_data"));
    }
    // (c) untouched
    for (const key of ["noTab", "pdfEnvelope", "pdfUrl", "garbage", "emptyPage", "hasBoardInk"]) {
      expect(byNode(after, key)).toEqual(byNode(before, key));
    }
    const records = await w.records();
    expect(records.map((r) => [r.node_id, r.action, r.reason, r.suggested])).toEqual(
      [
        [w.row.converted, "moved", "canvas_note_conversion", "board"],
        [w.row.offPage, "moved", "outside_page", "board"],
        [w.row.offPageBorn, "moved", "outside_page", "board"],
        [w.row.boardish, "copied", "ambiguous", "board"],
        [w.row.handwriting, "copied", "ambiguous", "handwriting"],
        [w.row.unknown, "copied", "ambiguous", "unknown"],
      ].sort((a, b) => a[0]!.localeCompare(b[0]!)),
    );
    expect(records.find((r) => r.node_id === w.row.boardish)!.signals).toMatchObject({ has_text: true, outside_page: false, born_handwriting: false, no_events: false });
    expect(records.find((r) => r.node_id === w.row.offPage)!.signals).toMatchObject({ outside_page: true, born_handwriting: false });
    expect(records.find((r) => r.node_id === w.row.offPageBorn)!.signals).toMatchObject({ outside_page: true, born_handwriting: true });
    expect(records.find((r) => r.node_id === w.row.handwriting)!.signals).toMatchObject({ has_text: false, outside_page: false, born_handwriting: true });
    expect(records.find((r) => r.node_id === w.row.unknown)!.signals).toMatchObject({ no_events: true });
    // (d) notes and events are not touched
    expect(await w.notes()).toEqual(notesBefore);
    expect(await w.maxEvent()).toBe(eventsBefore);
  });

  it("runs twice with no change", async () => {
    const w = await world();
    await w.migrate();
    const attrs = await w.attrs();
    const records = await w.records();
    await w.migrate();
    expect(await w.attrs()).toEqual(attrs);
    expect(await w.records()).toEqual(records);
  });

  it("the restore puts every attribute back as it was, once", async () => {
    const w = await world();
    const before = await w.attrs();
    await w.migrate();
    const restored = await w.restore();
    expect(restored.filter((r) => r.kept_reason === null).map((r) => r.restored_node_id).sort())
      .toEqual([w.row.converted, w.row.offPage, w.row.offPageBorn, w.row.boardish, w.row.handwriting, w.row.unknown].sort());
    expect(await w.attrs()).toEqual(before);
    expect((await w.records()).every((r) => r.restored_at !== null)).toBe(true);
    expect(await w.restore()).toEqual([]);
  });

  it("the restore keeps strokes drawn on a board since, and a note that has ink_data again", async () => {
    const w = await world();
    await w.migrate();
    const drawn = page([stroke("later", 9, 9)]);
    // The converted board was drawn on after the move; an old app wrote ink_data for the other board.
    await seedQ(`UPDATE node_attributes SET value = $2 WHERE node_id = $1 AND key = 'board_ink'`, [w.row.converted, drawn]);
    await seedQ(`UPDATE node_attributes SET value = $2 WHERE node_id = $1 AND key = 'board_ink'`, [w.row.boardish, drawn]);
    const restored = await w.restore();
    const kept = restored.filter((r) => r.kept_reason !== null);
    expect(kept.map((r) => [r.restored_node_id, r.kept_reason])).toEqual([[w.row.boardish, "board drawn on since"]]);
    // 'moved' goes back with its later strokes; the changed copy stays.
    const value = async (key: string, k: string) => (await seedQ<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = $2`, [w.row[key], k])).rows[0]?.value;
    expect(await value("converted", "ink_data")).toBe(drawn);
    expect(await value("converted", "board_ink")).toBeUndefined();
    expect(await value("boardish", "board_ink")).toBe(drawn);
  });
});
