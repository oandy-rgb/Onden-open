// GET /api/bootstrap reads one snapshot: changes that commit while it runs —
// after its event cursor is read, before its rows are — are not in the
// payload, so the rows, the read set and the cursor agree, and the next
// delta (from that cursor) brings the change. Before, the rows came from
// whatever had committed by each query, newer than the cursor said.
//
// The hook: readableNodeIdSet runs right after the cursor read; the test
// commits a change on another connection there, then lets it continue.
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, q } from "../db.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";
import { needsSecondConnection } from "./helpers/pgliteSkips.js";

let midBootstrap: (() => Promise<void>) | null = null;
vi.mock("../services/readPolicy.js", async (original) => {
  const real = await original<typeof import("../services/readPolicy.js")>();
  return {
    ...real,
    readableNodeIdSet: async (...args: Parameters<typeof real.readableNodeIdSet>) => {
      const hook = midBootstrap;
      midBootstrap = null;
      if (hook) await hook();
      return real.readableNodeIdSet(...args);
    },
  };
});

const { buildBootstrap } = await import("../services/sync/index.js");

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

const viewer: ActorCtx = { id: "boot-snap-viewer", name: "Viewer", role: "viewer", type: "human" };
const admin: ActorCtx = { id: "boot-snap-admin", name: "Admin", role: "admin", type: "human" };

describe.skipIf(!isTestDb)("bootstrap reads one snapshot (DB)", () => {
  let WS = "";
  let space = "";
  let stamp = "";

  /** A note in `space` with its NODE_CREATED event, committed on its own
   *  connection (outside any snapshot). */
  async function committedNote(title: string): Promise<string> {
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
       VALUES ($1,'manual','content',$2,$3,'body',$4) RETURNING id::text`,
      [WS, title, `boot-snap-${title.toLowerCase().replace(/\W+/g, "-")}-${stamp}`, space])).rows[0]!.id;
    await pool.query(
      `INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id)
       VALUES ($1,'user',$2,'NODE_CREATED','node',$3)`, [WS, admin.id, id]);
    return id;
  }

  // A workspace of its own: the viewer's bootstrap reads only these notes,
  // however much other files left in the shared 'default' one.
  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Boot snapshot', $1) RETURNING id::text`, [`boot-snap-${randomUUID()}`])).rows[0]!.id;
    Object.assign(viewer, await persistActor(WS, viewer));
    Object.assign(admin, await persistActor(WS, admin));
  });
  // A space per test: the test that removes the viewer from its space must
  // not take the other test's notes out of the viewer's read set.
  beforeEach(async () => {
    stamp = randomUUID().slice(0, 8);
    space = await makeSpace(WS, `boot-snap-${stamp}`, [{ id: admin.id, role: "manager" }, { id: viewer.id, role: "viewer" }]);
  });

  it.skipIf(needsSecondConnection)("a note created and a title changed mid-bootstrap are not in the payload; nothing is newer than its cursor", async () => {
    const existing = await committedNote(`Before ${stamp}`);
    await putInSpace(existing, space);
    let created = "";
    midBootstrap = async () => {
      created = await committedNote(`During ${stamp}`);
      await pool.query(`UPDATE content_nodes SET title = $2 WHERE id = $1`, [existing, `Renamed ${stamp}`]);
      await pool.query(
        `INSERT INTO domain_events (workspace_id, actor_type, actor_id, event_type, target_type, target_id)
         VALUES ($1,'user',$2,'NODE_UPDATED','node',$3)`, [WS, admin.id, existing]);
    };

    const payload = await buildBootstrap(viewer, WS, { slimBodies: true });
    expect(created).not.toBe(""); // the hook ran

    const nodes = payload.nodes as Array<{ id: string; title: string }>;
    expect(nodes.map((n) => n.id)).not.toContain(created);
    expect(nodes.find((n) => n.id === existing)?.title).toBe(`Before ${stamp}`);
    const cursor = BigInt(payload.last_event_id);
    for (const e of payload.events as Array<{ id: string | number }>) expect(BigInt(e.id) <= cursor).toBe(true);

    // The next bootstrap sees both changes.
    const after = await buildBootstrap(viewer, WS, { slimBodies: true });
    const afterNodes = after.nodes as Array<{ id: string; title: string }>;
    expect(afterNodes.map((n) => n.id)).toContain(created);
    expect(afterNodes.find((n) => n.id === existing)?.title).toBe(`Renamed ${stamp}`);
    expect(BigInt(after.last_event_id) > cursor).toBe(true);
  });

  it.skipIf(needsSecondConnection)("says when the server read it (server_time): anything committed during the read is later, and there is no block channel", async () => {
    let late = "";
    midBootstrap = async () => { late = await committedNote(`Late ${stamp}`); };
    const payload = await buildBootstrap(viewer, WS, { slimBodies: true });
    expect(late).not.toBe("");
    expect(payload.server_time).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    const createdAt = (await pool.query(`SELECT created_at FROM content_nodes WHERE id = $1`, [late])).rows[0].created_at as Date;
    expect(createdAt.getTime()).toBeGreaterThanOrEqual(new Date(payload.server_time).getTime());
    expect(payload).not.toHaveProperty("blocks");
  });

  it.skipIf(needsSecondConnection)("losing the space mid-bootstrap: this payload is the earlier moment, whole", async () => {
    const note = await committedNote(`Member ${stamp}`);
    midBootstrap = async () => {
      await pool.query(`DELETE FROM space_members WHERE space_id = $1 AND actor_id = $2`, [space, viewer.id]);
    };
    const payload = await buildBootstrap(viewer, WS, { slimBodies: false });
    // Read set and rows from before the removal agree: the note and its body.
    const row = (payload.nodes as Array<{ id: string; markdown: string }>).find((n) => n.id === note);
    expect(row?.markdown).toBe("body");
    // The next one is after it.
    const after = await buildBootstrap(viewer, WS, { slimBodies: false });
    expect((after.nodes as Array<{ id: string }>).map((n) => n.id)).not.toContain(note);
  });
});
