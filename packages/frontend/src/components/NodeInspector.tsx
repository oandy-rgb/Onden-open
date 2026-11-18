import { Suspense, memo, useMemo, useState, useSyncExternalStore } from "react";
import { parseBlocks } from "@onden/markdown";
import { blockAnchorsEnabled, watchAnchors } from "../lib/blockAnchorStore";
import { noteNeighborhood } from "../lib/noteNeighborhood";
import type { ContentNode } from "../lib/api";
import { useAppSelector, useOnline, useTagRows, useAllNodes } from "../lib/appStore";
import { useCapabilities } from "../lib/capabilities";
import "./OverviewEditor.css";
import "./InfoTagsTab.css";
import { useT } from "../lib/i18n";
import { infoTabsFor, initialInfoTab, pickedInfoTab, type InfoTab } from "../lib/infoPanel";
import { PREFS, getPref, setPref } from "../lib/prefs";
import { classNames } from "../lib/utils";
import InfoTagsTab, { infoCardTags } from "./InfoTagsTab";
import InfoRelationsTab from "./InfoRelationsTab";
import { useNoteFunctions } from "../hooks/useNoteFunctions";
import { useAiEnabled } from "../hooks/useModuleFilter";
import { useIsMobile } from "../hooks/useIsMobile";
import NoteSwitches, { useNoteSwitchList } from "./NoteSwitches";
import type { NoteCommand, NoteFunctionNav } from "../modules";
import { hasShownAttributes } from "./NodeAttributesPanel";
import { PaneResizer, Tab, TabList } from "./ui";
import EmptyState from "./EmptyState";
import { lazyWithReload } from "../lib/lazyWithReload";
import { aiLabel } from "../lib/actorLabel";

// The 「AI」 tab is loaded when it is opened: its code never reaches the app's first load.
const InfoAiTab = lazyWithReload(() => import("./infoAi"));
// The 「功能」 tab, likewise (its rows' wording comes with it).
const InfoFunctions = lazyWithReload(() => import("./InfoFunctions"));
// 「本篇的段落」 under the tag cards: loaded when the 「標籤」 tab is shown, never at boot.
const InfoParagraphs = lazyWithReload(() => import("./InfoParagraphs"));

// The right panel of the notes page, four tabs: 「功能」 (how the note ties into the
// other features: tasks, boards, the site…; the first tab) and 「標籤」 (one card per
// tag the note carries: its fields and the other notes with it) and 「關係」 (only this
// note's connections) and 「AI」 (ask about the note: components/infoAi). The note's
// headings are the edge outline beside its text (components/NoteEdgeOutline). The note's relationships (backlinks, mentions,
// canvases, parent, links, local graph) are under the note body: NoteRelations.
// Store data is self-sourced and BuilderApp's callbacks are identity-stable, so
// the memoized inspector skips renders for unrelated BuilderApp state (palette
// typing, dialogs, context menus).
type Props = {
  node: ContentNode | null;
  /** Open a note or a tag page from the panel. */
  onSelectNode: (id: string) => void;
  // Offline-aware attribute write handlers (Day 3 local-first work). Threaded
  // through to the tag cards' fields.
  onAttrUpsert?: (nodeId: string, key: string, value: string, opts?: { value_type?: string; is_inheritable?: boolean }) => Promise<unknown>;
  onAttrRemove?: (nodeId: string, key: string) => Promise<unknown>;
  /** Reload app data after a property is generalized into a tag's schema. */
  onTagsChanged?: () => void | Promise<void>;
  /** The 「關係」 tab's 「完整關係」: open the graph page centred on a note. */
  onOpenFullRelations?: (id: string) => void;
  /** Where the panel replaces the note's content (the phone's Info screen):
   *  a tapped heading first brings the content back, then scrolls to it. */
  onShowContent?: () => void;
  /** Honor the saved desktop visibility preference. */
  collapsed?: boolean;
  /** The note's text is not on screen (another page, a board): only its tags, no tabs. */
  noHeadings?: boolean;
  /** Run a module's command on the open note (the 「功能」 tab's buttons). */
  onRunNoteCommand?: (command: NoteCommand) => void;
  /** Where a 「功能」 row's link goes (the Tasks page, a whiteboard, a diary day). */
  functionNav?: Omit<NoteFunctionNav, "openNote" | "showContent">;
};

const NO_TAGS: never[] = [];
const NO_RUN = () => {};
// A saved 「段落」 (the retired tab) counts as never picked.
const readPickedTab = (): InfoTab | null => pickedInfoTab(getPref(PREFS.infoPanelTab));
const NO_NAV: NonNullable<Props["functionNav"]> = { setMode: () => {}, openCanvas: () => {} };

function NodeInspector({
  node,
  onSelectNode,
  onAttrUpsert, onAttrRemove, onTagsChanged, onOpenFullRelations, onShowContent,
  collapsed = false,
  noHeadings = false,
  onRunNoteCommand,
  functionNav = NO_NAV,
}: Props) {
  const t = useT();
  // Where the Info screen replaces the note (a phone) the AI is the bottom panel over the note (NotePhoneAiHost),
  // not a tab here: asking must not mean leaving the note.
  const phone = useIsMobile();
  const aiOn = useAiEnabled() && !phone;
  const online = useOnline();
  const tags = useTagRows() ?? NO_TAGS;
  const nodes = useAllNodes();
  const edges = useAppSelector((s) => s.data.edges);
  // A viewer (or only a viewer of the note's space) reads the fields only.
  const canEdit = useCapabilities(online).canEdit(node);
  // The tab the person picked by hand; until then it follows the note.
  const [picked, setPicked] = useState<InfoTab | null>(readPickedTab);
  const hasTags = useMemo(() => !!node && infoCardTags(node, tags).length > 0, [node, tags]);
  // Computed once here: the tab choice needs "has any", the 關係 tab lists them.
  const relations = useMemo(
    () => (noHeadings || !node ? [] : noteNeighborhood(node, nodes, edges, tags).relations),
    [noHeadings, node, nodes, edges, tags],
  );
  const hasRelations = relations.length > 0;
  // The 「功能」 tab is about the note on screen: not on a board's card.
  const functionsNode = noHeadings || !onRunNoteCommand ? null : node;
  const nav = useMemo<NoteFunctionNav>(() => ({ ...functionNav, openNote: onSelectNode, showContent: onShowContent }), [functionNav, onSelectNode, onShowContent]);
  const functionRows = useNoteFunctions(functionsNode, nav, onRunNoteCommand ?? NO_RUN);
  const noteSwitches = useNoteSwitchList(functionsNode, canEdit);
  // Old properties keep the tags tab worth opening on a note with no tag.
  const hasOldFields = !!node && hasShownAttributes(node.attrs);
  // So do paragraphs that carry a topic or a task (「本篇的段落」), whose topics are not the note's tags.
  const anchorsOn = useSyncExternalStore(watchAnchors, blockAnchorsEnabled, () => false);
  const body = node?.markdown ?? "";
  // Whether the text has a block that carries a `{…}`: the panel itself lists the ones the server anchored.
  const hasParagraphs = useMemo(() => anchorsOn && body.includes("{") && parseBlocks(body).some((b) => b.tags.length > 0), [anchorsOn, body]);

  // The shell's Info button owns visibility, including legacy collapsed state.
  if (collapsed) return null;

  if (!node) {
    return (
      <aside className="overview-activity">
        <PaneResizer side="inspector" />
        <EmptyState size="inline" className="ov-panel-empty--center" title={t("Select a node to see details")} />
      </aside>
    );
  }

  const hasFunctions = functionRows.length > 0 || noteSwitches.length > 0;
  const tab = noHeadings ? "tags" : initialInfoTab(picked, { hasFunctions, hasTags: hasTags || hasOldFields || hasParagraphs, hasRelations }, aiOn);
  const tagsEmpty = !hasTags && !hasOldFields && !hasParagraphs;
  const empty = !noHeadings && tagsEmpty && !hasRelations && !hasFunctions;
  const pick = (next: InfoTab) => { setPicked(next); setPref(PREFS.infoPanelTab, next); };
  const labels: Record<InfoTab, string> = { functions: t("Functions"), tags: t("Tags"), relations: t("Relations"), ai: aiLabel() };

  return (
    <aside className={classNames("overview-activity info-panel", tab === "ai" && "info-panel--ai")}>
      <PaneResizer side="inspector" />
      {!noHeadings && <TabList className="info-panel-tabs" label={t("Info")}>
        {infoTabsFor(aiOn).map((id) => (
          <Tab
            key={id}
            id={`info-tab-${id}`}
            selected={tab === id}
            controls="info-panel-body"
            className={classNames("info-panel-tab", tab === id && "is-active")}
            onClick={() => pick(id)}
          >{labels[id]}</Tab>
        ))}
      </TabList>}
      <div className="ov-inspector-details info-panel-body" id="info-panel-body" role={noHeadings ? undefined : "tabpanel"} aria-labelledby={noHeadings ? undefined : `info-tab-${tab}`}>
        {tab === "ai" ? <Suspense fallback={<p className="info-panel-quiet">{t("Loading…")}</p>}><InfoAiTab key={node.id} node={node} onSelectNode={onSelectNode} /></Suspense>
          : tab === "tags" && empty ? <p className="info-panel-quiet">{t("This note has no tags, features or connections yet.")}</p>
          // Picked by hand while the note has functions or relations but no tag: say so, not a blank panel.
          // The panel still loads: a parent may share values down to a note that has nothing itself ("From parent").
          : tab === "tags" && tagsEmpty && !noHeadings ? (
            <InfoTagsTab key={node.id} node={node} canEdit={canEdit} onOpen={onSelectNode} onAttrUpsert={onAttrUpsert} onAttrRemove={onAttrRemove}
              onTagsChanged={onTagsChanged} whenEmpty={<p className="info-panel-quiet">{t("No tags yet")}</p>} />
          )
          : tab === "functions" ? (
            <>
              <Suspense fallback={null}><InfoFunctions node={node} rows={functionRows} /></Suspense>
              <NoteSwitches node={node} switches={noteSwitches} />
            </>
          ) : tab === "tags" ? (
            <>
              <InfoTagsTab
                key={node.id}
                node={node}
                canEdit={canEdit}
                onOpen={onSelectNode}
                onAttrUpsert={onAttrUpsert}
                onAttrRemove={onAttrRemove}
                onTagsChanged={onTagsChanged}
              />
              <Suspense fallback={null}><InfoParagraphs key={node.id} node={node} canEdit={canEdit} onOpen={onSelectNode} /></Suspense>
            </>
          ) : <InfoRelationsTab node={node} relations={relations} onOpen={onSelectNode} onOpenFullRelations={onOpenFullRelations ?? onSelectNode} />}
      </div>
    </aside>
  );
}

export default memo(NodeInspector);
