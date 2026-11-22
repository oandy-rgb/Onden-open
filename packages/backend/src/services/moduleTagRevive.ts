// A module's own tag that a person deleted before module tags were protected (reservedTags.assertTagDefinitionChange),
// brought back instead of a second one being made. Its own file: it needs nodeTrash, which reaches workspaceModules through
// reservedTags, so workspaceModules itself cannot import it (test/importCycles.test.ts).

import { withSavepoint } from "../db.js";
import type { ActorCtx } from "../types.js";
import { AuthorityError } from "../spine/authority.js";
import { findModuleTag } from "./workspaceModules.js";
import { tagNameTaken } from "./tagHierarchy.js";
import { undeleteNode } from "./nodeTrash.js";

/** Bring the module's tag back from the trash when no live one exists: a tag a person deleted before module tags
 *  were protected (see above). It is the same tag, so the notes that were
 *  filed under it (node_tags survives a delete) are in it again — making a new one would leave them on the
 *  trashed row and every later capture on a second tag. Of several trashed ones the tag with the most live notes
 *  comes back, then the oldest. It comes back through nodeTrash.undeleteNode (an ordinary NODE_UNDELETED, so History
 *  shows and can undo it) with the actor's own right to do that: when the actor may not (a member who can write
 *  but not edit tags), or a live tag took its name meanwhile, nothing comes back and the caller makes a new tag, as
 *  before. Runs in the caller's event transaction; the caller has already looked for a live tag. */
export async function reviveModuleTag(actor: ActorCtx, workspaceId: string, module: string, uiContext: string): Promise<string | null> {
  const trashed = await findModuleTag(workspaceId, module, undefined, { trashed: true });
  if (!trashed || await tagNameTaken(workspaceId, null, trashed.title)) return null;
  try {
    await withSavepoint(() => undeleteNode(actor, workspaceId, trashed.id, { uiContext }));
  } catch (error) {
    if (error instanceof AuthorityError) return null;
    throw error;
  }
  return trashed.id;
}
