// Canvas membership flatten (canvas-as-node, migration 057) against a real
// Postgres. Membership is derived from node_positions rows whose surface is a
// live canvas node id — the old JSONB flatten matched nothing real (it looked
// for 'node_id' while the frontend writes 'nodeId') and could crash on loose
// data. This pins: real memberships resolve, deleted canvases drop out, a
// non-member query returns empty (not an error).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { q } from "../db.js";
import { getCanvasMemberships } from "../services/canvasMemberships.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

describe.skipIf(!isTestDb)("canvas memberships (node_positions-derived) (DB)", () => {
  let workspaceId: string;
  let realNodeId: string;
  let goodCanvasId: string;
  let deletedCanvasId: string;
  // Stamped slugs: the shared test DB is lived-in — static slugs collided
  // with the previous run on the (workspace,slug) unique index.
  const stamp = Date.now();

  beforeAll(async () => {
    const ws = await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Test','default')
       ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
    );
    workspaceId = ws.rows[0]!.id;

    const n = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Membership member','cm-member-${stamp}','x') RETURNING id`,
      [workspaceId],
    );
    realNodeId = n.rows[0]!.id;

    const good = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug)
       VALUES ($1,'manual','canvas','Good','cm-canvas-good-${stamp}') RETURNING id`,
      [workspaceId],
    );
    goodCanvasId = good.rows[0]!.id;
    const gone = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, deleted_at)
       VALUES ($1,'manual','canvas','Gone','cm-canvas-gone-${stamp}', now()) RETURNING id`,
      [workspaceId],
    );
    deletedCanvasId = gone.rows[0]!.id;

    // The member sits on both surfaces — only the live canvas may surface it.
    await q(
      `INSERT INTO node_positions (node_id, surface, x, y, workspace_id) VALUES
         ($2, $3, 10, 20, $1),
         ($2, $4, 30, 40, $1),
         ($2, 'graph', 0, 0, $1)
       ON CONFLICT (node_id, surface) DO NOTHING`,
      [workspaceId, realNodeId, goodCanvasId, deletedCanvasId],
    );
  });

  it("resolves membership from node_positions, excluding deleted canvases and the graph surface", async () => {
    // MB2: BOTH endpoints ride the caller's visible set now — the canvas id
    // must be in it too (bootstrap passes its full returned-node set, which
    // includes readable canvases).
    const rows = await getCanvasMemberships(workspaceId, [realNodeId, goodCanvasId]);
    expect(rows.length).toBe(1);
    expect(rows[0]!.node_id).toBe(realNodeId);
    expect(rows[0]!.canvas_id).toBe(goodCanvasId);
    expect(rows[0]!.canvas_title).toBe("Good");
  });

  it("returns nothing (not an error) when no visible node is on any canvas", async () => {
    const rows = await getCanvasMemberships(workspaceId, ["00000000-0000-0000-0000-0000deadbeef"]);
    expect(rows).toEqual([]);
  });
});
