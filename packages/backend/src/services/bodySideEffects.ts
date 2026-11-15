// What follows a committed change to a note's title or body — one place, so
// every path that rewrites a body (edit, version restore, undo of an edit,
// import update) keeps the derived state in step with the text.
//
// Before this module the chain was copied four times with different
// coverage: undoing an edit re-enqueued the backup only, so backlinks, block
// nodes, search embeddings and inline attributes kept describing the
// text the user had just taken back.

import type { ActorCtx } from "../types.js";
import { relinkTarget, syncWikilinkEdges, syncAuthorizedNodeAttributes } from "./nodes.js";
import { syncBlockNodes } from "./blockNodes.js";
import { syncNoteBlockRefs } from "./noteBlockRefs.js";
import { enqueueBackup } from "./outbox.js";
import { queueDispatcher, enqueueCascadeIntent } from "./dispatcherQueue.js";
import { afterCommit } from "../spine/txHooks.js";
import { systemJobOf } from "../spine/systemJobs.js";
import { nodeContentCommitted } from "./nodeCommits.js";
import { assertNoteSize } from "./noteSize.js";
import { moveAnchorsForBodyChange, linkBlockNodeAnchors, adoptAnchorsInto, anchorExcerpts, type AdoptAnchor, type EditorBodyChange } from "./blockAnchors/index.js";

export type BodyChange = {
  workspaceId: string;
  nodeId: string;
  /** The note's title and body as they now stand (after the UPDATE). */
  title: string;
  markdown: string;
  /** The body this write replaced, or null if the caller does not have it. Block anchors move from it to
   *  `markdown`; without it they are found again by their quoted text (services/blockAnchors/mapping.ts). */
  previousMarkdown: string | null;
  /** The editor's own CodeMirror ChangeSet (toJSON) for this save and its device, if it sent one. Unverified:
   *  the ChangeSet is used only if it turns `previousMarkdown` into `markdown` exactly. */
  bodyChange?: EditorBodyChange;
  /** Anchors that move INTO this note with this change (a child note taken back as a paragraph): each goes on the
   *  one place `text` stands in `markdown` (`at`, or its only occurrence), see adoptAnchorsInto. Runs after the note's own anchors moved. */
  adoptAnchors?: AdoptAnchor[];
  /** The title (and so the slug) changed: the notes linking to the old or
   *  the new name are re-linked (relinkTarget). */
  renamed?: boolean;
  /** The event that changed it (NODE_UPDATED, NODE_RESTORED, …). */
  eventId: string;
  /** Who changed it: inline attributes and frontmatter are re-derived with
   *  this actor's authority. */
  actor: ActorCtx;
  /** Names the dispatcher cascade, e.g. "node.patch.cascade". */
  cascadeLabel: string;
  /** What the backup commit says before the title, e.g. "NODE_UPDATED". */
  backupPrefix: string;
};

/**
 * Call inside the write transaction, right after the body or title UPDATE.
 *
 * In the transaction (commits or rolls back with the write): wikilink edges
 * (the note's own, and after a rename the ones into it), block
 * nodes (services/blockNodes.ts), the anchor id index (noteBlockRefs.ts), block anchors (services/blockAnchors), the backup intent, module content hooks (search embedding,
 * media ownership) and the durable cascade intent. After commit: the
 * dispatcher re-derives inline attributes and frontmatter from the new body.
 */
export async function applyBodyChange(change: BodyChange): Promise<void> {
  const { workspaceId, nodeId, title, markdown, eventId, actor, cascadeLabel, backupPrefix } = change;
  // No path stores a note REST would refuse (services/noteSize.ts); thrown
  // inside the write transaction, so the UPDATE rolls back with it.
  assertNoteSize({ title, markdown });
  await syncWikilinkEdges(workspaceId, nodeId, markdown);
  if (change.renamed) await relinkTarget(workspaceId, [nodeId]);
  // The anchors first, in the same transaction as the body: a block's identity is its anchor, so the block nodes
  // below read the positions that just followed this change (services/blockAnchors, services/blockNodes.ts).
  if (change.previousMarkdown !== markdown) {
    await moveAnchorsForBodyChange({
      workspaceId, noteId: nodeId, before: change.previousMarkdown, after: markdown, bodyChange: change.bodyChange,
      cause: { actor, eventId },
    });
  }
  if (change.adoptAnchors?.length) await adoptAnchorsInto(workspaceId, nodeId, markdown, change.adoptAnchors, { actor, eventId });
  await anchorExcerpts(workspaceId, nodeId, markdown, { actor, eventId });
  await syncBlockNodes({ workspaceId, noteId: nodeId, markdown, actor, eventId });
  await linkBlockNodeAnchors({ workspaceId, noteId: nodeId });
  await syncNoteBlockRefs(workspaceId, nodeId, markdown);
  await enqueueBackup({ workspaceId, nodeId, markdown, message: `${backupPrefix}: ${title}`, triggeredByEventId: eventId });
  await nodeContentCommitted({ workspaceId, nodeId, text: `${title}\n\n${markdown}`, triggeredByEventId: eventId });
  // A system job (spine/systemJobs.ts) holds no authority to write attributes, and what it changes in a body
  // (block markers, services/blockMarkerRepair.ts) is not read by attribute derivation: no cascade for it.
  if (systemJobOf(actor)) return;
  // A crash before the post-commit cascade settles leaves this row for
  // runDispatcherCatchup() to replay.
  await enqueueCascadeIntent({ workspaceId, nodeId, actor, label: cascadeLabel, eventId });
  afterCommit(() => {
    void queueDispatcher(
      { workspaceId, nodeId, actorId: actor.id, label: cascadeLabel, triggerEventId: eventId },
      () => syncAuthorizedNodeAttributes(workspaceId, nodeId, markdown, actor, eventId),
    );
  });
}
