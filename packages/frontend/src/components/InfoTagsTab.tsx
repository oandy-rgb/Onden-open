import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { ContentNode, NodeAttribute, Tag } from "../lib/api";
import { addToast, useTagRows, useAllNodes } from "../lib/appStore";
import { propertyWriter, tagSchemaWriter } from "../lib/data";
import { useT } from "../lib/i18n";
import { agoLabel } from "../lib/timeLabels";
import { appliedNoteTags, hiddenTags, nodeHasTag, tagMembers } from "../lib/nodeTags";
import { isSystemTag } from "../lib/systemNodes";
import { namesTakenAround, tagFields } from "../lib/tagFields";
import { withPromotedField } from "../lib/tagFieldEdits";
import { requestTagFields } from "../lib/tagPageRequest";
import { capabilitiesFor, useIsOwner } from "../lib/capabilities";
import NodeAttributesPanel from "./NodeAttributesPanel";
import TagCardTop from "./TagCardTop";
import "./NoteTagCards.css";
import "./InfoTagsTab.css";
import { byUpdatedDesc } from "../lib/noteOrder";
import { displayTitle } from "../lib/noteLabel";
import { Pressable } from "./ui";
import { TAG_NODE_TYPE } from "@onden/markdown/contract";

// The info panel's 「標籤」 tab: one card per tag the note carries — its fields
// (values only; a tag's structure is edited on its page), the functions it
// brings and the other notes with the tag. The cards of function/module tags
// (schema_module) are left out, as in the sidebar tag tree. Properties no tag
// has a field for show once below the cards, each with a way to make it a
// field of one of the note's tags. NodeAttributesPanel draws the fields.

const TAG_DEFINITION = { node_type: TAG_NODE_TYPE, space_id: null } as const;
const NO_TAGS: Tag[] = [];
const NEAR_NOTES = 3;

/** The tags whose cards the panel draws for `node`: the ones listed on it plus
 *  hidden ones that bring fields (their values stay editable), never a
 *  function's own module tag. */
export function infoCardTags(node: Pick<ContentNode, "class_tag_ids" | "label_tag_ids">, tags: readonly Tag[]): Tag[] {
  const hiddenWithFields = hiddenTags(tags).filter((tag) => !isSystemTag(tag) && nodeHasTag(node, tag.id) && tagFields(tag).length > 0);
  return [...appliedNoteTags(node, tags), ...hiddenWithFields].filter((tag) => !tag.schema_module);
}

type Props = {
  node: ContentNode;
  canEdit: boolean;
  /** Open a note or a tag page. */
  onOpen: (nodeId: string) => void;
  onAttrUpsert?: (nodeId: string, key: string, value: string, opts?: { value_type?: string; is_inheritable?: boolean }) => Promise<unknown>;
  onAttrRemove?: (nodeId: string, key: string) => Promise<unknown>;
  onTagsChanged?: () => void | Promise<void>;
  /** Drawn when the note has no tag, no property of its own and nothing shared down from a parent. */
  whenEmpty?: ReactNode;
};

export default function InfoTagsTab({ node, canEdit, onOpen, onAttrUpsert = propertyWriter.set, onAttrRemove = propertyWriter.remove, onTagsChanged, whenEmpty }: Props) {
  const t = useT();
  const nodes = useAllNodes();
  const tags = useTagRows() ?? NO_TAGS;
  const canEditTags = capabilitiesFor(useIsOwner(), [], true).canEdit(TAG_DEFINITION);
  const cardTags = useMemo(() => infoCardTags(node, tags), [node, tags]);
  // Every tag the note has claims its fields, so a value drawn in one card
  // never lands among the old properties.
  const claiming = useMemo(() => [...cardTags, ...appliedNoteTags(node, tags).filter((tag) => tag.schema_module)], [cardTags, node, tags]);
  const near = useMemo(() => {
    const out = new Map<string, { total: number; latest: ContentNode[] }>();
    for (const tag of cardTags) {
      const members = tagMembers(tags, nodes, tag.id);
      const others = members.filter((member) => member.id !== node.id)
        .sort(byUpdatedDesc);
      out.set(tag.id, { total: members.length, latest: others.slice(0, NEAR_NOTES) });
    }
    return out;
  }, [cardTags, tags, nodes, node.id]);

  const head = (tag: Tag) => (
    <>
      <TagCardTop tag={tag} onOpenTag={onOpen} />
      {canEditTags && (
        <Pressable type="button" className="info-tag-edit tap-target" onClick={() => { requestTagFields(tag.id); onOpen(tag.id); }}>
          {t("Edit the fields of #{name} →", { name: tag.name })}
        </Pressable>
      )}
    </>
  );

  const foot = (tag: Tag) => {
    const sameTag = near.get(tag.id);
    return sameTag && sameTag.latest.length > 0 ? (
      <div className="info-tag-near">
        <h3 className="info-tag-near-title">{t("Notes with this tag")}</h3>
        <ul>
          {sameTag.latest.map((other) => (
            <li key={other.id}>
              <Pressable type="button" className="info-tag-near-note tap-target" onClick={() => onOpen(other.id)}>
                <span className="info-tag-near-name">{displayTitle(other.title)}</span>
                <span className="info-tag-muted">{agoLabel(other.updated_at)}</span>
              </Pressable>
            </li>
          ))}
        </ul>
        <Pressable type="button" className="info-tag-all tap-target" onClick={() => onOpen(tag.id)}>
          {t("See all {n} →", { n: sameTag.total })}
        </Pressable>
      </div>
    ) : null;
  };

  const [choosing, setChoosing] = useState<string | null>(null);
  // The owner moves an old property into a tag's fields: the same field-list
  // edit the tag page's 「升級成欄位」 makes. The property and its value stay.
  const makeField = useCallback(async (tag: Tag, attr: NodeAttribute) => {
    setChoosing(null);
    if (namesTakenAround(tag, tags).includes(attr.key)) {
      addToast(t("A tag above already has a field with this name. Rename it first."), "error");
      return;
    }
    const fields = withPromotedField(tag.schema_fields ?? [], attr.key, attr.value);
    if (!fields) return;
    try {
      await tagSchemaWriter.update(tag.id, { fields });
    } catch {
      return; // Reported by the tag-schema writer.
    }
    await onTagsChanged?.();
  }, [tags, onTagsChanged, t]);

  const legacyAction = (attr: NodeAttribute) => {
    if (!canEditTags || cardTags.length === 0) return null;
    if (cardTags.length === 1) {
      return (
        <Pressable type="button" className="info-legacy-make tap-target" onClick={() => void makeField(cardTags[0], attr)}>
          {t("Make it a field of #{name}", { name: cardTags[0].name })}
        </Pressable>
      );
    }
    return choosing === attr.key ? (
      <span className="info-legacy-choices" role="group" aria-label={t("Make it a field of…")}>
        {cardTags.map((tag) => (
          <Pressable key={tag.id} type="button" className="info-legacy-make tap-target" onClick={() => void makeField(tag, attr)}>#{tag.name}</Pressable>
        ))}
      </span>
    ) : (
      <Pressable type="button" className="info-legacy-make tap-target" onClick={() => setChoosing(attr.key)}>{t("Make it a field of…")}</Pressable>
    );
  };

  return (
    <div className="note-tag-cards info-tag-cards">
      <NodeAttributesPanel
        nodeId={node.id}
        classTags={claiming}
        cardTagIds={cardTags.map((tag) => tag.id)}
        showOther
        otherLabel={t("Properties not in any tag")}
        renderLegacyAction={legacyAction}
        allNodes={nodes}
        readOnly={!canEdit}
        renderTagHead={head}
        renderTagFoot={foot}
        canEditTags={canEditTags}
        whenEmpty={whenEmpty}
        onUpsert={(key, value, opts) => onAttrUpsert(node.id, key, value, opts)}
        onRemove={(key) => onAttrRemove(node.id, key)}
        onOpenNote={onOpen}
        onTagsChanged={onTagsChanged}
      />
    </div>
  );
}
