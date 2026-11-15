// Drawings for the offline copy. A lean bootstrap leaves drawing values out
// (bootstrap.ts BOOTSTRAP_DEFERRED_ATTRIBUTE_KEYS: the largest values a
// workspace has), so the client fetches them in the background, when idle,
// into its local database: first which readable notes have one, then the
// values in small batches (lib/data/syncEngine downloadDrawingsForOffline).
// Read-gated like every node read; deleted and unreadable notes are absent.

import { q } from "../../db.js";
import type { ActorCtx } from "../../types.js";
import { readableNodeIdSet, restrictRowsToScope } from "../readPolicy.js";
import { withActorReadSnapshot } from "../actorReadSnapshot.js";
import { attributeColumnsSql } from "../syncProjection.js";
import { SyncRequestTooLarge } from "./membership.js";
import { BOOTSTRAP_DEFERRED_ATTRIBUTE_KEYS } from "./bootstrap.js";
import { keptText } from "../patchedValue.js";
import { sha256Hex } from "../../utils.js";
import { makePatch, UUID_SOURCE, type TextPatch } from "@onden/markdown";
import { liveNodeSql } from "../../spine/nodeSql.js";

/** Notes per value request: a drawing can be hundreds of KB. */
export const MAX_DRAWING_IDS = 20;

/** Which readable live notes hold a drawing value, its size in bytes and the
 *  SHA-256 (hex) of its UTF-8 bytes — so a device can tell a stale copy (a
 *  missed delta, a migration with no event) from a current one. */
export async function drawingIndex(authenticated: ActorCtx | null, workspaceId: string): Promise<{ drawings: Array<{ node_id: string; key: string; size: number; hash: string }> }> {
  return withActorReadSnapshot(authenticated, workspaceId, async (actor) => {
    const readableSet = await readableNodeIdSet(actor, workspaceId);
    const res = await q<{ node_id: string; key: string; size: number; hash: string }>(
      `SELECT na.node_id, na.key, octet_length(na.value)::int AS size,
              encode(sha256(convert_to(na.value, 'UTF8')), 'hex') AS hash
       FROM node_attributes na
       JOIN content_nodes n ON n.id = na.node_id AND ${liveNodeSql("n")}
       WHERE na.workspace_id = $1 AND na.key = ANY($2::text[])
       ORDER BY n.updated_at DESC, na.node_id, na.key`,
      [workspaceId, [...BOOTSTRAP_DEFERRED_ATTRIBUTE_KEYS]],
    );
    return { drawings: restrictRowsToScope(res.rows, (r) => r.node_id, readableSet) };
  });
}

/** What a device says it holds: `<node id>:<key>` → SHA-256 (hex) of that
 *  copy, as drawingIndex gives it. */
export type DrawingsHeld = Record<string, string>;
const HELD_KEY = new RegExp(`^${UUID_SOURCE}:[a-z_]{1,64}$`, "i");

/** Whether `value` is a drawings `have` map (shape only; routes/sync.ts). */
export function isDrawingsHeld(value: unknown): value is DrawingsHeld {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= MAX_DRAWING_IDS * BOOTSTRAP_DEFERRED_ATTRIBUTE_KEYS.length &&
    entries.every(([key, hash]) => HELD_KEY.test(key) && typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash));
}

/** A drawing row as sent: the whole `value`, or — when the device said which
 *  copy it holds (`held`) and this server still has that copy among the
 *  note's own versions — only `value_patch`, the change from that copy to the
 *  current value (@onden/markdown textPatch; the device applies it with the
 *  same applyPatch, checking its copy's hash). A patch that would not be
 *  smaller is not sent. */
async function asPatchWhenHeld<T extends { node_id: string; key: string; value: string }>(workspaceId: string, row: T, held: DrawingsHeld): Promise<Omit<T, "value"> & ({ value: string } | { value_patch: TextPatch })> {
  const hash = held[`${row.node_id}:${row.key}`];
  if (!hash) return row;
  const copy = sha256Hex(row.value) === hash ? row.value : await keptText(workspaceId, row.node_id, hash);
  if (copy === null) return row;
  const patch = makePatch(copy, row.value);
  if (JSON.stringify(patch).length >= row.value.length) return row;
  const { value: _whole, ...rest } = row;
  return { ...rest, value_patch: patch };
}

/** The drawing values of the readable live notes among `ids`; those the
 *  device already holds an older copy of (`held`) come as patches when
 *  possible. Throws SyncRequestTooLarge above MAX_DRAWING_IDS. */
export async function drawingsFor(authenticated: ActorCtx | null, workspaceId: string, ids: string[], held: DrawingsHeld = {}) {
  if (ids.length > MAX_DRAWING_IDS) throw new SyncRequestTooLarge(MAX_DRAWING_IDS);
  if (ids.length === 0) return { drawings: [] };
  return withActorReadSnapshot(authenticated, workspaceId, async (actor) => {
    const readableSet = await readableNodeIdSet(actor, workspaceId);
    const res = await q<{ node_id: string; key: string; value: string; value_type: string; is_inheritable: boolean; source: string }>(
      `SELECT ${attributeColumnsSql("na")}
       FROM node_attributes na
       JOIN content_nodes n ON n.id = na.node_id AND ${liveNodeSql("n")}
       WHERE na.workspace_id = $1 AND na.node_id = ANY($2::uuid[]) AND na.key = ANY($3::text[])`,
      [workspaceId, ids, [...BOOTSTRAP_DEFERRED_ATTRIBUTE_KEYS]],
    );
    const rows = restrictRowsToScope(res.rows, (r) => r.node_id, readableSet);
    const drawings = [];
    for (const row of rows) drawings.push(await asPatchWhenHeld(workspaceId, row, held));
    return { drawings };
  });
}
