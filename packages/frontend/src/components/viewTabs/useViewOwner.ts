import { useMemo } from "react";
import { displayTitle } from "../../lib/noteLabel";
import type { ContentNode, FieldDef, Tag } from "../../lib/api";
import { useAppSelector, useOnline, useTagRows, useAllNodes } from "../../lib/appStore";
import { useCapabilities } from "../../lib/capabilities";
import { sharedChildFields } from "../../lib/childFields";
import { tagFields } from "../../lib/tagFields";
import { useT } from "../../lib/i18n";
import { isViewModuleTag } from "../../modules";
import type { ViewOwner } from "../../lib/data";
import { isRetiredBoardKind, ownsBoard } from "../../lib/whiteboardNote";
import { TAG_NODE_TYPE } from "@onden/markdown/contract";

/** What the tab row and the pane of a page need to know about it: whose views
 *  they are, the fields a view could be placed by, whether the person may
 *  change them, and what the page earns (a whiteboard). */
export type ViewOwnerInfo = {
  owner: ViewOwner & { name: string };
  fields: FieldDef[];
  canManage: boolean;
  /** Cards sit on this page's own board (or it is still of the retired kind
   *  'canvas'): its whiteboard tab shows by itself. */
  hasBoard: boolean;
  /** The note is still of the retired board kind: it opens on its whiteboard. */
  retiredBoard: boolean;
};

/** The page's view owner: a tag (its notes), else a note (its sub-notes). Null
 *  when nothing is open, or for a view module's tag (#月曆…), whose page only
 *  gathers the tags that use the view. */
export function useViewOwner(node: ContentNode | null, tag: Tag | null): ViewOwnerInfo | null {
  const t = useT();
  const nodes = useAllNodes();
  const tags = useTagRows();
  const memberships = useAppSelector((s) => s.data.canvas_memberships);
  const online = useOnline();
  const { canEdit } = useCapabilities(online);
  const id = tag?.id ?? node?.id ?? null;
  const children = useMemo(
    () => (tag || !node ? [] : nodes.filter((child) => child.parent_id === node.id && !child.hidden)),
    [nodes, node, tag],
  );
  const fields = useMemo(
    () => (tag ? tagFields(tag) : sharedChildFields(children, tags ?? [])),
    [tag, children, tags],
  );
  if (!id || (tag && isViewModuleTag(tag))) return null;
  return {
    owner: tag
      ? { kind: "tag", id: tag.id, name: tag.schema_module ? t(tag.name) : tag.name }
      : { kind: "node", id: node!.id, name: displayTitle(node!.title) },
    fields,
    canManage: tag ? canEdit({ node_type: TAG_NODE_TYPE, space_id: null }) : canEdit(node!),
    hasBoard: !tag && !!node && ownsBoard(node, memberships),
    retiredBoard: !tag && !!node && isRetiredBoardKind(node),
  };
}
