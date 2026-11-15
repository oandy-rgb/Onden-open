// The canvas list (depth audit D75). A canvas IS a note (migration 057, and
// since 138 a plain note with a whiteboard tab: lib/whiteboardNote), so the
// list is read from the synced nodes — never kept as a second store. A canvas
// created offline or on another device, renamed or trashed as a note, shows in
// the palette, the tab strip and the board chooser as soon as its node changes.

import type { CanvasMeta, ContentNode } from "./api";
import { isWhiteboardNote } from "./whiteboardNote";
import { isTag } from "@onden/markdown/contract";

const metaByNode = new WeakMap<ContentNode, CanvasMeta>();

function metaOf(node: ContentNode): CanvasMeta {
  let meta = metaByNode.get(node);
  if (!meta) {
    meta = { id: node.id, title: node.title, created_at: node.created_at ?? "", updated_at: node.updated_at ?? node.created_at ?? "" };
    metaByNode.set(node, meta);
  }
  return meta;
}

/** The workspace's canvases, most recently updated first (the order the
 *  server's list used). Each row is the same object while its node is. */
export function canvasList(nodes: readonly ContentNode[]): CanvasMeta[] {
  return nodes
    .filter((node) => isWhiteboardNote(node))
    .map(metaOf)
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
}

/** One board's row, or undefined when no note has that id. Any note can hold
 *  a board (its whiteboard tab may not have reached this device yet), so this
 *  asks for the note, not for the tab; the list above is the notes that show
 *  as canvases. */
export function canvasMeta(nodes: readonly ContentNode[], id: string): CanvasMeta | undefined {
  const node = nodes.find((row) => row.id === id && !isTag(row));
  return node ? metaOf(node) : undefined;
}
