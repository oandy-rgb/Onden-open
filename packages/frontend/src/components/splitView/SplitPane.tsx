import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeftRight, X } from "lucide-react";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { useAppSelector, useOnline, useTagRows, useAllNodes } from "../../lib/appStore";
import { dataSync, nodeActions } from "../../lib/data";
import { nodeNeedsBody } from "../../lib/api";
import { useCapabilities } from "../../lib/capabilities";
import { useT } from "../../lib/i18n";
import { displayTitle } from "../../lib/noteLabel";
import { CANVAS_TAB, CONTENT_TAB, defaultTabKey } from "../../lib/viewTabs";
import { isModClick, type PaneTarget } from "../../lib/splitView";
import { splitDrag } from "../../lib/splitViewStore";
import { viewLabel } from "../../hooks/shellNavigation";
import { Button, Menu, MenuItem, usePopover } from "../ui";
import { OwnerViewPane, useOwnerTabs, useViewOwner } from "../viewTabs";
import EmptyState from "../EmptyState";
import SecondaryLensOutlet from "../SecondaryLensOutlet";
import QuickNote from "./QuickNote";

const OverviewPreview = lazyWithReload(() => import("../OverviewPreview"));
import "./SplitView.css";
import { TAG_NODE_TYPE } from "@onden/markdown/contract";

const SchemaLens = lazyWithReload(() => import("../tagPage"));

type OutletProps = Omit<Parameters<typeof SecondaryLensOutlet>[0], "mode" | "onOpenNote" | "onOpenNoteFromAgenda" | "moduleTarget" | "onImmersiveChange">;

type Props = {
  target: PaneTarget;
  outlet: OutletProps;
  /** Open a note on the LEFT (a function page here never replaces itself). */
  onOpenNoteLeft: (id: string) => void;
  /** The note's view in this pane changed. */
  onChangeTarget: (target: PaneTarget) => void;
  onSwap: () => void;
  onClose: () => void;
  refresh: () => Promise<void>;
};

/** The right pane: a header (name · view ▾ for a note or tag, the function's
 *  name for a page; ⇄ swap; ✕ close) over the same components the left side
 *  uses — a function page is the one SecondaryLensOutlet, a saved view is
 *  OwnerViewPane, a tag's page is the tag page. A note's TEXT is read here
 *  and written through 「記一下」 (QuickNote): only the left side has an
 *  editor, so two editors never hold one note (docs/agents/decisions-ui.md). */
export default function SplitPane({ target, outlet, onOpenNoteLeft, onChangeTarget, onSwap, onClose, refresh }: Props) {
  const t = useT();
  const nodes = useAllNodes();
  const tags = useTagRows();
  const online = useOnline();
  const { canEdit } = useCapabilities(online);
  const node = target.kind === "note" ? nodes.find((n) => n.id === target.id) ?? null : null;
  // A large workspace keeps bodies out of memory (lib/slimMode.ts) and hydrates only the left's note:
  // the right one is fetched here, or it would read as a title over nothing.
  const needsBody = !!node && nodeNeedsBody(node);
  // Offline there is nothing to fetch from: it is fetched when the connection comes back.
  useEffect(() => { if (needsBody && node && online) void dataSync.hydrateNode(node.id); }, [needsBody, node?.id, online]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed on the note, whether its body is missing, and the connection
  // 並排: the note open in the left editor shows here as it is typed (the draft), not as last saved.
  const draft = useAppSelector((s) => (node && s.selectedId === node.id ? s.overviewDraft : null));
  const tag = target.kind === "note" && !node ? tags?.find((g) => g.id === target.id) ?? null : null;
  const info = useViewOwner(node, tag);
  const ownerRef = useMemo(() => (info ? { kind: info.owner.kind, id: info.owner.id } : null), [info?.owner.kind, info?.owner.id]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed by the owner's identity
  const activeKey = target.kind === "note" ? target.tab : CONTENT_TAB;
  const { tabs, status } = useOwnerTabs(ownerRef, { earnsWhiteboard: info?.hasBoard ?? false, canManage: info?.canManage ?? false, activeKey });
  // 「內容」 was removed from the note's tab row (here or on the left, which read the same views): this side shows the
  // note's default tab instead of a tab no row names. Once the views are known; a saved view's id stays valid until they say otherwise.
  const tabGone = target.kind === "note" && !!info && status === "ready" && !tabs.some((tab) => tab.key === activeKey);
  useEffect(() => {
    if (tabGone && target.kind === "note" && target.tab === CONTENT_TAB) onChangeTarget({ ...target, tab: defaultTabKey(tabs) });
  }, [tabGone, target, tabs, onChangeTarget]);
  const [viewMenu, setViewMenu] = useState(false);
  const pop = usePopover<HTMLButtonElement>({ open: viewMenu, onClose: () => setViewMenu(false), placement: "bottom-start" });

  const name = target.kind === "page" ? t(viewLabel(target.mode)) : info?.owner.name ?? displayTitle(node?.title);
  const tabName = tabs.find((tab) => tab.key === activeKey)?.name ?? t("Content");

  let body: ReactNode;
  if (target.kind === "page") {
    body = <SecondaryLensOutlet {...outlet} mode={target.mode} moduleTarget={null} onImmersiveChange={() => {}}
      onOpenNote={onOpenNoteLeft} onOpenNoteFromAgenda={onOpenNoteLeft} />;
  } else if (!node && !tag) {
    body = <EmptyState variant="notFound" size="inline" title={t("This note is no longer available.")} />;
  } else if (target.tab === CANVAS_TAB) {
    body = <EmptyState size="inline" title={t("The whiteboard opens on the left. Use ⇄ to bring it there.")} />;
  } else if (target.tab !== CONTENT_TAB && info) {
    body = <OwnerViewPane info={info} viewId={target.tab} onOpenNote={onOpenNoteLeft} onOpenView={(key) => onChangeTarget({ ...target, tab: key })} onSaved={refresh} />;
  } else if (tag) {
    body = (
      <Suspense fallback={<div className="lazy-loading-pane" />}>
        <SchemaLens tag={tag} online={online} onSaved={refresh} nodes={nodes} onOpenNode={onOpenNoteLeft} allTags={tags ?? []}
          onDeleteNode={nodeActions.delete} canManage={canEdit({ node_type: TAG_NODE_TYPE, space_id: null })} onOpenTagsOverview={() => {}} />
      </Suspense>
    );
  } else if (node) {
    body = (
      <>
        {/* The note page's own preview (OverviewPreview, in the note's type and measure): the right
            reads exactly like 預覽 on the left. */}
        <div className="obsidian-main note-document split-pane-text" data-split-text>
          <h1 className="view-pane-title">{displayTitle(node.title)}</h1>
          <Suspense fallback={<div className="obsidian-preview obsidian-preview--md" />}>
            <OverviewPreview draft={draft ?? node.markdown ?? ""} nodes={nodes} from={node} onOpenWikilink={(_slug, nodeId) => {
              // A plain click opens where it was clicked (the right stays the right); Ctrl/⌘ sends it to the other side.
              if (!nodeId) return;
              if (isModClick(performance.now())) onOpenNoteLeft(nodeId); else onChangeTarget({ kind: "note", id: nodeId, tab: CONTENT_TAB });
            }} />
          </Suspense>
        </div>
        {/* 並排 (this note is in the left editor): written there, so no second writer here. */}
        {draft === null && <QuickNote noteId={node.id} />}
      </>
    );
  }

  return (
    <aside className="split-pane" aria-label={t("Right side: {name}", { name })} data-split-side="right">
      <header className="split-pane-head">
        <span className="split-pane-name"
          draggable onDragStart={(event) => { event.dataTransfer.setData("text/plain", name); event.dataTransfer.effectAllowed = "move"; splitDrag.begin(target, "right-header"); }}
          onDragEnd={() => { splitDrag.cancel(); }}
          title={t("Drag to the left to read it there")}>{name}</span>
        {target.kind === "note" && tabs.length > 1 && (
          <>
            <Button ref={pop.anchor} variant="ghost" size="sm" aria-haspopup="menu" aria-expanded={viewMenu}
              onClick={() => setViewMenu((open) => !open)}>· {tabName} ▾</Button>
            {viewMenu && (
              <Menu popover={pop} label={t("Views of {name}", { name })}>
                {tabs.map((tab) => (
                  <MenuItem key={tab.key} onSelect={() => onChangeTarget({ ...target, tab: tab.key })}>{tab.name}</MenuItem>
                ))}
              </Menu>
            )}
          </>
        )}
        <span className="split-pane-spacer" />
        <Button variant="icon" size="sm" aria-label={t("Swap sides")} title={t("Swap sides")} onClick={onSwap}>
          <ArrowLeftRight size={15} aria-hidden="true" />
        </Button>
        <Button variant="icon" size="sm" aria-label={t("Close the right side")} title={t("Close the right side")} onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </Button>
      </header>
      <div className="split-pane-body">{body}</div>
    </aside>
  );
}
