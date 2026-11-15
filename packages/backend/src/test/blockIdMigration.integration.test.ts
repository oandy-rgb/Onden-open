// Moving block identity out of the text (migration 180, services/blockIdMigration.ts): every `^id` an existing note
// holds becomes an anchor of the same id and leaves the body; nothing a block had (row, tags, review progress,
// citations) is lost, a second run does nothing, and the way back writes the marks again.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import { repairBlockMarkers, revertBlockIdMarks } from "../services/blockMarkerRepair.js";
import type { ActorCtx } from "../types.js";
import { feedByDay } from "../services/history/index.js";
import { localDayId } from "../localDay.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);
let workspaceId = "";
let actor: ActorCtx = { id: "block-id-migration-admin", name: "Migration", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/nodes", nodesRouter);
registerShippedModules();
const send = (url: string, method: string, body: unknown = {}) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const bodyOf = async (id: string) => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;
const formOf = async (id: string) => Number((await q<{ f: number }>(`SELECT anchor_form AS f FROM content_nodes WHERE id = $1`, [id])).rows[0]!.f);
const updatedAt = async (id: string) => String((await q<{ u: string }>(`SELECT updated_at::text AS u FROM content_nodes WHERE id = $1`, [id])).rows[0]!.u);
const rowsOf = async (noteId: string) => (await q<{ id: string; block_ref: string; anchor_id: string | null; hidden: boolean }>(
  `SELECT id::text, block_ref, anchor_id, hidden_at IS NOT NULL AS hidden FROM block_nodes WHERE note_id = $1 ORDER BY block_ref`, [noteId])).rows;
const anchorsOf = async (noteId: string) => (await q<{ anchor_id: string; from_utf16: number; status: string }>(
  `SELECT anchor_id, from_utf16, status FROM block_anchors WHERE note_id = $1 ORDER BY from_utf16`, [noteId])).rows;
const eventCount = async () => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM domain_events WHERE workspace_id = $1`, [workspaceId])).rows[0]!.n);

/** A note as the app wrote it before this change: `^id` marks in the body, a row per tagged block known by that id, no anchor yet. */
async function legacyNote(markdown: string, rows: Array<{ ref: string; kind: string; label: string }>): Promise<string> {
  const id = randomUUID();
  await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, anchor_form)
           VALUES ($1, $2, 'manual', 'content', $3, $4, $5, 0)`, [id, workspaceId, `Legacy ${id.slice(0, 6)}`, `legacy-${id.slice(0, 8)}`, markdown]);
  for (const r of rows) {
    await seedQ(`INSERT INTO block_nodes (workspace_id, note_id, block_ref, kind, label, text_cache) VALUES ($1, $2, $3, $4, $5, $5)`,
      [workspaceId, id, r.ref, r.kind, r.label]);
  }
  return id;
}

describe.skipIf(!isTestDb)("block ids leave the text (DB)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('BlockIdMigration',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
  });

  it("an existing note: marks leave the text, the same ids become anchors, the row is the same row, 'recent' does not move", async () => {
    const noteId = await legacyNote("# 標題 ^h1\n\n考點 {複習} ^aa11\n\n> 引文\n\n^q1\n", [{ ref: "aa11", kind: "paragraph", label: "考點" }]);
    const rowBefore = (await rowsOf(noteId))[0]!.id;
    const stamp = await updatedAt(noteId);

    const report = await repairBlockMarkers({ workspaceId });
    expect(report.conversion.notesConverted).toBeGreaterThanOrEqual(1);
    expect(await bodyOf(noteId)).toBe("# 標題\n\n考點 {複習}\n\n> 引文\n");
    expect((await anchorsOf(noteId)).map((a) => a.anchor_id).sort()).toEqual(["aa11", "h1", "q1"]);
    expect((await anchorsOf(noteId)).every((a) => a.status === "valid")).toBe(true);
    // The row is the one it was, now answering to its anchor.
    expect(await rowsOf(noteId)).toEqual([{ id: rowBefore, block_ref: "aa11", anchor_id: "aa11", hidden: false }]);
    expect(await formOf(noteId)).toBe(1);
    expect(await updatedAt(noteId)).toBe(stamp);
    const events = (await q<{ event_type: string; actor_type: string; ui: string | null }>(
      `SELECT event_type, actor_type, tx_meta->>'ui_context' AS ui FROM domain_events WHERE target_id = $1 AND event_type = 'NODE_UPDATED'`, [noteId])).rows;
    expect(events).toEqual([{ event_type: "NODE_UPDATED", actor_type: "system", ui: "system.block_id_migration" }]);
  });

  it("running it again changes nothing and writes no event (idempotent)", async () => {
    const noteId = await legacyNote("段落 {考點} ^bb22\n", [{ ref: "bb22", kind: "paragraph", label: "段落" }]);
    await repairBlockMarkers({ workspaceId });
    const body = await bodyOf(noteId);
    const before = await eventCount();
    const again = await repairBlockMarkers({ workspaceId });
    expect(again.conversion.notesConverted).toBe(0);
    expect(await bodyOf(noteId)).toBe(body);
    expect(await eventCount()).toBe(before);
  });

  it("a note without any mark is only marked as converted: no write, no event", async () => {
    const noteId = await legacyNote("沒有任何標記，有 x^2 這種上標\n", []);
    const before = await eventCount();
    await repairBlockMarkers({ workspaceId });
    expect(await formOf(noteId)).toBe(1);
    expect(await bodyOf(noteId)).toBe("沒有任何標記，有 x^2 這種上標\n");
    expect(await eventCount()).toBe(before);
  });

  it("an id another note's anchor already has: the block takes a new id and its row follows", async () => {
    const first = await legacyNote("甲 {考點} ^cc33\n", [{ ref: "cc33", kind: "paragraph", label: "甲" }]);
    await repairBlockMarkers({ workspaceId });
    expect((await anchorsOf(first)).map((a) => a.anchor_id)).toEqual(["cc33"]);
    const second = await legacyNote("乙 {考點} ^cc33\n", [{ ref: "cc33", kind: "paragraph", label: "乙" }]);
    const report = await repairBlockMarkers({ workspaceId });
    expect(report.conversion.idsChanged).toBeGreaterThanOrEqual(1);
    const [row] = await rowsOf(second);
    expect(row!.block_ref).not.toBe("cc33");
    expect(row!.hidden).toBe(false);
    expect(row!.anchor_id).toBe(row!.block_ref);
    expect((await anchorsOf(first)).map((a) => a.anchor_id)).toEqual(["cc33"]); // the first note keeps its id
  });

  it("does not guess: a hashtag block that exists only through its `^id` is left as it is and listed", async () => {
    const noteId = await legacyNote("想法 #idea ^dd44\n", []);
    const report = await repairBlockMarkers({ workspaceId });
    expect(report.conversion.left).toContainEqual({ workspaceId, noteId, reason: "not_the_same_blocks" });
    expect(await bodyOf(noteId)).toBe("想法 #idea ^dd44\n");
    expect(await formOf(noteId)).toBe(2);
  });

  it("the way back writes the marks again, and converting again gives the same text and the same ids", async () => {
    const created = await send("/nodes", "POST", { title: `Round ${randomUUID().slice(0, 6)}`, markdown: "# 章節\n\n考點 {複習}\n\n- 一\n- 二 {考點}\n" });
    expect(created.status).toBe(201);
    const noteId = ((await created.json()) as { id: string }).id;
    const text = await bodyOf(noteId);
    expect(text).not.toContain("^"); // a save no longer writes marks
    const rows = await rowsOf(noteId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.anchor_id === r.block_ref)).toBe(true);

    const reverted = await revertBlockIdMarks({ workspaceId });
    expect(reverted.notesReverted).toBeGreaterThanOrEqual(1);
    const marked = await bodyOf(noteId);
    for (const r of rows) expect(marked).toContain(`^${r.block_ref}`);
    expect(await formOf(noteId)).toBe(0);

    await repairBlockMarkers({ workspaceId });
    expect(await bodyOf(noteId)).toBe(text);
    expect(await rowsOf(noteId)).toEqual(rows);
    expect((await anchorsOf(noteId)).map((a) => a.status)).toEqual(expect.arrayContaining(["valid"]));
  });

  it("a pass given a workspace leaves every other workspace's notes alone (both ways)", async () => {
    const other = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('BlockIdMigrationOther',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    const note = async (markdown: string, form: number) => {
      const id = randomUUID();
      await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, anchor_form)
               VALUES ($1, $2, 'manual', 'content', $3, $4, $5, $6)`, [id, other, `Other ${id.slice(0, 6)}`, `other-${id.slice(0, 8)}`, markdown, form]);
      return id;
    };
    const legacy = await note("別處 {考點} ^o1x\n", 0);
    const converted = await note("別處的新筆記\n", 1);
    await repairBlockMarkers({ workspaceId });
    await revertBlockIdMarks({ workspaceId });
    await repairBlockMarkers({ workspaceId });
    expect([await bodyOf(legacy), await formOf(legacy)]).toEqual(["別處 {考點} ^o1x\n", 0]);
    expect([await bodyOf(converted), await formOf(converted)]).toEqual(["別處的新筆記\n", 1]);
  });

  it("History shows the pass as ONE row, not an edit per note, and never an id", async () => {
    const titles: string[] = [];
    for (const label of ["丙", "丁", "戊"]) {
      const id = await legacyNote(`${label} {考點} ^h${label === "丙" ? "1" : label === "丁" ? "2" : "3"}x\n`, [{ ref: `h${label === "丙" ? "1" : label === "丁" ? "2" : "3"}x`, kind: "paragraph", label }]);
      titles.push((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [id])).rows[0]!.title);
    }
    await repairBlockMarkers({ workspaceId });
    const today = localDayId();
    const feed = await feedByDay(actor, workspaceId, today, 1);
    const day = feed.days.find((d) => d.date === today)!;
    // One row for the pass that moved these three notes (earlier tests' passes the same day are rows of their own).
    const mine = day.system_tidies.filter((t) => titles.every((title) => t.notes.some((n) => n.title === title)));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.kind).toBe("marks_moved_out");
    // The day's own edit list leaves the system's saves out.
    expect(day.notes.map((n) => n.title)).not.toEqual(expect.arrayContaining([titles[0]]));
  });
});
