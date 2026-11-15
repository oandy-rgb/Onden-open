// Restore authority + workspace scoping (Phase B2) against a real Postgres.
// Event restore rewinds a node's history, so it must clear the same bar as
// writing the node directly:
//   - a viewer (or tag-scoped agent) that can't write the node can't restore
//     an event on it → AuthorityError (route maps to 403);  (audit #2/#3)
//   - an event id from another workspace resolves to not_found, so a restore
//     keyed only on the global id can't reach across workspaces; (audit #3)
//   - an authorized actor restores and a fresh attributed event lands.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { q, event } from "../db.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import { AuthorityError } from "../spine/authority.js";
import type { ActorCtx } from "../types.js";
import { randomUUID } from "node:crypto";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let viewer: ActorCtx = { id: "v", name: "V", role: "viewer", type: "human" };
let admin: ActorCtx = { id: "a", name: "A", role: "admin", type: "human" };

describe.skipIf(!isTestDb)("restore authority + workspace scoping (DB)", () => {
  let WS = "";
  let node = "";
  let evtId = "";

  beforeAll(async () => {
    WS = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Test','default')
       ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
    )).rows[0]!.id;
    // Admin first: on a workspace with no owner the first human persisted
    // becomes the owner (actors_sync_spaces) and may write anything, which would
    // make the "viewer" unrestrictable when this file runs alone.
    admin = await persistActor(WS, admin);
    viewer = await persistActor(WS, viewer);

    // Live node behind a class tag whose policy requires admin to write.
    node = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Gated','gated-${Date.now()}','body') RETURNING id`,
      [WS],
    )).rows[0]!.id;
    const tag = (await seedClassTag(WS, {
      // Unique per run: tag titles are unique and earlier runs' tags stay.
      name: `Locked ${Date.now()}`,
      slug: `locked-${Date.now()}`,
      title: `locked-${Date.now()}`,
      nodeSlug: `locked-tag-${Date.now()}`,
      policy: { operations: { write_node: "admin" } },
    })).tagId;
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2)`, [node, tag]);

    // A restorable NODE_UPDATED event on that (live) node.
    evtId = await event(
      WS, "NODE_UPDATED", "node", node, { title: "Gated" }, "user", admin.id,
      { txMeta: { inverse_patch: "", prev_field_values: { title: "Gated before" } } },
    );
  });

  it("a viewer cannot restore an event on an admin-write-gated node", async () => {
    await expect(restoreEvent(evtId, { workspaceId: WS, actor: viewer })).rejects.toThrow(AuthorityError);
  });

  it("an event id from another workspace resolves to not_found", async () => {
    const other = (await q<{ id: string }>(
      `INSERT INTO workspaces(name,slug) VALUES('Other restore authority',$1) RETURNING id`, [randomUUID()],
    )).rows[0]!.id;
    const otherAdmin = await persistActor(other, admin);
    const r = await restoreEvent(evtId, { workspaceId: other, actor: otherAdmin });
    expect("code" in r && r.code).toBe("not_found");
  });

  it("an admin restores, and a fresh attributed restore event lands", async () => {
    const r = await restoreEvent(evtId, { workspaceId: WS, actor: admin });
    expect("restored" in r && r.restored).toBe(true);
    const child = await q<{ actor_type: string }>(
      `SELECT actor_type FROM domain_events
        WHERE workspace_id = $1 AND (tx_meta->>'restored_from') = $2`,
      [WS, evtId],
    );
    expect(child.rows.length).toBeGreaterThan(0);
    expect(child.rows[0]!.actor_type).toBe("user"); // human admin → 'user'
  });
});
