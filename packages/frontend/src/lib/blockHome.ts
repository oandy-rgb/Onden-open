// `[[Note#^id]]` when Note no longer holds the block: the app's copy of the
// fallback (docs/architecture/block-nodes.md, 段落連結的後援). The server
// picks the note — one indexed lookup within the reader's permissions, rule in
// @onden/markdown chooseBlockHome — and this module is how the embed and the
// link click ask it. It never scans the notes the app holds: on a phone with
// 20,000 notes most arrive without their text.
//
// Only asked when the named note's own text lacks the id (embedDom: the block
// came back empty; blockLinkTarget: noteHasBlock said no), so the common
// link never costs a request. Offline or any failure: no home, and the link
// behaves as it did before.

import { noteHasBlock } from "@onden/markdown";
import { anchorSpansOf } from "./blockAnchorStore";
import { reads } from "./data";
import type { ContentNode } from "./api";
import type { WikilinkNode } from "./wikilinks";
import type { BlockHome } from "@onden/contract";

/** Lookups made within this long ago are shared (an embed drawn in the editor
 *  and the preview at once, then a click on its source line). */
const SHARE_MS = 2000;

const asked = new Map<string, { at: number; done: Promise<BlockHome | null> }>();

/** The note, other than `named`, that holds block `^blockId`, as the node the
 *  app holds for it (so its title and text read from the store) or the row the
 *  server sent; null when there is none to use. */
export async function blockHome<T extends WikilinkNode>(
  named: WikilinkNode, blockId: string, nodes: readonly T[] | undefined,
): Promise<T | WikilinkNode | null> {
  const key = `${named.id}#${blockId}`;
  const now = Date.now();
  let recent = asked.get(key);
  if (!recent || now - recent.at >= SHARE_MS) {
    recent = { at: now, done: reads.notes.blockHome(named.id, blockId) };
    asked.set(key, recent);
  }
  const home = await recent.done;
  if (!home) return null;
  return nodes?.find((n) => n.id === home.id) ?? home;
}

/** Where a click on `[[named#^blockId]]` goes, and whether the paragraph is gone for good:
 *  `named` while it holds the block (or its text is unknown), else the note that does,
 *  else `named` with `deleted` (and its text now, for lib/blockSafety/recovery). */
export async function blockLinkOutcome<T extends WikilinkNode & Pick<ContentNode, "markdown" | "body_len">>(
  named: T, blockId: string, nodes: readonly T[] | undefined,
): Promise<{ target: T | WikilinkNode; deleted: false } | { target: T; deleted: true; text: string }> {
  const text = await reads.notes.body(named);
  if (text === null || noteHasBlock(anchorSpansOf(named.id, text).map((a) => a.id), blockId)) return { target: named, deleted: false };
  const home = await blockHome(named, blockId, nodes);
  return home ? { target: home, deleted: false } : { target: named, deleted: true, text };
}

/** Where a click on `[[named#^blockId]]` goes: `named` while it holds the
 *  block (or its text is unknown), else the note that does, else `named`. */
export async function blockLinkTarget<T extends WikilinkNode & Pick<ContentNode, "markdown" | "body_len">>(
  named: T, blockId: string, nodes: readonly T[] | undefined,
): Promise<T | WikilinkNode> {
  return (await blockLinkOutcome(named, blockId, nodes)).target;
}

/** Forget what was asked (tests). */
export function resetBlockHomeCache(): void {
  asked.clear();
}
