// One-time repair (owner decision 2026-11-19 on PR #1884, run by hand, never at boot): an inbox a person deleted before module
// tags were protected, and who captured again afterwards, has two capture tags — the live one and the trashed one that still
// holds the older captures (reviveModuleTag only helps while no live one exists). The older captures are put on the live inbox
// by the ordinary TAG_APPLIED event (so each is undoable like any tag change). The trashed tag keeps its links and stays in the
// trash; a capture under a note is left alone (moving it under a note took the inbox off on purpose).
//
//   findStrandedInboxes: which workspaces have this, and how many captures   (read-only)
//   moveStrandedCaptures: put those captures on the live inbox               (one workspace, as the workspace's owner)

import { withSavepoint } from "../db.js";
import { db } from "../dbKysely.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { applyTagToNode } from "./tagMembershipWrites.js";
import { findStrandedModuleTags } from "./workspaceModules.js";

// The capture module's id (modules/capture/inboxTag.ts CAPTURE_MODULE_ID; a service does not import a module's files).
export const findStrandedInboxes = (workspaceId?: string) => findStrandedModuleTags("capture", workspaceId);

/** Put the stranded captures of one workspace on its live inbox, as the workspace's owner, in one event transaction; a capture
 *  the owner may not tag (or that vanished) is listed in `left` with the reason. Running it again finds nothing more. */
export async function moveStrandedCaptures(workspaceId: string): Promise<{ moved: number; left: Array<{ nodeId: string; reason: string }> }> {
  const ownerId = (await db.selectFrom("workspaces").select("owner_actor_id").where("id", "=", workspaceId).executeTakeFirst())?.owner_actor_id;
  if (!ownerId) throw new Error("workspace has no owner");
  return withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor({ id: ownerId }, workspaceId);
    let moved = 0;
    const left: Array<{ nodeId: string; reason: string }> = [];
    for (const found of await findStrandedInboxes(workspaceId)) {
      for (const nodeId of found.noteIds) {
        try {
          if (await withSavepoint(() => applyTagToNode({ workspaceId, actor, nodeId, tagId: found.liveTagId }))) moved++;
        } catch (error) {
          left.push({ nodeId, reason: error instanceof Error ? `${error.name}: ${error.message}` : "unknown error" });
        }
      }
    }
    return { moved, left };
  });
}
