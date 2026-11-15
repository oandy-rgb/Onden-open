// D118: removing a member closes their personal space through the space
// service (services/spaces.ts orphanPersonalSpace), not a raw UPDATE: the
// change is recorded as SPACE_UPDATED (with the previous values, triggered by
// ACTOR_DELETED) and, when the space published, the website requests a site
// rebuild in the same transaction, so the leaver's pages leave the static
// host at once instead of at the next Publish.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { removeActor } from "../services/actors.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));
registerShippedModules();

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

describe.skipIf(!isTestDb)("removing a member closes their personal space through the space service (D118)", () => {
  let owner: ActorCtx;

  const member = async (name: string, capabilities: Record<string, boolean>) => {
    const actor = await persistActor(WS, { id: "", name, role: "editor", type: "human" });
    const space = (await q<{ id: string }>(
      `SELECT id::text FROM spaces WHERE owner_actor_id = $1 AND kind = 'personal' AND deleted_at IS NULL`, [actor.id])).rows[0]!.id;
    await q(`UPDATE spaces SET capabilities = capabilities || $2::jsonb WHERE id = $1`, [space, JSON.stringify(capabilities)]);
    return { actor, space };
  };
  const rebuilds = async () => (await q(
    `SELECT 1 FROM outbox WHERE workspace_id = $1 AND effect_kind = 'site_rebuild'`, [WS])).rowCount;

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Member removal site', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    await setModulesOn(WS, null);
    owner = await persistActor(WS, { id: "", name: "Owner", role: "admin", type: "human" });
  });

  it("a publishing member's space: SPACE_UPDATED with the previous values, every switch off, and a site rebuild", async () => {
    const bob = await member(`Bob ${randomUUID().slice(0, 6)}`, { publish: true, external_ai: true, backup: true });
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [WS]);

    await removeActor(owner, bob.actor.id);

    const space = (await q<{ kind: string; owner: string | null; name: string; capabilities: Record<string, boolean> }>(
      `SELECT kind, owner_actor_id::text AS owner, name, capabilities FROM spaces WHERE id = $1`, [bob.space])).rows[0]!;
    expect(space).toMatchObject({ kind: "shared", owner: null, name: `${bob.actor.name} (left)` });
    expect(space.capabilities).toMatchObject({ publish: false, external_ai: false, backup: false, shared_seen: false });

    const events = await q<{ event_type: string; actor_id: string; tx_meta: { prev_field_values: Record<string, unknown> }; cause: string | null }>(
      `SELECT e.event_type, e.actor_id::text AS actor_id, e.tx_meta, c.event_type AS cause
         FROM domain_events e LEFT JOIN domain_events c ON c.id = e.triggered_by_event_id
        WHERE e.workspace_id = $1 AND e.target_id = $2 AND e.event_type = 'SPACE_UPDATED'`, [WS, bob.space]);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ actor_id: owner.id, cause: "ACTOR_DELETED" });
    expect(events.rows[0]!.tx_meta.prev_field_values).toMatchObject({
      name: "personal", kind: "personal", owner_actor_id: bob.actor.id,
      capabilities: expect.objectContaining({ publish: true, external_ai: true, backup: true }),
    });
    expect(await rebuilds()).toBe(1);
  });

  it("a member whose space never left the workspace: recorded, but nothing to rebuild", async () => {
    const carol = await member(`Carol ${randomUUID().slice(0, 6)}`, { publish: false, external_ai: false, backup: false });
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [WS]);

    await removeActor(owner, carol.actor.id);

    expect((await q(`SELECT 1 FROM domain_events WHERE target_id = $1 AND event_type = 'SPACE_UPDATED'`, [carol.space])).rowCount).toBe(1);
    expect(await rebuilds()).toBe(0);
  });
});
