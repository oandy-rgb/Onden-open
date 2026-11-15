// "Which notes can this actor see here": the one SQL condition History uses to
// scope a query over content_nodes — readable live notes, optionally the
// retained (最近刪除) ones they can read, optionally inside one space. The read
// rules themselves are readPolicy's (readableScopeSql, readableTrashedNodeIds);
// this only combines them, so "space" or "readable" meaning something new is
// one change, not one per History page.

import type { ActorCtx } from "../../types.js";
import { readableScopeSql, readableTrashedNodeIds } from "../readPolicy.js";

export type ReadableNotesScope = {
  /** Only notes in this space; a space `actor` cannot read yields nothing, same as an empty one. */
  spaceId?: string;
  /** Also the notes `actor` can read in 最近刪除. */
  includeTrashed?: boolean;
};

/** A parenthesised condition on content_nodes row `alias`; its values are pushed onto `params`. */
export async function readableNotesSql(
  actor: ActorCtx, workspaceId: string, alias: string, params: unknown[], { spaceId, includeTrashed = false }: ReadableNotesScope = {},
): Promise<string> {
  let readable = readableScopeSql(actor, alias, params);
  if (includeTrashed) {
    const trashed = [...await readableTrashedNodeIds(actor, workspaceId)];
    readable = `(${readable} OR ${alias}.id = ANY($${params.push(trashed)}::uuid[]))`;
  }
  return spaceId ? `(${readable} AND ${alias}.space_id = $${params.push(spaceId)})` : readable;
}
