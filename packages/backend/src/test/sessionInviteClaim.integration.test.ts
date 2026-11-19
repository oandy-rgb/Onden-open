// A temporary session never takes an invite (PR #1856 review round 3, point 2). Taking one changes who is a member of what; a session's reach is
// only the spaces chosen when it was opened. Two layers, both pinned here: the claim runs only where a sign-in is resolved from a cookie (app.ts:
// the invite token is handed to actorForSession only when no bearer credential came), so a session's credential never claims; and the route
// answers it 403 (routes/invites.ts requirePerson). Before round 3 the route answered 200, echoing the session's own actor, and claimed nothing.
//
// SAFETY: only runs against a *_test database; skips otherwise. The test makes its own workspace (shared database).
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, q } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { openAs, standardWorld } from "./helpers/sessionWorld.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { createActor } from "../services/actors.js";

registerShippedModules();
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) }, // nobody signs in: the only credential is the session's
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
  configuredSocialProviders: [],
}));
const { app } = await import("../app.js");

afterAll(async () => { await pool.end(); });

describe.skipIf(!isTestDatabase())("a temporary session and an invite", () => {
  it("with a real, pending invite's token, the session is refused (403), the invite stays unclaimed and no member is added", async () => {
    const w = await standardWorld("claimBySession");
    ownWorkspace = w.ws;
    const invited = await createActor(w.owner.ctx, async () => ({ name: "Invitee", type: "human", email: `invitee-${randomUUID()}@claim.test` })) as { id: string; invite_token: string };
    const opened = await openAs(w.owner, w.ws, { spaces: [{ spaceId: w.spaceA, permission: "edit" }] });
    const count = async () => (await q<{ actors: string; members: string }>(
      `SELECT (SELECT count(*) FROM actors WHERE workspace_id = $1)::text AS actors,
              (SELECT count(*) FROM space_members m JOIN spaces s ON s.id = m.space_id WHERE s.workspace_id = $1)::text AS members`, [w.ws])).rows[0]!;
    const before = await count();
    const res = await app.request("/api/invites/claim", {
      method: "POST", headers: { authorization: `Bearer ${opened.credential}`, "content-type": "application/json" },
      body: JSON.stringify({ token: invited.invite_token }),
    });
    expect(res.status).toBe(403);
    expect(await count()).toEqual(before);
    const row = (await q<{ external_id: string | null; invite_used_at: Date | null }>(`SELECT external_id, invite_used_at FROM actors WHERE id = $1`, [invited.id])).rows[0]!;
    expect(row).toEqual({ external_id: null, invite_used_at: null });
  });
});
