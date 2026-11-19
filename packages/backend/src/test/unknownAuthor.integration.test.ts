// What this node does when an event or a stamp names an operator id it has never heard of: the shape of a session's write that arrives from another
// node (a session's actor row is not carried by a snapshot: spine/snapshotTables.json). FOUND: the event is refused at INSERT (migration 071's
// domain_events_actor_ref trigger), so there is no reader to throw; what breaks is taking the event in. Pinned with it.fails below; the batch that
// fixes it is the one that makes the change bundle carry the session's display name (the receiver then creates the actor row first).
// A stamp's author is plain text with no such check, and every reader copes with it (last test).
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, q, event } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { newNote, standardWorld } from "./helpers/sessionWorld.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { readStampedPages } from "../services/stampedSnapshot.js";

registerShippedModules();
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
let signedInAs: string | null = null;
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => signedInAs ? { user: { id: signedInAs, name: "Person", email: `${signedInAs}@unknown.test` } } : null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
  configuredSocialProviders: [],
}));
const { app } = await import("../app.js");

describe.skipIf(!isTestDatabase())("an operator this node does not know", () => {
  let w: Awaited<ReturnType<typeof standardWorld>>;
  let note = "";
  const stranger = randomUUID();
  beforeAll(async () => {
    w = await standardWorld("unknownAuthor");
    ownWorkspace = w.ws;
    note = await newNote(w.ws, "written elsewhere", w.spaceA, "body");
  });
  afterAll(async () => { await pool.end(); });

  it("today an event naming an unknown uuid operator is REFUSED at insert (so a session's write from another node cannot be taken in)", async () => {
    await expect(event(w.ws, "NODE_UPDATED", "node", note, { title: "x", body_hash: "h" }, "user", stranger)).rejects.toThrow(/resolves to no actor/);
  });

  // The wanted behaviour: the event is taken in and the readers show a fallback label. Fails today (see the test above). Fixed by: the change-bundle batch.
  it.fails("WANTED: an event naming an unknown operator is taken in", async () => {
    await event(w.ws, "NODE_UPDATED", "node", note, { title: "x", body_hash: "h" }, "user", stranger);
  });

  it("a stamp whose author is unknown is read by a snapshot without throwing", async () => {
    await q(`UPDATE sync_stamps SET author = $2 WHERE workspace_id = $1 AND row_key = $3 AND table_name = 'content_nodes'`, [w.ws, stranger, note]);
    let carried = "";
    await readStampedPages(w.owner.ctx, w.ws, { since: null, layer: "rows" }, async (page) => { carried += JSON.stringify(page); });
    expect(carried).toContain(stranger);
  });

  it("the note's history and the event list still answer for a note whose latest stamp is by an unknown author", async () => {
    signedInAs = w.owner.ext;
    try {
      for (const path of [`/api/nodes/${note}/history`, `/api/nodes/${note}/versions`, `/api/events?target_id=${note}`]) {
        expect([path, (await app.request(path)).status]).toEqual([path, 200]);
      }
    } finally { signedInAs = null; }
  });
});
