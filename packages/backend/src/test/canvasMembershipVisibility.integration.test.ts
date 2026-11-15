// MB2 (2026-07-04 blindspot sweep): bootstrap canvas memberships filtered only
// the MEMBER node — a readable node placed on a restricted canvas leaked the
// canvas's id+title. The memberships now filter against the caller's visible
// set.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { getCanvasMemberships } from "../services/canvasMemberships.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

describe.skipIf(!isTestDb)("canvas membership visibility (MB2)", () => {
  let WS = "";
  const stamp = Date.now();

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
  });

  it("a restricted canvas's id+title never rides out on a readable member node", async () => {
    const canvas = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug)
       VALUES ($1, 'manual', 'canvas', $2, $3) RETURNING id`,
      [WS, `crg-secret-canvas-${stamp}`, `crg-secret-canvas-${stamp}`]);
    const member = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug)
       VALUES ($1, 'manual', 'content', $2, $3) RETURNING id`,
      [WS, `crg-member-${stamp}`, `crg-member-${stamp}`]);
    const canvasId = canvas.rows[0]!.id, memberId = member.rows[0]!.id;
    await q(
      `INSERT INTO node_positions (workspace_id, surface, node_id, x, y) VALUES ($1, $2, $3, 0, 0)`,
      [WS, canvasId, memberId]);

    // Caller's visible set WITHOUT the canvas (a viewer for whom the canvas
    // is restricted): the membership must not surface at all.
    const hidden = await getCanvasMemberships(WS, [memberId]);
    expect(hidden.some((m) => m.canvas_id === canvasId)).toBe(false);

    // Both endpoints visible → the membership surfaces.
    const shown = await getCanvasMemberships(WS, [memberId, canvasId]);
    expect(shown.some((m) => m.canvas_id === canvasId && m.node_id === memberId)).toBe(true);
  });
});
