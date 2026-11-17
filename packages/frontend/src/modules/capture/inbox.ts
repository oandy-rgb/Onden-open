// The inbox: captures that have not been filed yet. A capture with no place of
// its own is a top-level note carrying the capture module's tag (收件匣,
// tag_schema.module = "capture"), made on the server the first time one is
// needed (POST /api/capture/inbox). Filing it under a note takes the tag off;
// the reserved `_captured` flag stays, so "what I jotted down that day" can
// still be answered (capturesOnDay).

import type { ContentNode, Tag } from "../../lib/api";
import { captureWriter } from "../../lib/data";
import { dateIdAt } from "../../lib/localDate";
import { nodeHasTag } from "../../lib/nodeTags";
import { isNote } from "@onden/markdown/contract";

const CAPTURE_MODULE = "capture";
/** The flag every capture is born with (backend services/systemAttributes CAPTURED_KEY). */
export const CAPTURED_ATTRIBUTE = "_captured";

// The tag the server made this session, until the tag list has it.
let ensuredTagId: string | null = null;

/** The inbox tag's id as this device knows it, or null before the first capture made it. */
export function inboxTagId(tags: readonly Tag[] | null | undefined): string | null {
  return (tags ?? []).find((tag) => tag.schema_module === CAPTURE_MODULE)?.id ?? ensuredTagId;
}

/** The inbox tag's id, asking the server to make the tag if nobody has yet
 *  (needs a connection once; after that the tag is part of the synced notes). */
export async function ensureInboxTagId(tags: readonly Tag[] | null | undefined): Promise<string> {
  const known = inboxTagId(tags);
  if (known) return known;
  const tag_id = await captureWriter.ensureInboxTag();
  ensuredTagId = tag_id;
  return tag_id;
}

/** A capture still waiting to be filed. The sidebar tree leaves these out
 *  (lib/sidebarTidy): they are listed on the inbox page. */
export function isPendingCapture(node: ContentNode, tags: readonly Tag[] | null | undefined): boolean {
  const tagId = inboxTagId(tags);
  return tagId !== null && isNote(node) && !node.deleted_at && nodeHasTag(node, tagId);
}

/** The waiting captures, newest first. */
export function pendingCaptures(nodes: readonly ContentNode[], tags: readonly Tag[] | null | undefined): ContentNode[] {
  return nodes
    .filter((node) => isPendingCapture(node, tags))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
}

/** What was jotted down on `day` (YYYY-MM-DD in the workspace's day), by when
 *  it was captured, filed or not — for the timeline. Newest first. */
export function capturesOnDay(nodes: readonly ContentNode[], tags: readonly Tag[] | null | undefined, day: string): ContentNode[] {
  return nodes
    .filter((node) => isNote(node) && !node.deleted_at && node.created_at
      && (node.attrs?.[CAPTURED_ATTRIBUTE] === "true" || isPendingCapture(node, tags))
      && dateIdAt(new Date(node.created_at)) === day)
    .sort((a, b) => b.created_at!.localeCompare(a.created_at!));
}
