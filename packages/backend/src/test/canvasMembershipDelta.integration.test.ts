// D98: "Appears on canvases" travels in the sync delta. Before, it existed only
// in the bootstrap, so a note dropped on a board (or taken off one) on another
// device showed only after a reload. A layout change (CANVAS_UPDATED, target
// 'canvas') now re-ships the canvas node, and every shipped node brings the
// complete membership list touching it (`canvas_memberships.replace_for`),
// filtered so a restricted canvas never names itself through a readable note.
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { describe, it, expect, beforeAll } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { buildSyncDelta } from "../services/sync/index.js";
import { getCanvasMemberships } from "../services/canvasMemberships.js";
import { applyBoardChanges } from "../services/boardWrites.js";
import { createNoteView, updateNoteView } from "../services/noteViews.js";
import { updateCanvas } from "../services/canvasNodes.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

const admin: ActorCtx = { id: "cmdelta-admin", name: "Admin", role: "admin", type: "human" };
const viewer: ActorCtx = { id: "cmdelta-viewer", name: "Viewer", role: "viewer", type: "human" };

describe.skipIf(!isTestDb)("canvas memberships in the sync delta (D98)", () => {
  let WS = "";
  let shared = "";
  let adminOnly = "";
  const stamp = Date.now();

  async function node(title: string, space: string, nodeType: "content" | "canvas" = "content"): Promise<string> {
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual',$2,$3,$4,'') RETURNING id::text`,
      [WS, nodeType, title, `${title.toLowerCase().replace(/\W+/g, "-")}-${stamp}`])).rows[0]!.id;
    await putInSpace(id, space);
    return id;
  }
  const cursor = async () => Number((await q<{ m: string }>(`SELECT COALESCE(MAX(id),0)::text AS m FROM domain_events`)).rows[0]!.m);
  const place = (canvas: string, nodeId: string) => applyBoardChanges(admin, WS, { id: canvas, node_type: "canvas" }, {
    upsertCards: [{ nodeId, x: 10, y: 20 }], removeCards: [], upsertSections: [], removeSections: [],
  });
  const takeOff = (canvas: string, nodeId: string) => applyBoardChanges(admin, WS, { id: canvas, node_type: "canvas" }, {
    upsertCards: [], removeCards: [nodeId], upsertSections: [], removeSections: [],
  });
  const pairs = (delta: Awaited<ReturnType<typeof buildSyncDelta>>) =>
    (delta.canvas_memberships?.upsert ?? []).map((m) => `${m.canvas_id}|${m.node_id}`);

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    Object.assign(admin, await persistActor(WS, admin));
    Object.assign(viewer, await persistActor(WS, viewer));
    shared = await makeSpace(WS, `cmdelta-shared-${stamp}`, [{ id: admin.id, role: "manager" }, { id: viewer.id, role: "viewer" }]);
    adminOnly = await makeSpace(WS, `cmdelta-private-${stamp}`, [{ id: admin.id, role: "manager" }]);
  });

  it("placing a note on a board ships the canvas and the membership to another reader", async () => {
    const canvas = await node(`Board ${stamp}`, shared, "canvas");
    const note = await node(`Placed ${stamp}`, shared);
    const since = await cursor();
    await place(canvas, note);

    const delta = await buildSyncDelta(viewer, WS, { since, known: [] });
    expect(delta.nodes.upsert.map((r) => r.id)).toContain(canvas);
    expect(delta.canvas_memberships?.replace_for).toContain(canvas);
    expect(pairs(delta)).toContain(`${canvas}|${note}`);
    expect(delta.canvas_memberships?.upsert.find((m) => m.node_id === note)?.canvas_title).toBe(`Board ${stamp}`);
  });

  it("taking a note off a board re-ships the canvas with a membership list that no longer has it", async () => {
    const canvas = await node(`Board off ${stamp}`, shared, "canvas");
    const note = await node(`Removed ${stamp}`, shared);
    const stays = await node(`Stays ${stamp}`, shared);
    await place(canvas, note);
    await place(canvas, stays);
    const since = await cursor();
    await takeOff(canvas, note);

    const delta = await buildSyncDelta(viewer, WS, { since, known: [] });
    expect(delta.canvas_memberships?.replace_for).toContain(canvas);
    expect(pairs(delta)).not.toContain(`${canvas}|${note}`);
    expect(pairs(delta)).toContain(`${canvas}|${stays}`);
  });

  it("renaming a canvas re-ships its memberships under the new title", async () => {
    const canvas = await node(`Old name ${stamp}`, shared, "canvas");
    const note = await node(`Renamed member ${stamp}`, shared);
    await place(canvas, note);
    const since = await cursor();
    await updateCanvas(admin, WS, canvas, { title: `New name ${stamp}`, fields: ["title"] });

    const delta = await buildSyncDelta(viewer, WS, { since, known: [] });
    expect(delta.nodes.upsert.find((r) => r.id === canvas)?.title).toBe(`New name ${stamp}`);
    expect(delta.canvas_memberships?.upsert.find((m) => m.canvas_id === canvas && m.node_id === note)?.canvas_title)
      .toBe(`New name ${stamp}`);
  });

  it("a canvas the reader cannot read is not named through a readable note", async () => {
    const hiddenCanvas = await node(`Private board ${stamp}`, adminOnly, "canvas");
    const note = await node(`Shared member ${stamp}`, shared);
    const since = await cursor();
    await place(hiddenCanvas, note);
    // The note ships to the viewer (granted: not in `known`), its memberships with it.
    const forViewer = await buildSyncDelta(viewer, WS, { since, known: [hiddenCanvas] });
    expect(forViewer.nodes.upsert.map((r) => r.id)).toContain(note);
    expect(forViewer.nodes.upsert.map((r) => r.id)).not.toContain(hiddenCanvas);
    expect(forViewer.canvas_memberships?.upsert.some((m) => m.canvas_id === hiddenCanvas)).toBe(false);
    // The owner of the board does see it.
    const forAdmin = await buildSyncDelta(admin, WS, { since, known: [] });
    expect(pairs(forAdmin)).toContain(`${hiddenCanvas}|${note}`);
  });
  describe("the board's 白板 tab", () => {
    const setTab = async (board: string, hidden: boolean, viewId?: string) => {
      const config = hidden ? { hidden: true } : {};
      if (viewId) await updateNoteView(admin, WS, board, viewId, { layout_config: config });
      else return (await createNoteView(admin, WS, board, { name: "Canvas", layout: "canvas", filters: [], sorts: [], visible_fields: [], layout_config: config, pin_order: 0 }))!.id;
      return viewId;
    };
    const bootstrapPairs = async (ids: string[]) => (await getCanvasMemberships(WS, ids)).map((m) => `${m.canvas_id}|${m.node_id}`);

    it("a hidden tab takes the board off 'Appears on canvases' in bootstrap and delta; showing it again brings the cards back", async () => {
      const board = await node(`Tabbed ${stamp}`, shared);
      const note = await node(`On tabbed ${stamp}`, shared);
      const viewId = await setTab(board, false) as string;
      await place(board, note);
      expect(await bootstrapPairs([board, note])).toContain(`${board}|${note}`);

      const hiddenAt = await cursor();
      await setTab(board, true, viewId);
      expect(await bootstrapPairs([board, note])).not.toContain(`${board}|${note}`);
      const hiddenDelta = await buildSyncDelta(viewer, WS, { since: hiddenAt - 1, known: [] });
      expect(hiddenDelta.canvas_memberships?.replace_for).toContain(board);
      expect(pairs(hiddenDelta)).not.toContain(`${board}|${note}`);
      // The placement itself is kept.
      expect((await q(`SELECT 1 FROM node_positions WHERE surface = $1 AND node_id = $2`, [board, note])).rowCount).toBe(1);

      const shownAt = await cursor();
      await setTab(board, false, viewId);
      expect(await bootstrapPairs([board, note])).toContain(`${board}|${note}`);
      const shownDelta = await buildSyncDelta(viewer, WS, { since: shownAt, known: [] });
      expect(shownDelta.canvas_memberships?.replace_for).toContain(board);
      expect(pairs(shownDelta)).toContain(`${board}|${note}`);
      const back = await q<{ x: number; y: number }>(`SELECT x, y FROM node_positions WHERE surface = $1 AND node_id = $2`, [board, note]);
      expect([back.rows[0]!.x, back.rows[0]!.y]).toEqual([10, 20]);
    });

    it("a note whose cards earned the tab without a record is listed", async () => {
      const board = await node(`Earned ${stamp}`, shared);
      const note = await node(`On earned ${stamp}`, shared);
      await q(`INSERT INTO node_positions (node_id, surface, x, y, workspace_id) VALUES ($1,$2,1,2,$3)`, [note, board, WS]);
      expect(await bootstrapPairs([board, note])).toContain(`${board}|${note}`);
    });
  });
});
