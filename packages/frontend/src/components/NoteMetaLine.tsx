import { Suspense, useId, useState } from "react";
import type { ContentNode, Tag } from "../lib/api";
import { useT } from "../lib/i18n";
import { appliedNoteTags } from "../lib/nodeTags";
import { lazyWithReload } from "../lib/lazyWithReload";
import SpaceChip from "./SpaceChip";
import NoteEditedLine, { type OpenNoteHistory } from "./NoteEditedLine";
import TitleTagRow from "./TitleTagRow";
import "./NoteTagCards.css";
import { Chip } from "./ui";
import { isNote } from "@onden/markdown/contract";

// The card is drawn only once a chip opens it.
const NoteTagCards = lazyWithReload(() => import("./NoteTagCards"));

/** The one grey line under the note's title, the same at every width:
 *  「🔒 只有我 · 11 天前修改 · #標籤 ＋」. Who can see the note (the space,
 *  read-only, an AI / RSS source), when it changed (opens the history) and its
 *  tags (TitleTagRow: the chips and one ＋). Clicking a chip opens that tag's
 *  card (its fields and values) right below the line; clicking it again, or
 *  another chip, closes it or switches. The card links to the tag's own page. */
export default function NoteMetaLine({ node, tags, canEdit, online, onOpenTag, onMoved, onOpenHistory, aiEdits }: {
  node: ContentNode; tags: Tag[]; canEdit: boolean; online: boolean;
  onOpenTag: (tagId: string) => void;
  /** The note was moved to another space (SpaceChip). */
  onMoved?: () => void;
  onOpenHistory?: OpenNoteHistory;
  /** 「· AI 改過 N 次」 after the edit time. */
  aiEdits?: number;
}) {
  const t = useT();
  const cardId = useId();
  const [openTagId, setOpenTagId] = useState<string | null>(null);
  // Per note: another note opens with every card closed, also when you come back.
  const [openFor, setOpenFor] = useState(node.id);
  if (openFor !== node.id) { setOpenFor(node.id); setOpenTagId(null); }
  // A tag removed from the note closes its card too.
  const expandedTagId = openTagId && appliedNoteTags(node, tags).some((tag) => tag.id === openTagId) ? openTagId : null;
  const toggle = (tagId: string) => setOpenTagId(expandedTagId === tagId ? null : tagId);
  return (
    <section className="note-meta" aria-label={t("About this note")}>
      <div className="note-meta-line">
        <SpaceChip node={node} online={online} onMoved={onMoved} />
        {!canEdit && <span className="note-readonly-badge">{t("Read only")}</span>}
        {node.source_type !== "manual" && (
          <Chip tone={node.source_type === "ai" ? "info" : "warning"}>
            {node.source_type === "ai" ? "AI" : "RSS"}
          </Chip>
        )}
        {/* When it was last changed; the phrase opens the note's history. */}
        {node.updated_at && <NoteEditedLine updatedAt={node.updated_at} onOpenHistory={onOpenHistory} aiEdits={aiEdits} />}
        {/* A #word in the body is not a tag (T10) and is not listed here. */}
        {isNote(node) && (
          <TitleTagRow node={node} tags={tags} readOnly={!canEdit} onToggleTag={toggle}
            expandedTagId={expandedTagId} cardId={cardId} />
        )}
      </div>
      {expandedTagId && (
        <div id={cardId} className="note-meta-cards">
          <Suspense fallback={null}>
            <NoteTagCards key={`${node.id}:${expandedTagId}`} node={node} canEdit={canEdit}
              onOpenTag={onOpenTag} show={{ tagId: expandedTagId }} />
          </Suspense>
        </div>
      )}
    </section>
  );
}
