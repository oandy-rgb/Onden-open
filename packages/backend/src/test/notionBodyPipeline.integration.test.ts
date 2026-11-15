// D27: a Notion row page's body goes through the same body pipeline as every
// other body write (services/bodySideEffects.ts applyBodyChange): its wikilink
// edges are written, and the NODE_UPDATED carries an inverse patch so undoing
// it reverts the body. attachBody used to UPDATE the markdown on its own.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { q, getWorkspaceId } from "../db.js";
import { importNotionDatabases } from "../modules/importers/notion/database.js";
import { restoreEvent } from "../services/eventRestore/restore.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

describe.skipIf(!isTestDb)("Notion row page bodies use the body pipeline (D27)", () => {
  let WS = "";
  let admin: ActorCtx = { id: "d27-admin", name: "Admin", role: "admin", type: "human" };
  // Per test (beforeEach): its own target note and imported row, so the undo
  // test reverting the body never takes the edge away from the other one.
  let stamp = "", target = "", rowTitle = "", body = "";
  let targetId = "", itemId = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    admin = await persistActor(WS, admin);
  });
  beforeEach(async () => {
    stamp = randomUUID().slice(0, 8);
    target = `D27 Target ${stamp}`;
    rowTitle = `D27 Row ${stamp}`;
    body = `About the row.\n\nSee [[${target}]].`;
    targetId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
       VALUES ($1,'manual','content',$2,$3,'',
               -- [[title]] resolves within the note's space; the imported row
               -- lands in the importer's personal space.
               (SELECT s.id FROM spaces s JOIN space_members m ON m.space_id = s.id
                 WHERE s.workspace_id = $1 AND s.kind = 'personal' AND m.actor_id = $4::uuid LIMIT 1))
       RETURNING id`,
      [WS, target, `d27-target-${stamp}`, admin.id])).rows[0]!.id;

    const id = "0123456789abcdef0123456789abcdef";
    const result = await importNotionDatabases(
      WS,
      [{ path: `D27 Books ${stamp}.csv`, content: `Name,Status\n${rowTitle},Reading\n` }],
      [{ path: `D27 Books ${stamp}/${rowTitle} ${id}.md`, content: `# ${rowTitle}\n\n${body}\n` }],
      admin,
    );
    expect(result.bodiesAttached).toBe(1);
    await awaitAllDispatchers();
    itemId = (await q<{ id: string }>(
      `SELECT id FROM content_nodes WHERE workspace_id = $1 AND title = $2 AND deleted_at IS NULL`,
      [WS, rowTitle])).rows[0]!.id;
  });
  afterAll(async () => { await awaitAllDispatchers(); });

  it("writes the body's wikilink edges", async () => {
    const edges = await q(
      `SELECT 1 FROM node_edges WHERE source_node_id = $1 AND target_node_id = $2 AND origin = 'wikilink'`,
      [itemId, targetId]);
    expect(edges.rowCount).toBe(1);
  });

  it("undoing the body write reverts the body", async () => {
    const before = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [itemId])).rows[0]!.markdown;
    expect(before).toContain(`[[${target}]]`);
    const ev = (await q<{ id: string }>(
      `SELECT id::text FROM domain_events
        WHERE target_id = $1 AND event_type = 'NODE_UPDATED' AND tx_meta->>'ui_context' = 'import.notion.body'
        ORDER BY domain_events.id DESC LIMIT 1`, [itemId])).rows[0]!;
    expect(await restoreEvent(ev.id, { actor: admin, workspaceId: WS })).toMatchObject({ restored: true });
    const after = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [itemId])).rows[0]!.markdown;
    expect(after).not.toContain(`[[${target}]]`);
  });
});
