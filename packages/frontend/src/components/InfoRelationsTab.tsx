import { useState } from "react";
import { CornerLeftUp, CornerRightDown, ArrowRight, ArrowLeft, Maximize2, ChevronDown, ChevronRight, Tag } from "lucide-react";
import type { ContentNode } from "../lib/api";
import { useEdgeKinds } from "../lib/edgeKinds";
import { useT } from "../lib/i18n";
import type { NoteRelation } from "../lib/noteNeighborhood";
import { PREFS, usePersistedFlag } from "../lib/prefs";
import { Button } from "./ui";
import { displayTitle } from "../lib/noteLabel";
import "./InfoTagsTab.css";
import { TAG_NODE_TYPE } from "@onden/markdown/contract";

/** Sub-notes listed before 「顯示全部」. */
export const CHILDREN_SHOWN = 5;

type Props = {
  node: ContentNode;
  /** noteNeighborhood(node, …).relations, computed once by the inspector. */
  relations: readonly NoteRelation[];
  onOpen: (id: string) => void;
  /** Open the graph page centred on this note (`?view=graph&focus=`). */
  onOpenFullRelations: (id: string) => void;
};

/** One relation per row: an icon, the note's title, a click opens it. */
function RelationList({ relations, icon: Icon, className = "", onOpen }: {
  relations: readonly NoteRelation[]; icon: typeof Tag; className?: string; onOpen: (id: string) => void;
}) {
  return (
    <ul className={`links-relation-list ${className}`.trim()}>
      {relations.map((r) => (
        <li key={r.node.id}>
          <Button variant="ghost" size="sm" className="links-relation-row" onClick={() => onOpen(r.node.id)}>
            <Icon size={13} aria-hidden="true" />
            <span className="links-relation-title">{displayTitle(r.node.title)}</span>
          </Button>
        </li>
      ))}
    </ul>
  );
}

// The info panel's 「關係」 tab: this note's connections as text, in three
// parts — the parent above, the sub-notes, the links in and out. The picture
// is the graph page's 「完整關係」.
export default function InfoRelationsTab({ node, relations, onOpen, onOpenFullRelations }: Props) {
  const t = useT();
  const edgeKinds = useEdgeKinds();
  const [allChildren, setAllChildren] = useState(false);
  // Folding the sub-notes is one habit for every note: a long list folded on
  // the Inbox stays folded on the next busy note.
  const [childrenOpen, setChildrenOpen] = usePersistedFlag(PREFS.infoSubNotesOpen, true);
  // A switch to another note starts with the short list again.
  const [stateFor, setStateFor] = useState(node.id);
  if (stateFor !== node.id) { setStateFor(node.id); setAllChildren(false); }

  if (relations.length === 0) return <p className="info-panel-quiet">{t("No connections yet.")}</p>;

  const parent = relations.find((r) => r.direction === "parent");
  // A tag's notes sit where a note's sub-notes do: the list below it.
  const isTag = node.node_type === TAG_NODE_TYPE;
  const children = relations.filter((r) => r.direction === (isTag ? "member" : "child"));
  const noteTags = relations.filter((r) => r.direction === "tag");
  const links = relations.filter((r) => r.direction === "in" || r.direction === "out");
  const shownChildren = allChildren ? children : children.slice(0, CHILDREN_SHOWN);
  const title = (n: ContentNode) => displayTitle(n.title);

  return (
    <div className="info-relations">
      <section className="info-relations-section" aria-labelledby="info-relations-parent">
        <h3 id="info-relations-parent" className="info-relations-heading">{t("Parent")}</h3>
        {parent ? (
          <Button variant="ghost" size="sm" className="links-relation-row" onClick={() => onOpen(parent.node.id)}>
            <CornerLeftUp size={13} aria-hidden="true" />
            <span className="links-relation-title">{title(parent.node)}</span>
          </Button>
        ) : <p className="info-panel-quiet">{t("Top level")}</p>}
      </section>

      <section className="info-relations-section" aria-labelledby="info-relations-children">
        <h3 id="info-relations-children" className="info-relations-heading">
          <Button variant="ghost" size="sm" className="info-relations-fold" aria-expanded={childrenOpen} onClick={() => setChildrenOpen((v) => !v)}>
            {childrenOpen ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
            {isTag ? t("Notes with this tag") : t("Sub-notes")} <span className="info-relations-count">{children.length}</span>
          </Button>
        </h3>
        {!childrenOpen ? null : children.length === 0 ? <p className="info-panel-quiet">{isTag ? t("No notes yet") : t("No sub-notes")}</p> : (
          <>
            <RelationList relations={shownChildren} icon={CornerRightDown} className="info-relations-children" onOpen={onOpen} />
            {children.length > CHILDREN_SHOWN && (
              <Button variant="ghost" size="sm" className="info-relations-more" aria-expanded={allChildren} onClick={() => setAllChildren((v) => !v)}>
                {allChildren ? t("Show fewer") : t("Show all {n}", { n: children.length })}
              </Button>
            )}
          </>
        )}
      </section>

      {noteTags.length > 0 && (
        <section className="info-relations-section" aria-labelledby="info-relations-tags">
          <h3 id="info-relations-tags" className="info-relations-heading">{t("Tags")}</h3>
          <RelationList relations={noteTags} icon={Tag} onOpen={onOpen} />
        </section>
      )}

      <section className="info-relations-section" aria-labelledby="info-relations-links">
        <h3 id="info-relations-links" className="info-relations-heading">{t("Links")}</h3>
        {links.length === 0 ? <p className="info-panel-quiet">{t("No links yet")}</p> : (
          <ul className="links-relation-list">
            {links.map((r) => {
              const Icon = r.direction === "out" ? ArrowRight : ArrowLeft;
              const direction = r.direction === "out" ? t("Links to") : t("Linked from");
              // A plain link already says 連到／被連結; only other kinds name themselves.
              const kind = r.edgeType && r.edgeType !== "knowledge_link" ? `${direction} · ${edgeKinds.label(r.edgeType)}` : direction;
              return (
                <li key={`${r.direction}-${r.edgeType ?? ""}-${r.node.id}`}>
                  <Button variant="ghost" size="sm" className="links-relation-row" onClick={() => onOpen(r.node.id)}>
                    <Icon size={13} aria-hidden="true" />
                    <span className="links-relation-title">{title(r.node)}</span>
                    <span className="links-relation-kind">{kind}</span>
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Button className="info-relations-full" onClick={() => onOpenFullRelations(node.id)}>
        <Maximize2 size={14} aria-hidden="true" />
        <span>{t("Full relations")}</span>
      </Button>
    </div>
  );
}
