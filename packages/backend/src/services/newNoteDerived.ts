// The derived state a new note's text gives it, once its row exists:
// wikilinks both ways, block nodes, the backup and the module content hooks
// (search embedding, media ownership). createNote runs it for every note;
// the two paths that keep their own insert (noteDuplicate, templateExpander:
// noteCreate.test.ts says why) run it too, so no new note misses a step
// createNote gains. A leaf module: templateExpander is reached from
// noteCreate (through tag apply), so it can't import noteCreate itself.
//
// Attributes are not here: createNote derives them from the text through the
// dispatcher, while a copy replays the source's recorded attributes and a
// template child gets only its origin marker.

import { enqueueBackup } from "./outbox.js";
import { relinkTarget } from "./nodes.js";
import { syncBlockNodes } from "./blockNodes.js";
import { deriveFromBody } from "./bodyDerivation.js";
import { linkBlockNodeAnchors, adoptAnchorsInto, anchorExcerpts, type AdoptAnchor } from "./blockAnchors/index.js";
import type { ActorCtx } from "../types.js";
import { nodeContentCommitted } from "./nodeCommits.js";

export type NewNoteRow = { workspaceId: string; nodeId: string; title: string; slug: string; markdown: string };

/** Run inside the NODE_CREATED transaction, after the row (and anything the
 *  caller writes before it) exists. What it records chains to `eventId`.
 *  `index: false` skips the content hooks (an RSS save its feed doesn't embed). */
export async function finishNewNote(note: NewNoteRow, opts: { eventId: string; actor: ActorCtx; index?: boolean; adoptAnchors?: AdoptAnchor[] }): Promise<void> {
  const { workspaceId, nodeId, title, markdown } = note;
  // Backlinks from notes that [[linked]] this title or slug before it existed.
  await relinkTarget(workspaceId, [nodeId]);
  // Anchors with ids already promised go on their blocks first; the rest of the blocks get their own (a copy: new ids, no data).
  if (opts.adoptAnchors?.length) await adoptAnchorsInto(workspaceId, nodeId, markdown, opts.adoptAnchors, { actor: opts.actor, eventId: opts.eventId });
  await anchorExcerpts(workspaceId, nodeId, markdown, { actor: opts.actor, eventId: opts.eventId });
  const { retagged } = await syncBlockNodes({ workspaceId, noteId: nodeId, markdown, actor: opts.actor, eventId: opts.eventId });
  await linkBlockNodeAnchors({ workspaceId, noteId: nodeId });
  // Its own [[links]], paragraph rows' display and anchor index: the derived half, the same function a node that takes it by bundle runs.
  await deriveFromBody(workspaceId, nodeId, markdown, retagged);
  // The backup rides the transactional outbox; the reconciler pushes it.
  await enqueueBackup({ workspaceId, nodeId, markdown, message: `NODE_CREATED: ${title}`, triggeredByEventId: opts.eventId });
  if (opts.index !== false) {
    await nodeContentCommitted({ workspaceId, nodeId, text: `${title}\n\n${markdown}`, triggeredByEventId: opts.eventId });
  }
}
