import { useMemo } from "react";
import { Pressable } from "../../components/ui";
import { ArrowLeft, ExternalLink } from "lucide-react";
import type { ContentNode, NodeEdge, Tag } from "../../lib/api";
import AllCardsGraph from "./AllCardsGraph";
import { isSystemNode, tagsById } from "../../lib/systemNodes";
import { isShownNote } from "../../lib/nodeTags";
import { recenterGraph, useGraphFocus } from "../../hooks/useUrlLocation";
import { graphRoles, noteNeighborhood } from "../../lib/noteNeighborhood";
import "../../components/NodeLenses.css";
import { useT } from "../../lib/i18n";
import { displayTitle } from "../../lib/noteLabel";

// THE graph page: the whole workspace on one force graph (what the All Cards
// canvas tab used to show — it was never a canvas). With `?view=graph&focus=<noteId>`
// it is 「完整關係」 instead: one note in the middle with its parent above,
// links in on the left, links out on the right, sub-notes below and its tags in a row above the parent, on the same
// graph component. The info panel's 「關係」 tab links here.

type Props = {
  /** The note the graph highlights, if one is open. */
  selectedNodeId: string | null;
  nodes: ContentNode[];
  edges: NodeEdge[];
  tags: Tag[];
  /** Open a note in the notes page. */
  onSelectNode: (id: string) => void;
};

export default function LocalGraphLens({ selectedNodeId, nodes, edges, tags, onSelectNode }: Props) {
  const t = useT();
  const focusId = useGraphFocus();
  // System machinery (workspace-config tag, system-source rows) and hidden
  // nodes are infrastructure, not notes — they leaked into the global graph
  // (audit ⑧ punch #2).
  const tagIndex = useMemo(() => tagsById(tags), [tags]);
  const graphNodes = useMemo(
    () => nodes.filter((n) => isShownNote(n) && !isSystemNode(n, tagIndex)),
    [nodes, tagIndex],
  );
  const center = useMemo(() => (focusId ? graphNodes.find((n) => n.id === focusId) ?? null : null), [focusId, graphNodes]);
  const neighborhood = useMemo(
    () => center ? noteNeighborhood(center, graphNodes, edges, tags) : null,
    [center, graphNodes, edges, tags],
  );
  const focus = useMemo(
    () => center && neighborhood ? { centerId: center.id, roles: graphRoles(neighborhood.relations) } : undefined,
    [center, neighborhood],
  );

  return (
    <div className="node-lens-pane node-lens-graph">
      <header className="node-lens-header">
        <h2 className="node-lens-title">
          {center ? t("Relations · {title}", { title: displayTitle(center.title) }) : t("Links")}
        </h2>
        {center ? (
          <div className="node-lens-actions">
            <Pressable type="button" className="node-lens-action" onClick={() => onSelectNode(center.id)}>
              <ArrowLeft size={14} aria-hidden="true" /><span>{t("Back to note")}</span>
            </Pressable>
            <Pressable type="button" className="node-lens-action" onClick={() => onSelectNode(center.id)}>
              <ExternalLink size={14} aria-hidden="true" /><span>{t("Open this one")}</span>
            </Pressable>
          </div>
        ) : <span className="node-lens-sub">{t("every note and how they connect")}</span>}
      </header>
      <div className="node-lens-graph-body">
        {center && neighborhood && focus ? (
          <AllCardsGraph
            nodes={neighborhood.localNodes}
            edges={neighborhood.localEdges}
            tags={tags}
            selectedNodeId={center.id}
            onNodeClick={(id) => { if (id !== center.id) recenterGraph(id); }}
            arrows
            focus={focus}
          />
        ) : (
          <AllCardsGraph
            nodes={graphNodes}
            edges={edges}
            tags={tags}
            selectedNodeId={selectedNodeId}
            onNodeClick={onSelectNode}
          />
        )}
      </div>
    </div>
  );
}
