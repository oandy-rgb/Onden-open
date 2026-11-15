// An approved tag-pack install runs as an at-least-once outbox effect, so it must
// be idempotent: a crash-interrupted run that committed the tag but not the
// outbox row must CONVERGE on retry, not throw and dead-letter (M6). A genuine
// race with a manual create still surfaces.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { q, getWorkspaceId } from "../db.js";
import { installTagPackApproved } from "../services/tagPacks.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

describe.skipIf(!isTestDb)("approved tag-pack install is idempotent under retry (M6)", () => {
  let WS = "";
  const stamp = Date.now();
  const requestedBy = { actorId: "m6-agent", actorType: "ai_agent" as const };

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
  });

  it("re-running the same approved install converges on the same tag — no throw, no duplicate", async () => {
    const pack = { name: `m6-pack-${stamp}`, fields: [{ name: "topic", type: "text" as const }] };
    const first = await installTagPackApproved(WS, requestedBy, pack);
    // Simulate the outbox redelivering the effect after a crash before done-mark.
    const second = await installTagPackApproved(WS, requestedBy, pack);
    expect(second.id).toBe(first.id);

    const count = await q<{ n: string }>(
      `SELECT count(*) AS n FROM content_nodes
        WHERE workspace_id=$1 AND title=$2 AND node_type='class_tag' AND deleted_at IS NULL`,
      [WS, pack.name],
    );
    expect(count.rows[0]!.n).toBe("1");
  });

  it("a genuine collision with a manual (non-approval) create still throws", async () => {
    const name = `m6-manual-${stamp}`;
    await seedQ(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, tag_color)
       VALUES ($1,'manual','class_tag',$2,$3,'#888')`,
      [WS, name, `tag-m6-manual-${stamp}`],
    );
    await expect(installTagPackApproved(WS, requestedBy, { name, fields: [] })).rejects.toThrow(/already exists/);
  });
  it("a tag of the same name under another parent does not block the root install (T6)", async () => {
    const name = `m6-nested-${stamp}`;
    const parent = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, tag_color)
       VALUES ($1,'manual','class_tag',$2,$3,'#888') RETURNING id`,
      [WS, `m6-parent-${stamp}`, `tag-m6-parent-${stamp}`],
    );
    await seedQ(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, tag_color, parent_id)
       VALUES ($1,'manual','class_tag',$2,$3,'#888',$4)`,
      [WS, name, `tag-m6-nested-${stamp}`, parent.rows[0]!.id],
    );
    const installed = await installTagPackApproved(WS, requestedBy, { name, fields: [] });
    const row = await q<{ parent_id: string | null }>(`SELECT parent_id FROM content_nodes WHERE id = $1`, [installed.id]);
    expect(row.rows[0]!.parent_id).toBeNull();
  });
});
