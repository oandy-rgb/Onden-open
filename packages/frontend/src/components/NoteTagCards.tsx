import { useMemo } from "react";
import type { ContentNode, Tag } from "../lib/api";
import { useTagRows, useAllNodes } from "../lib/appStore";
import { propertyWriter } from "../lib/data";
import { useT } from "../lib/i18n";
import { appliedNoteTags, hiddenTags, nodeHasTag } from "../lib/nodeTags";
import { isSystemTag } from "../lib/systemNodes";
import { tagFields } from "../lib/tagFields";
import { capabilitiesFor, useIsOwner } from "../lib/capabilities";
import { requestTagFields } from "../lib/tagPageRequest";
import NodeAttributesPanel from "./NodeAttributesPanel";
import TagCardTop from "./TagCardTop";
import "./NoteTagCards.css";
import { Pressable } from "./ui";
import { TAG_NODE_TYPE } from "@onden/markdown/contract";

// One tag's card (its name and count, parent tag, what it brings and its
// fields): what opens under the title when that tag's chip is clicked
// (NoteTagsBlock). The right panel's cards are InfoTagsTab's.
// NodeAttributesPanel draws the fields. Tags are added and removed only on
// the chips row under the title (TitleTagRow).

// A tag definition is in no space: lib/capabilities.ts canEdit answers "the
// owner" for it — the one rule for who may change a tag's fields.
const TAG_DEFINITION = { node_type: TAG_NODE_TYPE, space_id: null } as const;

// Stable fallback so `tags ?? NO_TAGS` keeps one identity across renders.
const NO_TAGS: Tag[] = [];

type Props = {
  node: ContentNode;
  /** The person may change this note: editable fields and "+ Tag". */
  canEdit: boolean;
  /** Open a tag's page, and a note a relation field links to (both are node ids). */
  onOpenTag: (tagId: string) => void;
  onAttrUpsert?: (nodeId: string, key: string, value: string, opts?: { value_type?: string; is_inheritable?: boolean }) => Promise<unknown>;
  onAttrRemove?: (nodeId: string, key: string) => Promise<unknown>;
  /** Reload app data after the owner added a select option to a tag's field. */
  onTagsChanged?: () => void | Promise<void>;
  /** The tag whose card to draw. */
  show: { tagId: string };
};

export default function NoteTagCards({
  node, canEdit, onOpenTag, onAttrUpsert = propertyWriter.set, onAttrRemove = propertyWriter.remove, onTagsChanged, show,
}: Props) {
  const t = useT();
  const nodes = useAllNodes();
  const tags = useTagRows() ?? NO_TAGS;
  const applied = useMemo(() => appliedNoteTags(node, tags), [node, tags]);
  // A hidden tag (D104) shows no chip, but its fields still apply: they stay
  // claimed here so their values never fall among the old properties.
  const withFields = useMemo(() => [
    ...applied,
    ...hiddenTags(tags).filter((tag) => !isSystemTag(tag) && nodeHasTag(node, tag.id) && tagFields(tag).length > 0),
  ], [applied, tags, node]);
  const cardTagIds = useMemo(() => [show.tagId], [show.tagId]);
  const byId = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags]);
  // Tag definitions are the owner's: only they get the way to the tag page's
  // field settings, and the inline new select option.
  const canEditTags = capabilitiesFor(useIsOwner(), [], true).canEdit(TAG_DEFINITION);

  // A note fills values; the tag's fields are set on its page.
  const foot = (tag: Tag) => canEditTags ? (
    <Pressable type="button" className="tag-card-edit-fields tap-target" onClick={() => { requestTagFields(tag.id); onOpenTag(tag.id); }}>
      {t("Edit the fields of #{name} →", { name: tag.name })}
    </Pressable>
  ) : null;

  // A card's top is TagCardTop (name, count, page, what it brings). Under it,
  //   上層 #X — the hierarchy (parent_id), the one thing "inheritance" means
  //            in the UI (user decision 2026-10-18).
  // An old extends of another user tag is not shown here (nor on the tag page).
  const head = (tag: Tag) => {
    const parent = tag.parent_id ? byId.get(tag.parent_id) : undefined;
    return (
      <>
        <TagCardTop tag={tag} onOpenTag={onOpenTag} />
        {parent && (
          <span className="tag-card-origin">
            {t("Parent")}{" "}
            <Pressable type="button" className="tag-card-parent" onClick={() => onOpenTag(parent.id)}>#{parent.name}</Pressable>
          </span>
        )}
      </>
    );
  };

  return (
    <div className="note-tag-cards">
      <NodeAttributesPanel
        nodeId={node.id}
        classTags={withFields}
        cardTagIds={cardTagIds}
        showOther={false}
        allNodes={nodes}
        readOnly={!canEdit}
        renderTagHead={head}
        renderTagFoot={foot}
        canEditTags={canEditTags}
        onUpsert={(key, value, opts) => onAttrUpsert(node.id, key, value, opts)}
        onRemove={(key) => onAttrRemove(node.id, key)}
        onOpenNote={onOpenTag}
        onTagsChanged={onTagsChanged}
      />
    </div>
  );
}
