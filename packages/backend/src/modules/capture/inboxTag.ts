import type { ActorCtx } from "../../types.js";
import { withEventTransaction } from "../../spine/eventTransaction.js";
import { resolveCurrentActor } from "../../spine/currentActor.js";
import { createMemberModuleTag, findModuleTag } from "../../services/workspaceModules.js";

export const CAPTURE_MODULE_ID = "capture";

/** The module tag's name; when another top-level tag already has it the tag is
 *  the next one that is free (the same rule as the tasks module's #task). */
const INBOX_TAG_NAMES = ["收件匣", "捕捉", "收件匣 (capture)"];

/** The capture module's tag (收件匣): an ordinary tag marked with the module,
 *  made the first time a capture needs it — by any member who may write
 *  notes, as the tasks module makes #task. The capture without a place of its
 *  own carries it; moving the capture under a note takes it off. Not
 *  inheritable, so notes written under a capture stay out of the inbox.
 *  Returns the existing tag when there is one, so asking again is harmless. */
export async function ensureInboxTag(actor: ActorCtx, workspaceId: string): Promise<string> {
  return withEventTransaction(workspaceId, async () => {
    // Re-checked under the event lock: a concurrent ensure has committed or waits.
    const existing = await findModuleTag(workspaceId, CAPTURE_MODULE_ID);
    if (existing) return existing.id;
    const current = await resolveCurrentActor(actor, workspaceId);
    return createMemberModuleTag(current, workspaceId, { module: CAPTURE_MODULE_ID, names: INBOX_TAG_NAMES, uiContext: "capture.inbox" });
  });
}
