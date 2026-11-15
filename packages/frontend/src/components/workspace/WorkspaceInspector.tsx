import { Suspense, useMemo } from "react";
import { lazyWithReload } from "../../lib/lazyWithReload";
import type { ContentNode } from "../../lib/api";
import { propertyWriter } from "../../lib/data";
import type { useWorkspaceFocus } from "../../hooks/useWorkspaceFocus";
import type { NoteCommand } from "../../modules";

const NodeInspector = lazyWithReload(() => import("../NodeInspector"));

type Props = {
  node: ContentNode | null;
  collapsed: boolean;
  /** The note's text is not on screen (another page, a board). */
  noHeadings?: boolean;
  nav: Pick<ReturnType<typeof useWorkspaceFocus>, "followLink" | "showBoardInLens">;
  /** Open a page by mode id (the 「功能」 tab's link to the Tasks page). */
  setMode: (mode: string) => void;
  refresh: () => Promise<void>;
  onOpenFullRelations: (id: string) => void;
  /** Phone Info screen: return to the note's content (a tapped heading is scrolled to there). */
  onShowContent?: () => void;
  /** Run a module's command on the open note (the info panel's 「功能」). */
  onRunNoteCommand?: (command: NoteCommand) => void;
};

/**
 * The single node inspector (doc 09: one lens-stable pane): the note's functions, tags and relations.
 * Its versions open from the note header (OverviewEditor) and the timeline. Used in notes
 * mode (inside the obsidian inner grid) and in every other lens (as a
 * .workspace-grid col-3 sibling) — the call sites are mutually exclusive by
 * mode, so only one ever mounts.
 */
export default function WorkspaceInspector({ node, collapsed, noHeadings, nav, setMode, refresh, onOpenFullRelations, onShowContent, onRunNoteCommand }: Props) {
  const functionNav = useMemo(() => ({ setMode, openCanvas: nav.showBoardInLens }), [setMode, nav.showBoardInLens]);
  return (
    <Suspense fallback={<div className="lazy-loading-pane" />}>
      <NodeInspector
        node={node}
        collapsed={collapsed}
        noHeadings={noHeadings}
        onSelectNode={(id) => { nav.followLink(id); }}
        onAttrUpsert={propertyWriter.set}
        onAttrRemove={propertyWriter.remove}
        onTagsChanged={refresh}
        onOpenFullRelations={onOpenFullRelations}
        onShowContent={onShowContent}
        onRunNoteCommand={onRunNoteCommand}
        functionNav={functionNav}
      />
    </Suspense>
  );
}
