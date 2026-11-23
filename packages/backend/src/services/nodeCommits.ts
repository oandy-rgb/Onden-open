// The core half of a note's commit hooks: what the server itself does when a
// note's text or an attribute changes, before the modules hear about it
// (spine/nodeHooks.ts). Lives in services because it reaches media and links;
// the spine only knows the module fan-out.

import { claimUploadedMedia } from "./mediaOwners.js";
import { relinkTarget } from "./wikilinkEdges.js";
import {
  modulesAttributeCommitted, modulesContentCommitted,
  type HookOrigin, type NodeAttributeCommit, type NodeContentCommit,
} from "../spine/nodeHooks.js";

/** Call in the write transaction after a node's title or body changed. Core
 *  first: the note claims the uploads it is the first to reference. */
export async function nodeContentCommitted(change: NodeContentCommit, origin: HookOrigin = {}): Promise<void> {
  await claimUploadedMedia(change.workspaceId, change.nodeId, change.text);
  await modulesContentCommitted(change, origin);
}

/** Call in the transaction of an attribute write (recordAttributeChange
 *  does, and the undo of one). Core first, as for content: the note claims
 *  the uploads its new value is the first to reference (a media field's
 *  cover), and new or dropped `aliases` re-link the notes that `[[name]]` it;
 *  both throw with the write. The module hooks after them never throw. */
export async function nodeAttributeCommitted(change: NodeAttributeCommit, origin: HookOrigin = {}): Promise<void> {
  if (change.value !== null) await claimUploadedMedia(change.workspaceId, change.nodeId, change.value);
  if (change.key === "aliases") await relinkTarget(change.workspaceId, [change.nodeId]);
  await modulesAttributeCommitted(change, origin);
}
