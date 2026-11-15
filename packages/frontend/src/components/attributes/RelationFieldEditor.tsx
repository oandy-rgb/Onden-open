import { useFieldSave } from "./useFieldSave";
// Relation typeahead editor — renders a picker over the workspace's nodes.
// Extracted from NodeAttributesPanel.tsx during Day 6 panel decomposition.
//
// If the schema field specifies `relation_supertag`, the candidate list is
// filtered to nodes carrying a class tag matching that name (legacy JSON
// key from before the "supertag" → "class_tag" rename — kept until a jsonb
// migration over collection_schemas.fields lands).

import { useMemo, useState } from "react";
import type { ContentNode } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { containsTitle } from "../../lib/noteSearch";
import { isShownNote } from "../../lib/nodeTags";
import { displayTitle } from "../../lib/noteLabel";
import EmptyState from "../EmptyState";
import { Pressable, SearchField } from "../ui";

export function RelationFieldEditor({
  value, allNodes, relationConstraint, onSave, onOpenNote,
}: {
  value: string;
  allNodes: ContentNode[];
  relationConstraint?: string;
  onSave: (next: string) => Promise<void> | void;
  /** Open the linked note (its pill is a link); without it the pill is text. */
  onOpenNote?: (nodeId: string) => void;
}) {
  const t = useT();
  const { save, saving } = useFieldSave();
  const choose = async (id: string) => { if (await save(() => onSave(id))) { setOpen(false); setQuery(""); } };
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // The stored value is a node id (`node_ref` storage type). The display
  // form is the target's title — look it up on each render so renames
  // propagate without a refresh.
  const current = allNodes.find((n) => n.id === value);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allNodes
      .filter(isShownNote)
      // The constraint comparison is loose: we don't have the tag
      // *name* on ContentNode (only class_tag_ids), so a future
      // refinement should pass tags down. v1 ignores the constraint
      // visually and lets the user pick any node.
      .filter((n) => !q || containsTitle(q, n.title))
      .slice(0, 25);
  }, [allNodes, query]);

  if (!open) {
    const pick = relationConstraint ? t("Pick a node (preferably #{tag})", { tag: relationConstraint }) : t("Pick a node");
    if (!value) {
      return (
        <Pressable className="attr-value attr-value--clickable" onClick={() => setOpen(true)} title={pick}>
          <em className="attr-fill">{t("Pick a note…")}</em>
        </Pressable>
      );
    }
    // The pill opens the note; 「換一則」 opens the picker below.
    const title = displayTitle(current?.title);
    return (
      <div className="attr-relation-linked">
        {onOpenNote
          ? <Pressable className="attr-linked-note" onClick={() => onOpenNote(value)}>{title}</Pressable>
          : <span className="attr-linked-note">{title}</span>}
        <Pressable className="attr-relation-change" onClick={() => setOpen(true)} title={pick}>{t("Change note")}</Pressable>
      </div>
    );
  }
  return (
    <div className="attr-relation-picker">
      <SearchField
        autoFocus
        label={t("Search notes…")}
        value={query}
        onValueChange={setQuery}
        onEscape={() => { setOpen(false); setQuery(""); }}
      />
      {value && (
        <Pressable
          className="attr-relation-clear"
          disabled={saving} onClick={() => { void choose(""); }}
        >
          {t("Clear")}
        </Pressable>
      )}
      <ul className="attr-relation-list">
        {candidates.map((n) => (
          <li key={n.id}>
            <Pressable
              className="attr-relation-option"
              disabled={saving} onClick={() => { void choose(n.id); }}
            >
              {n.title}
            </Pressable>
          </li>
        ))}
        {candidates.length === 0 && <EmptyState size="inline" as="li" title={t("No matches")} />}
      </ul>
    </div>
  );
}
