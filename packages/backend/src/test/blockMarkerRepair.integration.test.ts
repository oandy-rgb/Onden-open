// 2026-11-07 (Android 注音): text typed under a tagged paragraph's `{複習} ^id` left the marker mid-paragraph,
// the paragraph's row hid itself and its review card with it. repairBlockMarkers puts the marker back on the
// paragraph's last line: same id, same row, same tags and review progress. Since block identity left the text
// (anchors, migration 180) the same pass then turns that `^id` into the anchor of the same id, so the marker is
// put back first and converted second; these notes are written as the app wrote them BEFORE the switch (seedQ:
// `^id` in the body, a row known by that id, no anchor, anchor_form 0).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import { repairBlockMarkers } from "../services/blockMarkerRepair.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);
let workspaceId = "";
let actor: ActorCtx = { id: "marker-repair-admin", name: "Repair", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/nodes", nodesRouter);
registerShippedModules();
const send = (url: string, method: string, body: unknown = {}) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const bodyOf = async (id: string) => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;
const rowsOf = async (noteId: string) => (await q<{ id: string; block_ref: string; hidden: boolean }>(
  `SELECT id::text, block_ref, hidden_at IS NOT NULL AS hidden FROM block_nodes WHERE note_id = $1 ORDER BY block_ref`, [noteId])).rows;
const updatedAt = async (id: string) => String((await q<{ updated_at: string }>(`SELECT updated_at::text FROM content_nodes WHERE id = $1`, [id])).rows[0]!.updated_at);

const anchorsOf = async (noteId: string) => (await q<{ anchor_id: string; status: string }>(
  `SELECT anchor_id, status FROM block_anchors WHERE note_id = $1 ORDER BY anchor_id`, [noteId])).rows;
const formOf = async (id: string) => Number((await q<{ f: number }>(`SELECT anchor_form AS f FROM content_nodes WHERE id = $1`, [id])).rows[0]!.f);

/** A note as it stood after the Android bug, before the switch: the paragraph's marker split by typed text, its row hidden. */
async function brokenNote(): Promise<{ noteId: string; rowId: string; ref: string; broken: string }> {
  const noteId = randomUUID();
  const ref = randomUUID().replace(/\D/g, "").slice(0, 3) + "ab1";
  const broken = `我發現不 {複習} ^${ref}\n新打的字\n\n後面的段落\n`;
  await seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, anchor_form)
           VALUES ($1, $2, 'manual', 'content', $3, $4, $5, 0)`, [noteId, workspaceId, `Broken ${noteId.slice(0, 6)}`, `broken-${noteId.slice(0, 8)}`, broken]);
  const rowId = (await seedQ<{ id: string }>(
    `INSERT INTO block_nodes (workspace_id, note_id, block_ref, kind, label, text_cache, hidden_at) VALUES ($1, $2, $3, 'paragraph', '我發現不', '我發現不', now()) RETURNING id::text`,
    [workspaceId, noteId, ref])).rows[0]!.id;
  return { noteId, rowId, ref, broken };
}

describe.skipIf(!isTestDb)("a split `{…} ^id` marker is put back (DB)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('MarkerRepair',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
  });

  it("the reported case: the marker comes back, then becomes the anchor of the same id; same row, 'recent' does not move", async () => {
    const { noteId, rowId, ref, broken } = await brokenNote();
    expect(await rowsOf(noteId)).toEqual([{ id: rowId, block_ref: ref, hidden: true }]); // the bug: hidden
    const stamp = await updatedAt(noteId);

    const report = await repairBlockMarkers({ workspaceId });
    expect(report.notesRepaired).toBeGreaterThanOrEqual(1);
    expect(report.conversion.notesConverted).toBeGreaterThanOrEqual(1);

    const body = await bodyOf(noteId);
    expect(body).not.toContain("^"); // the marker was put back on the last line, then left the text
    expect(body).toBe("我發現不\n新打的字 {複習}\n\n後面的段落\n");
    expect(body).not.toBe(broken);
    expect(await anchorsOf(noteId)).toEqual([{ anchor_id: ref, status: "valid" }]); // the same id, now an anchor
    expect(await rowsOf(noteId)).toEqual([{ id: rowId, block_ref: ref, hidden: false }]);
    expect(await formOf(noteId)).toBe(1);
    expect(await updatedAt(noteId)).toBe(stamp);
    const events = (await q<{ event_type: string; actor_type: string }>(
      `SELECT event_type, actor_type FROM domain_events WHERE target_id = $1 AND target_type = 'node' AND event_type IN ('NODE_UPDATED', 'BLOCK_NODE_RESTORED')`, [noteId])).rows;
    expect(events.some((e) => e.event_type === "BLOCK_NODE_RESTORED")).toBe(true);
    const updates = events.filter((e) => e.event_type === "NODE_UPDATED");
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates.every((e) => e.actor_type === "system")).toBe(true);
  });

  it("running it again changes nothing and writes no event", async () => {
    const { noteId } = await brokenNote();
    await repairBlockMarkers({ workspaceId });
    const body = await bodyOf(noteId);
    const count = async () => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM domain_events WHERE workspace_id = $1`, [workspaceId])).rows[0]!.n);
    const before = await count();
    const again = await repairBlockMarkers({ workspaceId });
    expect(again.notesRepaired).toBe(0);
    expect(again.conversion.notesConverted).toBe(0);
    expect(await bodyOf(noteId)).toBe(body);
    expect(await count()).toBe(before);
  });

  it("does not guess: a repeated id is left as it is and listed", async () => {
    const { noteId, ref } = await brokenNote();
    const twice = `${await bodyOf(noteId)}\n又出現 ^${ref}\n`;
    await seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [noteId, twice]);
    const report = await repairBlockMarkers({ workspaceId });
    expect(report.skipped).toContainEqual({ workspaceId, noteId, reason: "cannot_decide" });
    // The split marker is not moved (which of the two is the block's?) and its row stays hidden. The conversion only
    // takes a mark that ends its paragraph, so the repeated one at the end becomes the anchor of that id; the split
    // one stays plain text.
    expect(await bodyOf(noteId)).toContain("我發現不 {複習} ^" + ref + "\n新打的字");
    expect((await rowsOf(noteId))[0]!.hidden).toBe(true);
    expect((await rowsOf(noteId))).toHaveLength(1);
  });

  it("leaves a paragraph standing alone as a note, and one whose tag the person removed, alone", async () => {
    const created = await send("/nodes", "POST", { title: `Gone ${randomUUID().slice(0, 6)}`, markdown: "有標籤 {複習}" });
    const noteId = ((await created.json()) as { id: string }).id;
    expect((await send(`/nodes/${noteId}`, "PATCH", { markdown: "有標籤" })).status).toBe(200); // hidden on purpose: the `{…}` is gone
    const before = await bodyOf(noteId);
    await repairBlockMarkers({ workspaceId });
    expect(await bodyOf(noteId)).toBe(before);
    expect((await rowsOf(noteId))[0]!.hidden).toBe(true);
  });
});
