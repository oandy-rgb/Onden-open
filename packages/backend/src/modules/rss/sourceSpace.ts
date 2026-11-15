// Where subscriptions live: the workspace setting `rss_source_space`
// (Settings › Modules › RSS, 「訂閱放在」). A space id puts new subscriptions in
// that shared space, so its members see the feeds and their articles (and, if
// the space turned on shared_seen, read them together — staging.ts markSeen);
// empty or absent means each person's own personal space (the default).
//
// The setting is stored like the other workspace settings (the Site Config
// note's attributes) but changed only through changeSourceSpace: one owner-only
// transaction writes the setting and moves the owner's existing subscriptions
// (sources.ts moveSources), so the setting and where the subscriptions sit never
// disagree after a failure. Which subscriptions move is planMove.

import { isUuid } from "@onden/markdown";
import { q } from "../../db.js";
import type { ActorCtx } from "../../types.js";
import { assertAuthority } from "../../spine/authority.js";
import { requireActor } from "../../spine/mutate.js";
import { withEventTransaction } from "../../spine/eventTransaction.js";
import { readableSpaceScopeSql } from "../../services/readPolicy.js";
import { resolveCurrentActor } from "../../spine/currentActor.js";
import { findConfigNodeId } from "../../services/siteConfig.js";
import { spaceAccess } from "../../spine/spaceAccess.js";
import { updateWorkspaceConfig } from "../../services/workspaceSettings.js";
import { moveSources } from "./sources.js";
import { feedUrlKey } from "./feedUrl.js";

export const SOURCE_SPACE_KEY = "rss_source_space";

/** A target that cannot hold subscriptions: not a live shared space here. */
export class SourceSpaceError extends Error {
  readonly status = 422;
  readonly code = "space_not_found";
  constructor() { super("the space does not exist or is not a shared space"); }
}

/** The configured space id, or null when each person's own space applies. */
export async function configuredSourceSpace(workspaceId: string): Promise<string | null> {
  const config = await findConfigNodeId(workspaceId);
  if (!config) return null;
  const row = (await q<{ value: string }>(
    `SELECT value FROM node_attributes WHERE node_id = $1 AND key = $2`, [config, SOURCE_SPACE_KEY])).rows[0];
  const value = row?.value.trim() ?? "";
  return isUuid(value) ? value : null;
}

/** The space a new subscription by `actor` goes to: the configured one when
 *  they can write there, else null (createNote then picks their own personal
 *  space). A stale setting (space deleted) also reads as null. */
export async function sourceSpaceFor(actor: ActorCtx, workspaceId: string): Promise<string | null> {
  const configured = await configuredSourceSpace(workspaceId);
  if (!configured) return null;
  const access = await spaceAccess(actor, configured);
  return access?.write ? configured : null;
}

type MovePlan = { move: string[]; skippedDuplicate: number };

/** What a change of setting to `toSpaceId` does to the owner's subscriptions.
 *  Candidates: those the owner can read AND created themselves
 *  (created_by_actor_id) that sit in the old configured space or in the owner's
 *  own personal space — never another member's subscription, even one in the
 *  old shared space (they may not be in the new one, and would lose sight of
 *  it), and never one already in `toSpaceId`. A candidate whose feed the target
 *  space already follows (feedUrlKey) is NOT moved — it would fetch twice and
 *  show every article twice — and is counted in `skippedDuplicate`; the notes
 *  saved from it stay where they are. Call inside the event lock with the
 *  current owner. */
async function planMove(owner: ActorCtx, workspaceId: string, toSpaceId: string): Promise<MovePlan> {
  const old = await configuredSourceSpace(workspaceId);
  const params: unknown[] = [workspaceId, owner.id, toSpaceId, old];
  const scope = readableSpaceScopeSql(owner, "r", params);
  const candidates = await q<{ id: string; url: string }>(
    `SELECT r.id::text, r.url FROM rss_subscriptions r
       JOIN spaces s ON s.id = r.space_id
      WHERE r.workspace_id = $1 AND ${scope}
        AND r.space_id IS DISTINCT FROM $3::uuid
        AND ((r.space_id = $4::uuid AND r.created_by_actor_id::text = $2)
             OR (s.kind = 'personal' AND s.owner_actor_id::text = $2))
      ORDER BY r.created_at, r.id`, params);
  // Duplicate identity looks at every subscription in the target, whoever made it.
  const taken = new Set((await q<{ url: string }>(
    `SELECT url FROM rss_subscriptions WHERE workspace_id = $1 AND space_id = $2::uuid`, [workspaceId, toSpaceId]))
    .rows.map((row) => feedUrlKey(row.url)).filter((key): key is string => key !== null));
  const plan: MovePlan = { move: [], skippedDuplicate: 0 };
  for (const row of candidates.rows) {
    const key = feedUrlKey(row.url);
    if (key !== null && taken.has(key)) { plan.skippedDuplicate++; continue; }
    if (key !== null) taken.add(key); // two movers of one feed: the first goes, the rest are duplicates
    plan.move.push(row.id);
  }
  return plan;
}

async function assertSharedSpace(workspaceId: string, spaceId: string): Promise<void> {
  const r = await q(
    `SELECT 1 FROM spaces WHERE id = $1 AND workspace_id = $2 AND kind = 'shared' AND deleted_at IS NULL`, [spaceId, workspaceId]);
  if (!r.rows.length) throw new SourceSpaceError();
}

/** How many subscriptions changing the setting to `spaceId` would move, and
 *  how many would stay because that space already follows the feed, for the
 *  owner's confirmation. Owner only (403 otherwise). */
export async function previewMovableSources(
  authenticated: ActorCtx | null, workspaceId: string, spaceId: string,
): Promise<{ movable: number; skipped_duplicate: number }> {
  const owner = await resolveCurrentActor(requireActor(authenticated), workspaceId);
  await assertAuthority(owner, { kind: "principal_admin" });
  if (!spaceId) return { movable: 0, skipped_duplicate: 0 };
  await assertSharedSpace(workspaceId, spaceId);
  const plan = await planMove(owner, workspaceId, spaceId);
  return { movable: plan.move.length, skipped_duplicate: plan.skippedDuplicate };
}

/** Set `rss_source_space` (empty = each person's own space) and move the
 *  owner's own subscriptions into the new space (not ones already followed
 *  there), in ONE transaction: the setting event and the moves commit or roll
 *  back together. Choosing the empty setting moves nothing: subscriptions stay
 *  where they are. Owner only. A subscription's stream follows it; saved
 *  articles are separate notes and stay where they are. */
export async function changeSourceSpace(
  authenticated: ActorCtx | null, workspaceId: string, spaceId: string,
): Promise<{ space_id: string; moved: number; skipped_duplicate: number }> {
  return withEventTransaction(workspaceId, async () => {
    const owner = await resolveCurrentActor(requireActor(authenticated), workspaceId);
    await assertAuthority(owner, { kind: "principal_admin" });
    if (spaceId) await assertSharedSpace(workspaceId, spaceId);
    const plan = spaceId ? await planMove(owner, workspaceId, spaceId) : { move: [], skippedDuplicate: 0 };
    await updateWorkspaceConfig(owner, workspaceId, { config: { [SOURCE_SPACE_KEY]: spaceId } });
    await moveSources(workspaceId, plan.move, spaceId);
    return { space_id: spaceId, moved: plan.move.length, skipped_duplicate: plan.skippedDuplicate };
  });
}
