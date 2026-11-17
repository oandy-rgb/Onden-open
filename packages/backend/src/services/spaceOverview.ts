// What every member can actually do in every shared space, and the first thing
// that stops an agent where it cannot (roles proposal §5). For the owner's
// "Spaces and members" screen: one read in one snapshot, so a screen never mixes
// two states of the workspace.
//
// The reach shown for an agent is the gate's own answer (spaceAccessSql with a
// token context whose access is write when any live token is), and the reasons
// are derived from the same facts (spaceAccess.ts explainAccess) — there is no
// second copy of the rule here. Personal spaces never appear: the owner does not
// see anyone's personal space, its name or its members (spaces.md invariant).

import { q } from "../db.js";
import { assertAuthority } from "../spine/authority.js";
import type { ActorCtx } from "../types.js";
import { withActorReadSnapshot } from "./actorReadSnapshot.js";
import { explainAccess, spaceAccessSql } from "../spine/spaceAccess.js";
import { SYSTEM_EXTERNAL_ID_SQL } from "../spine/systemActor.js";
import type { AccessBlock, EffectiveReach, OverviewMember, SpaceOverview, SpacePermission } from "@onden/contract";

/** The owner's overview of shared spaces and members. Owner only (403). */
export async function spaceOverview(authenticated: ActorCtx | null, workspaceId: string): Promise<SpaceOverview> {
  return withActorReadSnapshot(authenticated, workspaceId, async (actor) => {
    await assertAuthority(actor, { kind: "principal_admin" });
    const owner = (await q<{ owner_actor_id: string | null }>(`SELECT owner_actor_id::text FROM workspaces WHERE id = $1`, [workspaceId])).rows[0]?.owner_actor_id ?? null;
    const spaces = (await q<{ id: string; name: string; is_default: boolean; capabilities: Record<string, boolean> }>(
      `SELECT id::text, name, is_default, capabilities FROM spaces
        WHERE workspace_id = $1 AND kind = 'shared' AND deleted_at IS NULL ORDER BY is_default DESC, name, id`, [workspaceId])).rows;
    const members = (await q<{ space_id: string; actor_id: string; name: string; type: "human" | "agent"; permission: SpacePermission }>(
      `SELECT m.space_id::text, a.id::text AS actor_id, a.name, a.type, m.permission
         FROM space_members m JOIN actors a ON a.id = m.actor_id JOIN spaces s ON s.id = m.space_id
        WHERE s.workspace_id = $1 AND s.kind = 'shared' AND s.deleted_at IS NULL
          AND a.external_id IS DISTINCT FROM ${SYSTEM_EXTERNAL_ID_SQL} AND a.type <> 'session'
        ORDER BY a.type DESC, a.name, a.id`, [workspaceId])).rows;
    const tokens = new Map((await q<{ actor_id: string; live: string; writes: string }>(
      `SELECT t.actor_id::text, count(*)::text AS live, count(*) FILTER (WHERE t.access = 'write')::text AS writes
         FROM agent_tokens t JOIN actors a ON a.id = t.actor_id
        WHERE a.workspace_id = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > statement_timestamp())
        GROUP BY t.actor_id`, [workspaceId])).rows.map((r) => [r.actor_id, { live: Number(r.live), writes: Number(r.writes) }]));
    const agents = (await q<{ id: string; name: string }>(
      `SELECT id::text, name FROM actors WHERE workspace_id = $1 AND type = 'agent' AND external_id IS DISTINCT FROM ${SYSTEM_EXTERNAL_ID_SQL} ORDER BY name, id`,
      [workspaceId])).rows;

    // The gate's answer per agent: a synthetic token context, access write when
    // any live token is. An agent with no live token reaches nothing.
    const gate = new Map<string, Map<string, { read: boolean; write: boolean }>>();
    for (const agent of agents) {
      const t = tokens.get(agent.id);
      if (!t) continue;
      const ctx: ActorCtx = { id: agent.id, name: agent.name, type: "agent",
        tokenScope: { tokenId: "overview", allowedTools: null, access: t.writes > 0 ? "write" : "read", writeMode: "apply", expiresAt: null } };
      const params: unknown[] = [];
      const rows = (await q<{ space_id: string; can_read: boolean; can_write: boolean | null }>(
        `SELECT space_id::text, can_read, can_write FROM (${spaceAccessSql(ctx, params)}) x`, params)).rows;
      gate.set(agent.id, new Map(rows.map((r) => [r.space_id, { read: r.can_read, write: r.can_write === true }])));
    }
    const reach = (flag: boolean, why: AccessBlock | null): EffectiveReach => ({ ok: flag, blocked_by: why });

    const byId = new Map(spaces.map((s) => [s.id, s]));
    const overviewMembers = new Map<string, OverviewMember[]>(spaces.map((s) => [s.id, []]));
    const placed = new Set<string>();
    for (const m of members) {
      placed.add(m.actor_id);
      const row: OverviewMember = { actor_id: m.actor_id, name: m.name, type: m.type, permission: m.permission };
      if (m.type === "agent") {
        const t = tokens.get(m.actor_id) ?? { live: 0, writes: 0 };
        const g = gate.get(m.actor_id)?.get(m.space_id) ?? { read: false, write: false };
        const { readBlockedBy, writeBlockedBy } = explainAccess(
          { liveTokens: t.live, writeTokens: t.writes, externalAi: byId.get(m.space_id)!.capabilities.external_ai === true, permission: m.permission }, g);
        row.effective = { read: reach(g.read, readBlockedBy), write: reach(g.write, writeBlockedBy) };
      }
      overviewMembers.get(m.space_id)!.push(row);
    }

    const people = (await q<{ id: string; name: string; type: "human" | "agent"; invite_pending: boolean }>(
      `SELECT id::text, name, type, (type = 'human' AND external_id IS NULL AND invite_email IS NOT NULL) AS invite_pending
         FROM actors WHERE workspace_id = $1 AND external_id IS DISTINCT FROM ${SYSTEM_EXTERNAL_ID_SQL} AND type <> 'session' ORDER BY type DESC, name, id`, [workspaceId])).rows;
    return {
      owner_id: owner,
      spaces: spaces.map((s) => ({ id: s.id, name: s.name, kind: "shared" as const, is_default: s.is_default, capabilities: s.capabilities, members: overviewMembers.get(s.id)! })),
      unplaced: people.filter((p) => !placed.has(p.id)).map((p) => ({
        actor_id: p.id, name: p.name, type: p.type, spaces: 0 as const, invite_pending: p.invite_pending,
        ...(p.type === "agent" ? { blocked_by: (tokens.get(p.id)?.live ?? 0) === 0 ? "no_live_token" as const : "not_member" as const } : {}),
      })),
      agents: agents.map((a) => ({ actor_id: a.id, live_tokens: tokens.get(a.id)?.live ?? 0, write_tokens: tokens.get(a.id)?.writes ?? 0 })),
    };
  });
}
