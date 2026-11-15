import { applyPatch, isTextPatch, TextPatchError, type TextPatch } from "@onden/markdown";
import { q } from "../db.js";
import { sha256Hex } from "../utils.js";
import { CodedStatusError, StatusError } from "../statusError.js";

// The one place a writer's `X_patch` becomes the value it stands for
// (docs/architecture/patch-writes.md). A patch's base is the writer's merge
// base — the text its edit was made from — so resolving it yields both sides
// the existing merge needs: `incoming` (the text being saved) and `base`.
// Callers hand those to the merge they always ran (diff3 for a body, mergeInk
// / mergePageText / mergePageImages for a drawing's layers); nothing here
// merges.

/** The patch names a base this server cannot give back (neither the stored
 *  value nor a version kept for this note). The writer answers by sending the
 *  whole value once. HTTP 409 `patch_base_unknown`. */
export class PatchBaseUnknown extends StatusError {
  constructor() { super(409, "patch_base_unknown"); }
}

/** The patch is not one this server can apply (bad shape, outside the base). HTTP 400 `invalid_patch`. */
export class PatchInvalid extends CodedStatusError {
  constructor(reason: string) { super(400, "invalid_patch", `invalid_patch:${reason}`); }
}

const EMPTY_HASH = sha256Hex("");

/** A text kept for `nodeId` whose hash is `hash`: a body version or a drawing
 *  value its history names. Only the node's own history is searched, so a hash
 *  seen elsewhere cannot be used to read another note's content. */
export async function keptText(workspaceId: string, nodeId: string, hash: string): Promise<string | null> {
  const found = await q<{ content: string }>(
    `SELECT b.content FROM blobs b
      WHERE b.hash = $1
        AND EXISTS (
          SELECT 1 FROM domain_events e
           WHERE e.workspace_id = $2 AND e.target_id = $3
             AND $1 IN (e.payload->>'body_hash', e.payload->>'value_ref', e.tx_meta->'prev_field_values'->>'value_ref'))`,
    [hash, workspaceId, nodeId],
  );
  return found.rows[0]?.content ?? null;
}

/** The text `patch` describes and the text it was made from. `current` is the
 *  value stored now (null: none), read by the caller under its lock; the base
 *  is that when its hash matches (the usual case), else a version kept for the
 *  note. Throws PatchBaseUnknown / PatchInvalid.
 *
 *  The result holds the limits a whole value would have met in its schema
 *  (no NUL, `maxLength` when given).
 *
 *  resolvePatched(ws, nodeId, row.markdown, rawBody.markdown_patch, { maxLength: NODE_MARKDOWN_MAX }) */
export async function resolvePatched(
  workspaceId: string, nodeId: string, current: string | null, patch: unknown, { maxLength }: { maxLength?: number } = {},
): Promise<{ incoming: string; base: string }> {
  if (!isTextPatch(patch)) throw new PatchInvalid("malformed");
  const base = await baseText(workspaceId, nodeId, current ?? "", patch);
  let incoming: string;
  try {
    incoming = applyPatch(base, patch, sha256Hex);
  } catch (error) {
    if (error instanceof TextPatchError) throw new PatchInvalid(error.reason);
    throw error;
  }
  if (incoming.includes("\u0000")) throw new PatchInvalid("contains_nul");
  if (maxLength !== undefined && incoming.length > maxLength) throw new PatchInvalid("too_long");
  return { incoming, base };
}

async function baseText(workspaceId: string, nodeId: string, current: string, patch: TextPatch): Promise<string> {
  if (patch.base_hash === EMPTY_HASH) return "";
  if (sha256Hex(current) === patch.base_hash) return current;
  const kept = await keptText(workspaceId, nodeId, patch.base_hash);
  if (kept === null) throw new PatchBaseUnknown();
  return kept;
}
