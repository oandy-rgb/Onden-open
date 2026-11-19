// Spaces (docs/architecture/spaces.md).
//
// Every note lives in one space; membership with a permission (view / edit) is
// the single answer to "who can read and write this". Tags are
// global definitions and never carry permission.
//
// This module manages spaces: listing them, creating and configuring shared
// spaces, membership, and moving notes between spaces. The read/write rule
// itself lives in spaceScope.ts.

import { q } from "../db.js";
import { relinkTarget, syncWikilinkEdges, uniqueSlug } from "./nodes.js";
import { canReadNode } from "./readPolicy.js";
import { canWriteSomewhere, spaceReadableNodeIds, spaceScopeSql } from "../spine/spaceScope.js";
import { hasTaskRefSql } from "../spine/taskIdentity.js";
import { spaceAccess, writableSpaceIds, type StoredSpacePermission } from "../spine/spaceAccess.js";
export { canWriteSomewhere, spaceReadableNodeIds, spaceScopeSql };
import { mutate } from "../spine/mutate.js";
import { assertAuthority, assertKeepsReaders, isTemporarySessionActor, isWorkspaceOwner, requirePerson } from "../spine/authority.js";
import { AuthorityError } from "../spine/mutate.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { spaceAudienceCommitted } from "../spine/nodeHooks.js";
import type { ActorCtx } from "../types.js";
import { subtreeIds } from "./nodeTree.js";
import { SYSTEM_EXTERNAL_ID_SQL } from "../spine/systemActor.js";
import { purgeSpaceDeleted } from "./nodeTrash.js";
import { CodedStatusError } from "../statusError.js";
import type { DeletedNotesChoice, MovePreview, SpaceDeletePreview, SpaceKind, SpacePermission } from "@onden/contract";
import { liveNodeSql, notTagNodeSql } from "../spine/nodeSql.js";
import { isTag } from "@onden/markdown/contract";

export type SpaceRow = {
  id: string;
  name: string;
  kind: SpaceKind;
  is_default: boolean;
  owner_actor_id: string | null;
  capabilities: Record<string, boolean>;
  /** The caller's permission here; null for a shared space the owner manages without being in it. */
  permission: SpacePermission | null;
  /** The caller may change this space's members and switches. */
  can_manage: boolean;
};

/** Where a top-level note lands when nothing names a space: the actor's
 *  personal space, else (the native app's System actor, which has none) the
 *  default space. The one query for that rule; reads through the caller's
 *  transaction. */
async function personalOrDefaultSpaceId(actor: ActorCtx, workspaceId: string): Promise<string | null> {
  const r = await q<{ id: string }>(
    `SELECT id::text FROM spaces
      WHERE workspace_id = $1 AND deleted_at IS NULL
        AND ((owner_actor_id::text = $2 AND kind = 'personal') OR is_default)
      ORDER BY (kind = 'personal') DESC LIMIT 1`, [workspaceId, actor.id]);
  return r.rows[0]?.id ?? null;
}

/** The slug scope (services/nodes.ts uniqueSlug) for a note about to be
 *  created by a path that lets the database place it (mutate's personal-space
 *  setting): under `parentId`, else the creator's personal space, else (the
 *  System actor) the default space. Does not check write access. */
export async function newNoteSlugScope(
  actor: ActorCtx, workspaceId: string, parentId?: string | null,
): Promise<{ parentId: string } | { spaceId: string | null }> {
  if (parentId) return { parentId };
  return { spaceId: isTemporarySessionActor(actor) ? null : await personalOrDefaultSpaceId(actor, workspaceId) };
}

/** Which space a new note goes to — the one rule (docs/architecture/spaces.md,
 *  "新內容落在哪個空間"):
 *    * under a note: that note's space (returns null; the database keeps a
 *      child in its parent's space);
 *    * under a tag, or at the top level: the named space, else the creator's
 *      personal space (the native app's System actor: the default space); an
 *      agent token must name a space unless it may write exactly one — it
 *      never falls back to the shared space.
 *  The caller must be able to write there (AuthorityError otherwise). Call
 *  inside the event lock with the current actor. */
export async function newNoteSpace(
  actor: ActorCtx, workspaceId: string, opts: { parentId?: string | null; spaceId?: string | null } = {},
): Promise<string | null> {
  if (opts.parentId) {
    const parent = (await q<{ node_type: string }>(
      `SELECT node_type FROM content_nodes WHERE id = $1 AND workspace_id = $2`, [opts.parentId, workspaceId])).rows[0];
    if (parent && !isTag(parent)) return null;
  }
  let spaceId = opts.spaceId ?? null;
  // A token and a temporary session have no personal space of their own and never fall back to the shared one: they name a space, or write in the one they may.
  if (!spaceId && !actor.tokenScope && !isTemporarySessionActor(actor)) {
    spaceId = await personalOrDefaultSpaceId(actor, workspaceId);
  }
  if (!spaceId) {
    const writable = await writableSpaceIds(actor);
    if (writable.length !== 1) {
      throw new AuthorityError("space", writable.length ? "name the space for a top-level note (space_id)" : "no space this caller may write");
    }
    spaceId = writable[0]!;
  }
  await assertAuthority(actor, { kind: "space_write", spaceId });
  return spaceId;
}

/** The spaces `actor` belongs to, with their permission in each. */
export async function spacesForActor(actor: ActorCtx, workspaceId: string): Promise<SpaceRow[]> {
  const r = await q<SpaceRow>(
    `SELECT s.id, s.name, s.kind, s.is_default, s.owner_actor_id::text, s.capabilities, m.permission,
            (s.kind = 'personal') AS can_manage
       FROM spaces s JOIN space_members m ON m.space_id = s.id
      WHERE s.workspace_id = $1 AND s.deleted_at IS NULL AND m.actor_id::text = $2
      ORDER BY (s.kind = 'personal') DESC, s.is_default DESC, s.name, s.id`,
    [workspaceId, actor.id],
  );
  // The owner manages every shared space, so they see those they are not in at
  // all through the same list; and shared spaces nobody is in (a removed
  // member's former personal space): to add themselves or someone, or delete
  // it — the space's notes stay unreadable until someone is added.
  if (await isWorkspaceOwner(actor)) {
    for (const row of r.rows) if (row.kind === "shared") row.can_manage = true;
    const orphans = await q<SpaceRow>(
      `SELECT s.id, s.name, s.kind, s.is_default, s.owner_actor_id::text, s.capabilities, NULL AS permission, true AS can_manage
         FROM spaces s
        WHERE s.workspace_id = $1 AND s.deleted_at IS NULL AND s.kind = 'shared'
          AND NOT EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = s.id)
        ORDER BY s.name, s.id`, [workspaceId]);
    return [...r.rows, ...orphans.rows];
  }
  return r.rows;
}

// ── Moving a note to another space ─────────────────────────────────────────
//
// The one write that changes who can see a note (invariant 2). The whole
// subtree moves — children, tasks, trashed descendants — so a child never sits
// in another space than its parent (the deferred trigger in migration 093
// would refuse it anyway). A note with a parent in the source space is
// detached to the target's root; its old parent is remembered for undo.
//
// Who may move: an editor of the target space, and on the source side the
// owner of a personal space or the workspace owner for a shared one (or any
// editor when the space allows `members_can_move_out`). Agents cannot move (spine
// `space` authority refuses tokens). The caller passes the membership epoch
// its confirmation showed; if membership changed since, the move is refused
// (409) so "who will see it" is never stale.


export class SpaceMoveError extends CodedStatusError {
  constructor(status: 403 | 404 | 409, code: string, message: string) { super(status, code, message); }
}

type SpaceMeta = { id: string; name: string; kind: SpaceKind; capabilities: Record<string, boolean>; owner_actor_id: string | null };

async function loadSpace(workspaceId: string, spaceId: string): Promise<SpaceMeta | null> {
  const r = await q<SpaceMeta>(
    `SELECT id::text, name, kind, capabilities, owner_actor_id::text FROM spaces
      WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
    [spaceId, workspaceId],
  );
  return r.rows[0] ?? null;
}

/** Who a person would call a member: the built-in System account is
 *  infrastructure, not someone to list or notify (memberCandidates hides it too). */
async function members(spaceId: string): Promise<Array<{ id: string; name: string; type: "human" | "agent"; permission: SpacePermission }>> {
  const r = await q<{ id: string; name: string; type: "human" | "agent"; permission: SpacePermission }>(
    `SELECT a.id::text, a.name, a.type, m.permission FROM space_members m JOIN actors a ON a.id = m.actor_id
      WHERE m.space_id = $1 AND a.external_id IS DISTINCT FROM ${SYSTEM_EXTERNAL_ID_SQL} AND a.type <> 'session' ORDER BY a.name, a.id`,
    [spaceId],
  );
  return r.rows;
}

async function membershipEpoch(workspaceId: string): Promise<string> {
  const r = await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [workspaceId]);
  return r.rows[0]?.e ?? "0";
}

/** The note's live+trashed subtree, root first: a trashed descendant moves
 *  too, so it comes back in the note's space. Tag definitions are global and
 *  never move. */
function movingIds(workspaceId: string, nodeId: string): Promise<string[]> {
  return subtreeIds(workspaceId, nodeId, { lifecycle: "all", includeRoot: true, skipTagDefinitions: true });
}

async function sourceAuthority(actor: ActorCtx, from: SpaceMeta): Promise<void> {
  // Changing a note's space changes who reads it and what reaches the website: never a temporary session's (spine/authority.ts assertKeepsReaders).
  // Asked first, so the answer is the session's rule, not whichever space permission it happens to lack.
  assertKeepsReaders(actor);
  if (from.kind === "shared" && from.capabilities.members_can_move_out) {
    await assertAuthority(actor, { kind: "space", spaceId: from.id, need: "write" });
  } else {
    await assertAuthority(actor, { kind: "space", spaceId: from.id, need: "manage" });
  }
}

/** What moving `nodeId` to `toSpaceId` would do, for the confirmation. */
export async function previewMove(authenticated: ActorCtx, workspaceId: string, nodeId: string, toSpaceId: string): Promise<MovePreview> {
  const actor = await resolveCurrentActor(authenticated, workspaceId);
  if (!(await canReadNode(actor, nodeId))) throw new SpaceMoveError(404, "not_found", "node not found");
  const node = (await q<{ space_id: string | null; node_type: string }>(
    `SELECT space_id::text, node_type FROM content_nodes WHERE id = $1 AND workspace_id = $2 AND ${liveNodeSql()}`,
    [nodeId, workspaceId])).rows[0];
  if (!node || isTag(node) || !node.space_id) throw new SpaceMoveError(409, "not_movable", "tags are global and have no space");
  const from = await loadSpace(workspaceId, node.space_id);
  const to = await loadSpace(workspaceId, toSpaceId);
  if (!from || !to) throw new SpaceMoveError(404, "not_found", "space not found");
  // The preview names who is in the target space: only for someone who could
  // make this move (editor there, and allowed to move the note out of its
  // space). A space you cannot move into reads as not found.
  try {
    await assertAuthority(actor, { kind: "space", spaceId: to.id, need: "write" });
  } catch (error) {
    if (error instanceof AuthorityError) throw new SpaceMoveError(404, "not_found", "space not found");
    throw error;
  }
  await sourceAuthority(actor, from);
  await assertAuthority(actor, { kind: "node", nodeId, op: "write_node" });
  const [fromMembers, toMembers] = [await members(from.id), await members(to.id)];
  const fromIds = new Set(fromMembers.map((m) => m.id));
  const toIds = new Set(toMembers.map((m) => m.id));
  return {
    node_id: nodeId,
    from: { id: from.id, name: from.name, kind: from.kind },
    to: { id: to.id, name: to.name, kind: to.kind },
    notes: (await movingIds(workspaceId, nodeId)).length,
    gain: toMembers.filter((m) => !fromIds.has(m.id)).map(({ id, name, type }) => ({ id, name, type })),
    lose: fromMembers.filter((m) => !toIds.has(m.id)).map(({ id, name, type }) => ({ id, name, type })),
    membership_epoch: await membershipEpoch(workspaceId),
  };
}

/** Move `nodeId` and its subtree to `toSpaceId`. `expectedEpoch` is the
 *  membership epoch the caller's confirmation showed (null skips the check,
 *  for undo). Returns the number of notes moved. */
export async function moveToSpace(
  authenticated: ActorCtx,
  workspaceId: string,
  nodeId: string,
  toSpaceId: string,
  expectedEpoch: string | null,
  opts: { reattachTo?: string | null; triggeredBy?: string } = {},
): Promise<{ moved: number; from: string; event_id: string }> {
  const result = await withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(authenticated, workspaceId);
    if (!(await canReadNode(actor, nodeId))) throw new SpaceMoveError(404, "not_found", "node not found");
    const node = (await q<{ space_id: string | null; parent_id: string | null; node_type: string; title: string }>(
      `SELECT space_id::text, parent_id::text, node_type, title FROM content_nodes
        WHERE id = $1 AND workspace_id = $2 AND ${liveNodeSql()} FOR UPDATE`,
      [nodeId, workspaceId])).rows[0];
    if (!node || isTag(node) || !node.space_id) throw new SpaceMoveError(409, "not_movable", "tags are global and have no space");
    if (node.space_id === toSpaceId) throw new SpaceMoveError(409, "same_space", "the note is already in that space");
    const from = await loadSpace(workspaceId, node.space_id);
    const to = await loadSpace(workspaceId, toSpaceId);
    if (!from || !to) throw new SpaceMoveError(404, "not_found", "space not found");
    if (expectedEpoch !== null && expectedEpoch !== await membershipEpoch(workspaceId)) {
      throw new SpaceMoveError(409, "audience_changed", "who can see these spaces changed since you confirmed; check again");
    }
    await sourceAuthority(actor, from);
    await assertAuthority(actor, { kind: "node", nodeId, op: "write_node" });
    // Keep the parent only when it is in the TARGET space (undo re-attaching).
    let parentAfter: string | null = null;
    const reattach = opts.reattachTo ?? null;
    if (reattach) {
      const p = (await q<{ space_id: string | null }>(
        `SELECT space_id::text FROM content_nodes WHERE id = $1 AND ${liveNodeSql()}`, [reattach])).rows[0];
      if (p && p.space_id === toSpaceId) parentAfter = reattach;
    }
    const ids = await movingIds(workspaceId, nodeId);
    let eventId = "";
    await mutate({
      actor,
      workspaceId,
      authority: { kind: "space", spaceId: toSpaceId, need: "write" },
      affectsMembership: true,
      event: {
        type: "NODE_MOVED_SPACE",
        targetType: "node",
        targetId: nodeId,
        payload: { title: node.title, from_space_id: from.id, to_space_id: toSpaceId, notes: ids.length },
        txMeta: {
          inverse_op: "node.moved_space",
          prev_field_values: { space_id: from.id, parent_id: node.parent_id },
          ui_context: "space.move",
          ...(opts.triggeredBy ? { restored_from: opts.triggeredBy } : {}),
        },
      },
      apply: async ({ eventId: id }) => {
        eventId = id;
        await q(`UPDATE content_nodes SET parent_id = $2, updated_at = now() WHERE id = $1`, [nodeId, parentAfter]);
        // Slugs are unique per space: a moved note whose slug is taken in the
        // target space gets the next free one there. The slug and the space
        // change in one statement, so the note never holds the new slug while
        // still in the old space (where that slug may be another note's).
        const movedSlugs = await q<{ id: string; slug: string }>(
          `SELECT id::text, slug FROM content_nodes WHERE id = ANY($1::uuid[]) AND ${liveNodeSql()}`, [ids]);
        const assigned = new Set<string>();
        const slugs = new Map<string, string>();
        for (const row of movedSlugs.rows) {
          // Two moved notes may want one free slug (a-2 for "a" and the other's own "a-2").
          let free = await uniqueSlug(workspaceId, row.slug, { spaceId: toSpaceId, excludeId: row.id });
          for (let i = 2; assigned.has(free); i++) free = await uniqueSlug(workspaceId, `${row.slug}-${i}`, { spaceId: toSpaceId, excludeId: row.id });
          assigned.add(free);
          slugs.set(row.id, free);
        }
        await q(
          `UPDATE content_nodes c SET space_id = $2, updated_at = now(), slug = COALESCE(v.slug, c.slug)
             FROM unnest($1::uuid[]) AS i(id)
             LEFT JOIN unnest($3::uuid[], $4::text[]) AS v(id, slug) ON v.id = i.id
            WHERE c.id = i.id`,
          [ids, toSpaceId, [...slugs.keys()], [...slugs.values()]]);
        await relinkAfterMove(workspaceId, ids);
        // One observation per moved descendant, chained to this move: the sync
        // re-ships every node an event targets, so other devices learn each
        // row's new space. Undo moves the whole subtree from the root event;
        // these are skipped by the cascade (no inverse of their own).
        for (const child of ids.slice(1)) {
          await mutate({
            actor, workspaceId,
            authority: { kind: "cascade" },
            event: { type: "NODE_SPACE_CHANGED", targetType: "node", targetId: child,
              payload: { space_id: toSpaceId, moved_with: nodeId } },
            apply: async () => {},
          });
        }
      },
    });
    // In the move's transaction: modules whose output follows a note's space
    // (the published site) record their follow-up with it.
    await spaceAudienceCommitted({ workspaceId, actor: authenticated });
    return { moved: ids.length, from: from.id, event_id: eventId };
  });
  return result;
}

/** [[title]] links resolve within a space: after a move, drop wikilink edges
 *  that now cross spaces and resolve the moved notes' links (out and in) in
 *  their new space. */
async function relinkAfterMove(workspaceId: string, ids: string[]): Promise<void> {
  await q(
    `DELETE FROM node_edges e
      USING content_nodes s, content_nodes t
      WHERE e.workspace_id = $1 AND e.origin = 'wikilink'
        AND s.id = e.source_node_id AND t.id = e.target_node_id
        AND (e.source_node_id = ANY($2::uuid[]) OR e.target_node_id = ANY($2::uuid[]))
        AND ${notTagNodeSql("t")} AND s.space_id IS DISTINCT FROM t.space_id`,
    [workspaceId, ids]);
  const moved = await q<{ id: string; markdown: string | null }>(
    `SELECT id::text, markdown FROM content_nodes WHERE id = ANY($1::uuid[]) AND ${liveNodeSql()}`, [ids]);
  for (const n of moved.rows) await syncWikilinkEdges(workspaceId, n.id, n.markdown ?? "");
  await relinkTarget(workspaceId, moved.rows.map((n) => n.id));
}

// ── Managing spaces ─────────────────────────────────────────────────────────
//
// Only the workspace owner creates shared spaces, names them, sets their
// capabilities and manages their members (docs/architecture/proposals/
// roles-owner-member-2026-10-22.md decisions 2, 3). A personal space has
// exactly its owner and no one else, and its switches are theirs.

const CAPABILITY_KEYS = ["publish", "external_ai", "backup", "shared_seen", "members_can_move_out"] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
export const isCapabilityKey = (k: string): k is CapabilityKey => (CAPABILITY_KEYS as readonly string[]).includes(k);

export async function createSharedSpace(authenticated: ActorCtx, workspaceId: string, name: string, opts: { id?: string } = {}): Promise<{ id: string }> {
  return withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(authenticated, workspaceId);
    requirePerson(actor, "space");
    let spaceId = "";
    await mutate({
      actor, workspaceId,
      authority: { kind: "principal_admin" },
      affectsMembership: true,
      event: { type: "SPACE_CREATED", targetType: "space", targetId: (r: { id: string }) => r.id, payload: { name } },
      timing: "after",
      apply: async () => {
        const r = await q<{ id: string }>(
          `INSERT INTO spaces (id, workspace_id, name, kind, capabilities)
           VALUES (COALESCE($3::uuid, gen_random_uuid()), $1, $2, 'shared', '{"publish": false, "external_ai": false, "backup": true, "shared_seen": false}'::jsonb)
           RETURNING id::text`,
          [workspaceId, name, opts.id ?? null],
        );
        spaceId = r.rows[0]!.id;
        // The owner reads a shared space only as a member (decision 8): the one
        // who creates it starts in it.
        await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2::uuid, 'edit')`, [spaceId, actor.id]);
        return { id: spaceId };
      },
    });
    return { id: spaceId };
  });
}

export async function updateSpace(
  authenticated: ActorCtx, workspaceId: string, spaceId: string,
  changes: { name?: string; capabilities?: Partial<Record<CapabilityKey, boolean>> },
): Promise<void> {
  let egressSwitched = false;
  await withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(authenticated, workspaceId);
    const space = await loadSpace(workspaceId, spaceId);
    if (!space) throw new SpaceMoveError(404, "not_found", "space not found");
    // A personal space's switches belong to its owner alone.
    if (space.kind === "personal" && space.owner_actor_id !== actor.id) throw new SpaceMoveError(404, "not_found", "space not found");
    // The site is the workspace owner's (owner 2026-11-14): a member's personal
    // space cannot be switched onto it (switching it off stays allowed). The
    // served set ignores such a space regardless (spaceScope.publishableSpaceNodeIds).
    if (space.kind === "personal" && changes.capabilities?.publish === true && space.capabilities.publish !== true && !(await isWorkspaceOwner(actor))) {
      throw new SpaceMoveError(403, "owner_only", "only the workspace owner can put a space on the site");
    }
    const caps = { ...space.capabilities, ...(changes.capabilities ?? {}) };
    const switched = (key: CapabilityKey) =>
      changes.capabilities?.[key] !== undefined && (caps[key] === true) !== (space.capabilities[key] === true);
    // external_ai decides what agent tokens read, publish what anonymous
    // readers see: flipping either changes someone's readable set.
    const audienceChanged = switched("external_ai") || switched("publish");
    egressSwitched = audienceChanged || switched("backup");
    await mutate({
      actor, workspaceId,
      authority: { kind: "space", spaceId, need: "manage" },
      affectsMembership: audienceChanged,
      event: { type: "SPACE_UPDATED", targetType: "space", targetId: spaceId,
        payload: { ...(changes.name ? { name: changes.name } : {}), ...(changes.capabilities ? { capabilities: changes.capabilities } : {}) },
        txMeta: { prev_field_values: { name: space.name, capabilities: space.capabilities } } },
      apply: async () => {
        await q(`UPDATE spaces SET name = COALESCE($2, name), capabilities = $3 WHERE id = $1`,
          [spaceId, changes.name ?? null, JSON.stringify(caps)]);
      },
    });
    if (egressSwitched) await spaceAudienceCommitted({ workspaceId, actor: authenticated });
  });
}

/** Every switch a left member's space loses. */
const ORPHANED_CAPABILITIES = { publish: false, external_ai: false, backup: false, shared_seen: false } as const;

/** A removed member's personal space would be left with no owner and no
 *  member, its notes out of every API's reach. It becomes a shared space
 *  nobody is in, named "<name> (left)", with every switch off; the owner sees
 *  it in Settings › Spaces and decides (add someone, or delete it).
 *
 *  Called by services/actors.ts removeActor INSIDE its ACTOR_DELETED
 *  mutation's apply: each space change is a nested SPACE_UPDATED (triggered
 *  by the removal, with prev_field_values like updateSpace), and a space
 *  whose publish, external_ai or backup was on tells the space-audience hook
 *  in the same transaction, so the website module takes the leaver's pages
 *  off the static host at once (D118). */
export async function orphanPersonalSpace(
  actor: ActorCtx, workspaceId: string, ownerActorId: string, ownerName: string,
): Promise<void> {
  const spaces = await q<{ id: string; name: string; capabilities: Record<string, unknown> }>(
    `SELECT id::text, name, capabilities FROM spaces
      WHERE workspace_id = $1 AND owner_actor_id = $2 AND kind = 'personal' AND deleted_at IS NULL`,
    [workspaceId, ownerActorId]);
  let egressSwitched = false;
  for (const space of spaces.rows) {
    const name = `${ownerName} (left)`;
    const caps = { ...space.capabilities, ...ORPHANED_CAPABILITIES };
    const wasOn = (key: CapabilityKey) => space.capabilities[key] === true;
    const audienceChanged = wasOn("publish") || wasOn("external_ai");
    egressSwitched ||= audienceChanged || wasOn("backup");
    await mutate({
      actor, workspaceId,
      authority: { kind: "cascade" }, // the removal's principal_admin check covers it
      affectsMembership: audienceChanged,
      event: { type: "SPACE_UPDATED", targetType: "space", targetId: space.id,
        payload: { name, capabilities: ORPHANED_CAPABILITIES, kind: "shared", owner_left: ownerActorId },
        txMeta: { prev_field_values: { name: space.name, capabilities: space.capabilities, kind: "personal", owner_actor_id: ownerActorId } } },
      apply: async () => {
        await q(`UPDATE spaces SET kind = 'shared', owner_actor_id = NULL, name = $2, capabilities = $3 WHERE id = $1`,
          [space.id, name, JSON.stringify(caps)]);
      },
    });
  }
  if (egressSwitched) await spaceAudienceCommitted({ workspaceId, actor });
}

export async function listMembers(authenticated: ActorCtx, workspaceId: string, spaceId: string) {
  const actor = await resolveCurrentActor(authenticated, workspaceId);
  await assertAuthority(actor, { kind: "space", spaceId, need: "read" });
  return members(spaceId);
}

/** Who the owner can add to a shared space: the workspace's people and its
 *  agents (an agent's tokens reach the spaces the agent belongs to). Names
 *  only; the full roster with tokens stays owner-only. */
export async function memberCandidates(authenticated: ActorCtx, workspaceId: string, spaceId: string) {
  const actor = await resolveCurrentActor(authenticated, workspaceId);
  await assertAuthority(actor, { kind: "space", spaceId, need: "manage" });
  const r = await q<{ id: string; name: string; type: string }>(
    `SELECT id::text, name, type FROM actors
      WHERE workspace_id = $1 AND external_id IS DISTINCT FROM ${SYSTEM_EXTERNAL_ID_SQL} AND type <> 'session' ORDER BY type DESC, name, id`, [workspaceId]);
  return r.rows;
}

/** Set (permission) or remove (null) a member. */
export async function setMember(
  authenticated: ActorCtx, workspaceId: string, spaceId: string, memberId: string, permission: StoredSpacePermission | null,
): Promise<void> {
  await withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(authenticated, workspaceId);
    const space = await loadSpace(workspaceId, spaceId);
    if (!space) throw new SpaceMoveError(404, "not_found", "space not found");
    if (space.kind === "personal") throw new SpaceMoveError(409, "personal_space", "a personal space has only its owner");
    if (space.kind === "system") throw new SpaceMoveError(409, "system_space", "the system space has no members to manage");
    const target = (await q<{ id: string }>(`SELECT id::text FROM actors WHERE id::text = $1 AND workspace_id = $2`, [memberId, workspaceId])).rows[0];
    if (!target) throw new SpaceMoveError(404, "not_found", "member not found");
    const previous = (await q<{ permission: StoredSpacePermission }>(
      `SELECT permission FROM space_members WHERE space_id = $1 AND actor_id::text = $2`, [spaceId, memberId])).rows[0]?.permission ?? null;
    await mutate({
      actor, workspaceId,
      authority: { kind: "space", spaceId, need: "manage" },
      affectsMembership: true,
      event: { type: "SPACE_MEMBER_SET", targetType: "space", targetId: spaceId,
        payload: { actor_id: memberId, permission, previous_permission: previous } },
      apply: async () => {
        if (permission === null) await q(`DELETE FROM space_members WHERE space_id = $1 AND actor_id::text = $2`, [spaceId, memberId]);
        else await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2::uuid, $3)
                      ON CONFLICT (space_id, actor_id) DO UPDATE SET permission = EXCLUDED.permission`, [spaceId, memberId, permission]);
      },
    });
  });
}

const sameIdSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

async function deletableSpace(actor: ActorCtx, workspaceId: string, spaceId: string): Promise<SpaceMeta> {
  // A temporary session must not be able to tell a space it cannot read from one that is not there. (A member keeps the 403 they have always had.)
  if (isTemporarySessionActor(actor)) {
    const access = await spaceAccess(actor, spaceId);
    if (!access || (!access.read && !access.manage)) throw new SpaceMoveError(404, "not_found", "space not found");
  }
  const space = await loadSpace(workspaceId, spaceId);
  if (!space) throw new SpaceMoveError(404, "not_found", "space not found");
  if (space.kind !== "shared") throw new SpaceMoveError(409, "not_deletable", "only a shared space can be deleted");
  const isDefault = (await q(`SELECT 1 FROM spaces WHERE id = $1 AND is_default`, [spaceId])).rows.length > 0;
  if (isDefault) throw new SpaceMoveError(409, "default_space", "the default space cannot be deleted");
  await assertAuthority(actor, { kind: "space", spaceId, need: "manage" });
  return space;
}

async function personalSpaceOf(workspaceId: string, actor: ActorCtx): Promise<string | null> {
  const r = await q<{ id: string }>(
    `SELECT id::text FROM spaces WHERE workspace_id = $1 AND kind = 'personal' AND owner_actor_id::text = $2 AND deleted_at IS NULL`,
    [workspaceId, actor.id]);
  return r.rows[0]?.id ?? null;
}

async function spaceContents(workspaceId: string, spaceId: string) {
  const live = await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM content_nodes
      WHERE workspace_id = $1 AND space_id = $2 AND ${liveNodeSql()} AND ${notTagNodeSql()}`,
    [workspaceId, spaceId]);
  const deleted = await q<{ id: string; title: string; task: boolean }>(
    `SELECT n.id::text, n.title,
            ${hasTaskRefSql("n")} AS task
       FROM content_nodes n
      WHERE n.workspace_id = $1 AND n.space_id = $2 AND n.deleted_at IS NOT NULL AND ${notTagNodeSql("n")}
      ORDER BY n.deleted_at, n.id`,
    [workspaceId, spaceId]);
  // Subscriptions are settings in a table (migration 145); deleting the space would
  // leave them fetching into nowhere, so like live notes they must be moved or cancelled first.
  const subscriptions = await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM rss_subscriptions WHERE workspace_id = $1 AND space_id = $2`,
    [workspaceId, spaceId]);
  return { live: Number(live.rows[0]?.n ?? 0), subscriptions: Number(subscriptions.rows[0]?.n ?? 0), deleted: deleted.rows };
}

/** What deleting `spaceId` would meet (SpaceDeletePreview), with the same
 *  checks as deleteSpace: the owner. */
export async function previewSpaceDelete(authenticated: ActorCtx, workspaceId: string, spaceId: string): Promise<SpaceDeletePreview> {
  return withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(authenticated, workspaceId);
    await deletableSpace(actor, workspaceId, spaceId);
    const contents = await spaceContents(workspaceId, spaceId);
    return {
      live_notes: contents.live,
      subscriptions: contents.subscriptions,
      deleted_notes: contents.deleted.filter((row) => !row.task).map(({ id, title }) => ({ id, title })),
      deleted_count: contents.deleted.length,
      deleted_ids: contents.deleted.map((row) => row.id),
      can_move_to_personal: (await personalSpaceOf(workspaceId, actor)) !== null,
    };
  });
}

/** Delete a shared space with no live notes. Its deleted notes, if any, need
 *  `deletedNotes`: "purge" deletes them for good first (NODES_PURGED, the
 *  same erasure as History's 永久刪除), "move" moves them to the deleter's
 *  personal space, still deleted and restorable from History. Then
 *  SPACE_DELETED; all in one transaction. Needs the owner. Throws SpaceMoveError 409 not_empty (live notes), has_subscriptions (RSS feeds), deleted_notes
 *  (deleted notes and no choice), plan_changed ("purge" whose
 *  `expectedDeletedIds` are not exactly its deleted rows now), no_personal_space ("move" by someone
 *  without one), not_deletable / default_space, 404 not_found. */
export async function deleteSpace(
  authenticated: ActorCtx, workspaceId: string, spaceId: string,
  opts: { deletedNotes?: DeletedNotesChoice; expectedDeletedIds?: readonly string[] } = {},
): Promise<{ purged: number; moved: number }> {
  return withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(authenticated, workspaceId);
    const space = await deletableSpace(actor, workspaceId, spaceId);
    const contents = await spaceContents(workspaceId, spaceId);
    if (contents.live > 0) {
      throw new SpaceMoveError(409, "not_empty", "move or delete the notes in this space first");
    }
    if (contents.subscriptions > 0) {
      throw new SpaceMoveError(409, "has_subscriptions", "move the feeds in this space elsewhere or unsubscribe first");
    }
    let purged = 0;
    let moved = 0;
    let movedTo: string | null = null;
    if (contents.deleted.length > 0) {
      if (!opts.deletedNotes) {
        throw new SpaceMoveError(409, "deleted_notes", "choose what happens to the space's deleted notes");
      }
      if (opts.deletedNotes === "purge") {
        // Nothing the person did not see goes for good (SpaceDeletePreview.deleted_ids).
        if (opts.expectedDeletedIds !== undefined && !sameIdSet(opts.expectedDeletedIds, contents.deleted.map((row) => row.id))) {
          throw new SpaceMoveError(409, "plan_changed", "the space's deleted notes changed since the confirmation; check again");
        }
        purged = (await purgeSpaceDeleted(actor, workspaceId, spaceId)).purged;
      } else {
        movedTo = await personalSpaceOf(workspaceId, actor);
        if (!movedTo) throw new SpaceMoveError(409, "no_personal_space", "you have no personal space to move them to");
        // Every row moves (a deleted subtree stays whole: content_nodes_check_space);
        // slugs are unique among live notes only, so none clashes. Restoring
        // one later finds it a free slug there (nodeTrash.ts markLive).
        const r = await q(
          `UPDATE content_nodes SET space_id = $3 WHERE workspace_id = $1 AND space_id = $2 AND deleted_at IS NOT NULL`,
          [workspaceId, spaceId, movedTo]);
        moved = r.rowCount ?? 0;
      }
    }
    await mutate({
      actor, workspaceId,
      authority: { kind: "space", spaceId, need: "manage" },
      affectsMembership: true,
      event: {
        type: "SPACE_DELETED", targetType: "space", targetId: spaceId,
        payload: {
          name: space.name,
          ...(purged > 0 ? { deleted_notes: "purged", purged } : {}),
          ...(moved > 0 ? { deleted_notes: "moved", moved, moved_to_space_id: movedTo } : {}),
        },
      },
      apply: async () => { await q(`UPDATE spaces SET deleted_at = now() WHERE id = $1`, [spaceId]); },
    });
    return { purged, moved };
  });
}
