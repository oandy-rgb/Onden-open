import { SnippetText } from "./SnippetText";
import { useDismiss } from "../hooks/useEscapeKey";
import React, { Suspense, memo, useState, useMemo, useRef, useEffect, useId, useCallback } from "react";
import { MoreHorizontal, Pin, Plus, Search, Trash2 } from "lucide-react";
import { holdSurface } from "../lib/touchHold";
import "./OverviewSidebar.css";
import "../styles/sidebar.css";
import type { ContentNode, NotePointer } from "../lib/api";
import { flattenSidebarTree, groupRootsBySpace, sidebarWindow, type FlatRow } from "../lib/sidebarFlatten";
import { tidySidebarRoots, withoutTasksNote } from "../lib/sidebarTidy";
import { compareChildren } from "../lib/childOrder";
import { noteLabel, untitledTitle } from "../lib/noteLabel";
import { spaceLabel, useSpaces } from "../lib/spaces";
import SpaceHeading from "./SpaceHeading";
import SpaceEmptyRow from "./SpaceEmptyRow";
import { writableSpaces } from "../lib/newNoteTarget";
import { t, useT, tn } from "../lib/i18n";
import { useOverviewSearch } from "../hooks/useOverviewSearch";
import { useAppSelector, setOverviewPane, setOverviewSearch, openOverviewSearch, closeOverviewSearch, consumeOverviewSearchFocus, selectOverviewNodes, selectOverviewSelectedNode, useOnline, useTagRows, useAllNodes } from "../lib/appStore";
import EmptyState from "./EmptyState";
import { classNames, groupNodes } from "../lib/utils";
import { noteActionsFor } from "../lib/data";
import { useCapabilities } from "../lib/capabilities";
import { useModuleFilter } from "../hooks/useModuleFilter";
import { useIsMobile } from "../hooks/useIsMobile";
import { useKbdHint } from "../hooks/useKbdHint";
import { isPinned, noteColor } from "../lib/noteMarks";
import RenameInput from "./RenameInput";
import { SearchOfflineNotice } from "./SearchOfflineNotice";
import { usePopover, Menu, MenuItem, MenuLabel, MenuSeparator, PaneResizer, SearchField, Pressable, layerClass } from "./ui";
import type { CreateSheetRequest } from "./CreateSheet";
import { lazyWithReload } from "../lib/lazyWithReload";
import SidebarTagTree, { type TagTabTools } from "./SidebarTagTree";
import { splitTagSections, tagParentIds, TAG_SORT_KEYS } from "../lib/tagTree";
import { PREFS, getPref, setPref, usePersistedChoice } from "../lib/prefs";
import type { CreateFn } from "../hooks/useNodeCreation";
import type { SidebarNav, SidebarNodeActions, SidebarRename, SidebarTree } from "./sidebarGroups";
import { byUpdatedDesc } from "../lib/noteOrder";
import { observeSize } from "../lib/observeSize";
import { INBOX_PAGE } from "../modules";
import NavMarks from "./NavMarks";
import { onWindow, windowHeight } from "../lib/globalEvents";
import { TAG_NODE_TYPE, isTag } from "@onden/markdown/contract";




// Not on the first screen: fetched when ＋ (or 新筆記放在…) first opens it; kept for offline by lib/offlineWarmup.ts.
const CreateSheet = lazyWithReload(() => import("./CreateSheet"));

// H4: pane/tag/search state and the Bootstrap-derived lists come from
// lib/appStore through selectors inside the component, not props. The props
// are the groups WorkspaceSidebar builds once with stable identities
// (sidebarGroups.ts); each part takes the groups it uses.
type Props = {
  nav: SidebarNav;
  actions: SidebarNodeActions;
  rename: SidebarRename;
  tree: SidebarTree;
  create: CreateFn;
  /** Create a tag by name from the tag panel's "+" (the caller navigates). */
  onCreateTag?: (name: string) => Promise<void> | void;
};

/** The row buttons the arrow keys walk: note rows, the tag section's header and tag rows. */
const NAV_ROWS = ".obsidian-page-button, .sb-tagtree-section-toggle, .sb-tagtree-name";

/** The sidebar list's sort orders; the chosen one is remembered on this device. */
const SORT_KEYS = ["natural", "modified", "title", "created"] as const;

function OverviewSidebar({ nav, actions, rename, tree, create, onCreateTag }: Props) {
  const { openNote } = nav;
  const { expandedGroups } = tree;
  useT(); // re-render this chrome on a language switch (labels via t())
  const isImported = useModuleFilter();
  // H4 store subscriptions — this is exactly the slice the sidebar reads, so
  // typing in the editor (draft slice) never re-renders it, while typing in
  // the search box re-renders the SIDEBAR only.
  const storedPane = useAppSelector((s) => s.overviewPane);
  const mobileLayout = useIsMobile();
  // 收件匣 is a tab beside 筆記 on every screen; 標籤 is a phone tab (on a
  // wide screen the tags are the section under the notes). Without the inbox
  // module there is no inbox tab.
  const InboxPage = INBOX_PAGE?.Component;
  const inboxMark = INBOX_PAGE?.Mark;
  const overviewPane = (storedPane === "tags" && !mobileLayout) || (storedPane === "inbox" && !InboxPage) ? "nodes" : storedPane;
  // The phone remembers its last tab (per device). Restored once per page
  // mount; every later change (e.g. opening search jumps to 筆記) is stored
  // too, so a remount reads back what is shown.
  const paneRestoredRef = useRef(false);
  useEffect(() => {
    if (!mobileLayout) return;
    if (!paneRestoredRef.current) {
      paneRestoredRef.current = true;
      const saved = getPref(PREFS.sidebarPane);
      if (saved === "tags" || saved === "nodes" || saved === "inbox") { if (saved !== storedPane) setOverviewPane(saved); return; }
    }
    setPref(PREFS.sidebarPane, storedPane);
  }, [mobileLayout, storedPane]);
  const online = useOnline();
  const overviewNodes = useAppSelector(selectOverviewNodes);
  // The Open/Close-all toggle: computed once per node list, not per render.
  const groupIdsOfList = useMemo(() => groupNodes(overviewNodes).map((n) => n.id), [overviewNodes]);
  const overviewSelectedNode = useAppSelector(selectOverviewSelectedNode);
  const pointers = useAppSelector((s) => s.data.pointers);
  const tags = useTagRows();
  const allNodes = useAllNodes();
  // A row's trash button shows exactly when Delete is in the note's action
  // list (lib/data noteActionList, D112): not for a reserved tag, and not for
  // a viewer, whose delete the server refuses (403 → rollback).
  const caps = useCapabilities(online);
  const canDeleteRow = useMemo(() => (node: ContentNode) =>
    noteActionsFor(node, { canEdit: caps.canEdit(node), isOwner: caps.isOwner, online, tags, isImported }).has("delete"), [caps, online, tags, isImported]);
  const { overviewSearch, overviewSearchResults, overviewSearchOutcome, overviewSearchFailed } = useOverviewSearch();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchExpanded = useAppSelector((s) => s.overviewSearchOpen);
  const searchFocusPending = useAppSelector((s) => s.overviewSearchFocusPending);
  const searchOpen = searchExpanded || !!overviewSearch;
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const searchKeys = useKbdHint("focus-search");
  const searchId = useId();
  useEffect(() => {
    if (!searchInputRef.current || overviewPane !== "nodes" || !consumeOverviewSearchFocus()) return;
    searchInputRef.current.focus();
    searchInputRef.current.select();
  }, [searchFocusPending, overviewPane]);
  const closeSearch = () => {
    closeOverviewSearch();
    searchToggleRef.current?.focus();
  };
  // Back closes the search box (and its results) first; on the phone's list it would otherwise leave the app.
  useDismiss(closeSearch, searchOpen && overviewPane === "nodes");

  const [searchIdx, setSearchIdx] = useState(0);
  useEffect(() => setSearchIdx(0), [overviewSearchResults]);

  const [sortBy, setSortBy] = usePersistedChoice(PREFS.sidebarSort, SORT_KEYS, "natural");
  const [sortDropOpen, setSortDropOpen] = useState(false);
  const sortMenu = usePopover({ open: sortDropOpen, onClose: () => setSortDropOpen(false), placement: "bottom-start" });
  // The phone's ⋯ menu (both tabs) and the ＋ create sheet (phone sheet / desktop popover from the ＋).
  const [moreOpen, setMoreOpen] = useState(false);
  const moreMenu = usePopover({ open: moreOpen, onClose: () => setMoreOpen(false), placement: "bottom-end" });
  const [sheet, setSheet] = useState<CreateSheetRequest | null>(null);
  // The ＋ opens a popover on desktop only; on the phone the same request is a
  // bottom sheet (Modal), and a live popover would take every tap inside the
  // sheet for an outside tap and close it.
  const createPopover = usePopover<HTMLElement>({ open: sheet !== null && !mobileLayout, onClose: () => setSheet(null), placement: "bottom-start" });
  const [tagSort, setTagSort] = usePersistedChoice(PREFS.sidebarTagSort, TAG_SORT_KEYS, "count");
  const [tagOpen, setTagOpen] = useState<ReadonlySet<string>>(new Set());

  const SORT_LABELS: Record<string, string> = { natural: t("Order"), modified: t("Modified"), title: t("Title"), created: t("Created date") };

  const visibleNodes = useMemo(() => {
    return [...overviewNodes].sort((a, b) => {
      // Pinned notes (⋯ › 釘選) lead their siblings, whatever the sort.
      const pin = Number(isPinned(b)) - Number(isPinned(a));
      if (pin) return pin;
      if (sortBy === "title") return a.title.localeCompare(b.title);
      // Newest first, like "modified". The store's array order means nothing:
      // a synced or edited row is moved to its end.
      if (sortBy === "created") return (b.created_at ?? "").localeCompare(a.created_at ?? "");
      if (sortBy === "modified") return byUpdatedDesc(a, b);
      // Natural order is the sibling order every other surface shows.
      return compareChildren(a, b);
    });
  }, [overviewNodes, sortBy]);

  // Tree children index — renderItem used to run visibleNodes.filter() for
  // EVERY row, making each sidebar render O(N²) over the workspace (9M
  // comparisons at 3k notes — the single biggest list-jank source). One pass
  // builds the parent→children index; lookups are O(1) per row.
  // Tags are listed once, under TAGS below (a chip opens the tag's page), not
  // again among the notes. A note filed under a tag node shows at the top
  // level — a hidden tag too (D104: its row is in no list, from the catalog),
  // and so does a note under a hidden row (a note hidden before only tags
  // could be): a hidden parent never takes its children out of the list.
  const tagNodeIds = useMemo(
    () => new Set([
      ...visibleNodes.filter((n) => isTag(n)).map((n) => n.id),
      ...(tags ?? []).map((tag) => tag.id),
      ...allNodes.filter((n) => n.hidden).map((n) => n.id),
    ]),
    [visibleNodes, tags, allNodes],
  );
  const treeChildren = useMemo(() => {
    const map = new Map<string, ContentNode[]>();
    for (const n of visibleNodes) {
      if (!n.parent_id || isTag(n) || tagNodeIds.has(n.parent_id)) continue;
      const arr = map.get(n.parent_id);
      if (arr) arr.push(n); else map.set(n.parent_id, [n]);
    }
    return map;
  }, [visibleNodes, tagNodeIds]);

  // Look up the pointer rows whose parent_id matches a given node id —
  // the tree renderer unions these with the parent_id children to get the
  // full visible child list. Memoised once per pointers prop change.
  const pointersByParent = useMemo(() => {
    const map = new Map<string, NotePointer[]>();
    for (const p of pointers ?? []) {
      if (!p.parent_id) continue;
      const arr = map.get(p.parent_id) ?? [];
      arr.push(p);
      map.set(p.parent_id, arr);
    }
    return map;
  }, [pointers]);

  // ④ virtualization: past this row count the tree renders through a scroll
  // window (top/bottom spacers + slice) instead of materializing every row.
  // Small workspaces keep the recursive render (nested group guides intact).
  const VIRT_THRESHOLD = 300;
  // Row pitch (row height + grid gap) is MEASURED from the live DOM on
  // scroll: a hardcoded estimate drifts when the design system restyles rows
  // (1px/row across 350 rows left the tree's tail unreachable — the bottom
  // spacer under-sized the scroll range). 35 = boot fallback until the first
  // windowed render gives us real rows to measure.
  const [virtRow, setVirtRow] = useState(35);
  const VIRT_OVERSCAN = 12;
  const [virtScroll, setVirtScroll] = useState({ top: 0, viewport: 800 });
  // ≤900px the sidebar doesn't scroll — the PAGE does (height:auto,
  // overflow:visible; a list that scrolls itself swallows the touch drag,
  // mobileListScroll.spec). There the window is keyed on where the list sits
  // in the browser viewport instead of on the list's own scrollTop (the
  // effect below). Same boundary as the mobile layout media query.
  const pageListRef = useRef<HTMLDivElement | null>(null);
  const pageListEl = useCallback((el: HTMLDivElement | null) => { pageListRef.current = el; holdSurface(el); }, []);
  // Top-level rows for both the plain and the virtualized list.
  const treeRoots = useMemo(
    () => visibleNodes.filter((n) => !isTag(n) && (!n.parent_id || tagNodeIds.has(n.parent_id))),
    [visibleNodes, tagNodeIds],
  );
  // Generated nodes (RSS sources/articles) go where they belong (lib/sidebarTidy);
  // the tree has no switch to bring them back. Nesting is the real parent/child only.
  const { spaces: mySpaces, loaded: spacesLoaded } = useSpaces(online);
  const spaceIds = useMemo(() => mySpaces.map((sp) => sp.id), [mySpaces]);
  const tidy = useMemo(() => tidySidebarRoots(treeRoots, tags ?? [], spaceIds), [treeRoots, tags, spaceIds]);
  const rootNodes = tidy.roots;
  const childrenByParent = useMemo(() => withoutTasksNote(treeChildren, spaceIds), [treeChildren, spaceIds]);
  // Top-level notes are grouped under their space (docs/architecture/spaces.md
  // 「介面」): personal first, then shared ones — once more than one space has
  // notes (a single group needs no heading).
  const sharedSpaceIds = useMemo(() => new Set(mySpaces.filter((sp) => sp.kind === "shared").map((sp) => sp.id)), [mySpaces]);
  // A space where a note may be made shows even with no notes in it yet (「還沒有筆記」 and a ＋).
  const writableSpaceIds = useMemo(() => new Set(writableSpaces(mySpaces).map((sp) => sp.id)), [mySpaces]);
  const spaceGroups = useMemo(() => {
    const bySpace = spacesLoaded
      ? groupRootsBySpace(rootNodes, mySpaces.map((sp) => ({ id: sp.id, label: spaceLabel(sp) })), t("Other"), writableSpaceIds)
      : [];
    return bySpace.length > 1 ? bySpace : null;
  }, [spacesLoaded, rootNodes, mySpaces, writableSpaceIds]);
  // 「還沒有筆記」 is said of a space that holds no note at all — not of one whose notes the tree leaves out (hidden,
  // made by a module, pending). Only the app's own hidden machinery (the 任務 note…) does not count as a note.
  const spacesWithNotes = useMemo(
    () => new Set(allNodes.filter((n) => !isTag(n) && !(n.hidden && n.source_type === "system")).map((n) => n.space_id)),
    [allNodes],
  );
  const spaceLabels = useMemo(() => new Map(mySpaces.map((sp) => [sp.id, spaceLabel(sp)])), [mySpaces]);
  const createInSpace = useCallback((spaceId: string) => { void create("note", { spaceId }); }, [create]);
  const flatRows = useMemo(
    () => flattenSidebarTree(rootNodes, childrenByParent, pointersByParent, expandedGroups, spaceGroups),
    [rootNodes, childrenByParent, pointersByParent, expandedGroups, spaceGroups],
  );
  // Phones need the window most: a 5,000-note list drew every row, and each
  // layout read (editor selection, top-bar measuring) then cost seconds on a
  // mid-range phone (measured 2026-10-19: relaunch 9 s at 5k notes, ~50 s at 20k).
  const virtualized = flatRows.length > VIRT_THRESHOLD;
  // Re-measure the real row pitch from the contiguous rendered slice.
  function measureRowPitch(list: HTMLElement) {
    const rows = list.querySelectorAll<HTMLElement>("[data-sb-id]");
    if (rows.length < 2) return;
    const pitch = (rows[rows.length - 1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top) / (rows.length - 1);
    if (pitch > 8 && Math.abs(pitch - virtRow) > 0.5) setVirtRow(pitch);
  }
  const measureRowPitchRef = useRef(measureRowPitch);
  measureRowPitchRef.current = measureRowPitch;
  const pageScrolledWindow = virtualized && mobileLayout;
  useEffect(() => {
    if (!pageScrolledWindow) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const list = pageListRef.current;
      // Hidden (a note is open full-screen): nothing to window, and measuring
      // would only force layouts while the person types.
      if (!list || list.getClientRects().length === 0) return;
      measureRowPitchRef.current(list);
      const top = Math.max(0, -list.getBoundingClientRect().top);
      const viewport = windowHeight();
      setVirtScroll((prev) => (prev.top === top && prev.viewport === viewport ? prev : { top, viewport }));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    // Capture: also hear an ancestor that scrolls instead of the document.
    const stopScroll = onWindow("scroll", schedule, { passive: true, capture: true });
    const stopResize = onWindow("resize", schedule, { passive: true });
    // Coming back from a note shows the list again, often at another page
    // scroll and without a scroll event: its box changing re-reads the window.
    const stopShown = observeSize(pageListRef.current, schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      stopScroll();
      stopResize();
      stopShown();
    };
  }, [pageScrolledWindow]);

  function renderPointerRow(p: NotePointer, depth: number): React.ReactNode {
    const target = overviewNodes.find((n) => n.id === p.target_id);
    if (!target) return null;
    const indentPx = depth * 16;
    return (
      <div
        key={`ptr-${p.id}`}
        className={classNames(
          "obsidian-page-row",
          depth > 0 && "obsidian-page-row--child",
          "obsidian-page-row--pointer",
        )}
        style={depth > 0 ? ({ "--sb-indent": `${indentPx}px` } as React.CSSProperties) : undefined}
        data-sb-id={`ptr-${p.id}`}
        data-sb-kind="pointer"
      >
        <Pressable
          className={classNames("obsidian-page-button", overviewSelectedNode?.id === target.id && "active")}
          onClick={() => openNote(target.id)}
          onContextMenu={(e) => actions.openContextMenu(e, "sidebar-pointer", p.id, p.target_id)}
          title={t("📎 Pinned reference to \"{title}\"", { title: target.title })}
        >
          <span className="obsidian-pointer-icon" aria-hidden>📎</span>
          {p.display_prefix ? `${p.display_prefix} ` : ""}{target.title}
        </Pressable>
      </div>
    );
  }

  // A touch held and let go in place opens the row's menu (the drag hook's
  // onHoldRelease) — the same menu a right click opens.
  const holdMenu = (id: string) => (x: number, y: number) =>
    actions.openContextMenu({ clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} } as React.MouseEvent, "sidebar-node", id);

  const dropTitle = (space?: string) => (space ? t("Move to {space}", { space }) : undefined);

  function renderItem(item: ContentNode, depth: number, visited: Set<string>, flat = false): React.ReactNode {
    if (visited.has(item.id)) return null;
    const nextVisited = new Set(visited).add(item.id);
    const children = childrenByParent.get(item.id) ?? [];
    const pointerChildren = pointersByParent.get(item.id) ?? [];
    const isGroup = children.length > 0 || pointerChildren.length > 0;
    const expanded = expandedGroups.has(item.id);
    const dt = tree.dropTarget;
    const isDragging = tree.dragId === item.id;
    const indentPx = depth * 16;
    const isTagNode = isTag(item);

    if (isGroup) {
      return (
        <div
          key={item.id}
          className={classNames(
            "obsidian-group",
            isDragging && "sb-dragging",
            dt?.id === item.id && dt.pos === "above" && "sb-drop-above",
            dt?.id === item.id && dt.pos === "below" && "sb-drop-below",
            dt?.id === item.id && dt.pos === "into" && "sb-drop-into",
            tree.springHint?.id === item.id && "sb-drop-spring",
          )}
          style={tree.springHint?.id === item.id ? ({ "--sb-spring-ms": `${tree.springHint.ms}ms` } as React.CSSProperties) : undefined}
          data-sb-id={item.id}
          title={dt?.id === item.id ? dropTitle(dt.moveTo) : undefined}
          data-sb-kind="group"
          data-sb-expanded={expanded ? "true" : "false"}
          onPointerDown={(e) => tree.onPointerDown(e, item, true, holdMenu(item.id))}
        >
          <div
            className={classNames("obsidian-group-header", depth > 0 && "obsidian-group-header--indented")}
            style={depth > 0 ? ({ "--sb-indent": `${indentPx}px` } as React.CSSProperties) : undefined}
          >
            <Pressable className="obsidian-group-toggle" onClick={() => tree.toggleGroup(item.id)}>
              {expanded ? "▾" : "▸"}
            </Pressable>
            <Pressable
              className={classNames("obsidian-page-button obsidian-group-title", isTagNode && "sb-tag-node", item.id === overviewSelectedNode?.id && "active")}
              onClick={() => { openNote(item.id); tree.toggleGroup(item.id); }}
              onContextMenu={(e) => { if (!tree.consumeTouchContextMenu(e)) actions.openContextMenu(e, "sidebar-node", item.id); }}
            >
              {rename.nodeId === item.id
                ? <RenameInput value={rename.draft} onChange={rename.setDraft}
                    onCommit={() => actions.renameNode(item.id, rename.draft)} onCancel={() => rename.setNodeId(null)} />
                : <NoteTitle item={item} isTagNode={isTagNode} />}
            </Pressable>
            {canDeleteRow(item) && <Pressable className="obsidian-delete-btn" onClick={() => actions.deleteNode(item.id)} aria-label={t("Delete")} title={t("Delete")}><Trash2 size={12} /></Pressable>}
          </div>
          {!flat && expanded && (children.length > 0 || pointerChildren.length > 0) && (
            <div className="sb-group-children" style={{ "--sb-guide-x": `${indentPx + 10}px` } as React.CSSProperties}>
              {children.map((child) => renderItem(child, depth + 1, nextVisited))}
              {pointerChildren.map((p) => renderPointerRow(p, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    return (
      <div
        key={item.id}
        className={classNames(
          "obsidian-page-row",
          depth > 0 && "obsidian-page-row--child",
          isDragging && "sb-dragging",
          dt?.id === item.id && dt.pos === "above" && "sb-drop-above",
          dt?.id === item.id && dt.pos === "below" && "sb-drop-below",
          dt?.id === item.id && dt.pos === "into" && "sb-drop-into",
        )}
        style={depth > 0 ? ({ "--sb-indent": `${indentPx}px` } as React.CSSProperties) : undefined}
        data-sb-id={item.id}
        title={dt?.id === item.id ? dropTitle(dt.moveTo) : undefined}
        data-sb-kind="node"
        onPointerDown={(e) => tree.onPointerDown(e, item, false, holdMenu(item.id))}
        onContextMenu={(e) => { if (!tree.consumeTouchContextMenu(e)) actions.openContextMenu(e, "sidebar-node", item.id); }}
      >
        <Pressable
          className={classNames("obsidian-page-button", isTagNode && "sb-tag-node", item.id === overviewSelectedNode?.id && "active")}
          onClick={() => openNote(item.id)}
        >
          {rename.nodeId === item.id
            ? <RenameInput value={rename.draft} onChange={rename.setDraft}
                onCommit={() => actions.renameNode(item.id, rename.draft)} onCancel={() => rename.setNodeId(null)} />
            : <NoteTitle item={item} isTagNode={isTagNode} />}
        </Pressable>
        {canDeleteRow(item) && <Pressable className="obsidian-delete-btn" onClick={() => actions.deleteNode(item.id)} aria-label={t("Delete")} title={t("Delete")}><Trash2 size={12} /></Pressable>}
      </div>
    );
  }

  // ── Three-view selection sync: scroll the active row into view ──────────
  // The "active" class is applied at multiple render sites (groups, leaves,
  // search results, tag-filtered list). A single ref-on-root + query selector
  // covers all of them without threading refs through five branches.
  const sidebarRootRef = useRef<HTMLElement | null>(null);
  // The reveal stays owed until the row is on screen: on a cold load the open note's row arrives after the selection,
  // and in windowed mode the first jump only estimates the row's place (the pitch is measured once rows exist, and
  // space headings are not one row tall), landing a few rows short with nothing to correct it. Once shown it is kept
  // in view while the list settles — space groups arrive and move rows, and what sits below the list loads later and
  // shortens it (the tag tidy bar is lazy) — until the person scrolls the list themselves. A few seconds at most, so a
  // note that is not in the list never moves the person's scrolling later.
  const reveal = useRef<{ id: string; until: number; jumpedAtPitch: number | null; shown: boolean } | null>(null);
  const REVEAL_OWED_MS = 10_000;
  useEffect(() => {
    // A phone shows the note full-screen, not beside the list: nothing to reveal.
    reveal.current = mobileLayout || !overviewSelectedNode?.id ? null : { id: overviewSelectedNode.id, until: Date.now() + REVEAL_OWED_MS, jumpedAtPitch: null, shown: false };
  }, [overviewSelectedNode?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- mobileLayout read at selection time
  // After every render (rows arriving or moving, the window moving) and whenever the list's box changes size: bring the
  // active row into the list's visible box if it is not there.
  const tryReveal = () => {
    const owed = reveal.current;
    const root = sidebarRootRef.current;
    if (!owed || !root) return;
    if (Date.now() > owed.until) { reveal.current = null; return; }
    const el = root.querySelector<HTMLElement>(".obsidian-page-button.active");
    const list = root.querySelector<HTMLElement>(".obsidian-page-list");
    if (el) {
      const box = list?.getBoundingClientRect();
      const row = el.getBoundingClientRect();
      if (box && row.top >= box.top && row.bottom <= box.bottom) { owed.shown = true; return; }
      // `nearest` keeps the scroll minimal — only scrolls when actually offscreen. inline MUST be explicit: its
      // default ("auto"→center) pans the list horizontally on expand, knocking titles out of alignment. The first reveal
      // of a plain list glides; a correction, and any windowed jump (each scroll re-renders the window and re-measures
      // the pitch, resizing the spacers under a smooth scroll's fixed target), is at once.
      el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: owed.shown || virtualized ? "auto" : "smooth" });
      return;
    }
    // Jumped already with the pitch known now: wait for the window to render (a measured pitch jumps again, closer).
    if (!virtualized || owed.jumpedAtPitch === virtRow) return;
    // Windowed mode: the active row may not EXIST in the DOM yet — jump the scroll container near its flat index so
    // the window materializes it; the render that follows (scroll handler) brings it fully into view above.
    const idx = flatRows.findIndex((r) => r.kind === "node" && r.item.id === owed.id);
    if (idx >= 0 && list) {
      owed.jumpedAtPitch = virtRow;
      list.scrollTop = Math.max(0, idx * virtRow - list.clientHeight / 2);
    }
  };
  const tryRevealRef = useRef(tryReveal);
  tryRevealRef.current = tryReveal;
  useEffect(() => { tryRevealRef.current(); });
  useEffect(() => {
    const list = pageListRef.current;
    const stopSize = observeSize(list, () => tryRevealRef.current());
    // The person scrolling the list ends the reveal (a programmatic scroll fires no wheel, touch, pointer or key).
    const personScrolls = () => { reveal.current = null; };
    const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    for (const type of events) list?.addEventListener(type, personScrolls, { passive: true });
    return () => { stopSize(); for (const type of events) list?.removeEventListener(type, personScrolls); };
  }, []);

  const showToolbar = overviewPane === "nodes" && !overviewSearch.trim();
  // The 標籤 tab's ＋ and filter, in the same row and style as the 筆記 tab's tools.
  const [tagFilterOpen, setTagFilterOpen] = useState(false);
  // 全部展開 for the tag tree: every own tag that has sub-tags (the 功能 block keeps its own folds).
  const tagParents = useMemo(() => tagParentIds(splitTagSections(tags ?? [], isImported).own), [tags, isImported]);
  const tagsAllExpanded = tagParents.length > 0 && tagParents.every((id) => tagOpen.has(id));
  const tagTools: TagTabTools = { filterOpen: tagFilterOpen, closeFilter: () => setTagFilterOpen(false), sort: tagSort, open: tagOpen, setOpen: setTagOpen };
  const tagsTab = overviewPane === "tags";
  const allExpanded = tagsTab ? tagsAllExpanded : groupIdsOfList.length > 0 && groupIdsOfList.every((id) => expandedGroups.has(id));
  const expandLabel = allExpanded ? t("Collapse all") : t("Expand all");
  const toggleExpandAll = () => {
    if (tagsTab) setTagOpen((prev) => tagsAllExpanded ? new Set([...prev].filter((id) => !tagParents.includes(id))) : new Set([...prev, ...tagParents]));
    else if (allExpanded) tree.collapseAll(); else tree.expandAll();
  };
  const TAG_SORT_LABELS: Record<string, string> = { count: t("Note count"), name: t("Name") };
  // ＋ opens the create sheet on the tab's own kind (筆記 → note, 標籤 → tag).
  // Only the owner makes tags, so the 標籤 tab has no ＋ for anyone else.
  const createButton = tagsTab && !caps.isOwner ? null : (
    <Pressable type="button" ref={createPopover.anchor as React.RefObject<HTMLButtonElement>} className="sb-bar-btn sb-bar-btn--icon"
      aria-label={t("Create")} title={t("Create")} aria-haspopup="dialog" aria-expanded={sheet !== null}
      onClick={() => setSheet(sheet ? null : { kind: tagsTab ? "tag" : "note" })}>
      <Plus size={14} aria-hidden="true" />
    </Pressable>
  );
  const sheetEl = sheet && <Suspense fallback={null}><CreateSheet create={create} request={sheet} presentation={mobileLayout ? "sheet" : "popover"} popover={createPopover} onClose={() => setSheet(null)} /></Suspense>;
  // Phone: 🔍 ＋ ⋯ on both tabs; the ⋯ menu holds the order, 全部展開 and 新筆記放在….
  const moreButton = (
    <div className="sidebar-sort-dropdown" ref={moreMenu.anchor}>
      <Pressable type="button" className="sb-bar-btn sb-bar-btn--icon" aria-label={t("More")} title={t("More")}
        aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>
        <MoreHorizontal size={14} aria-hidden="true" />
      </Pressable>
      {moreOpen && (
        <Menu popover={moreMenu} className="sidebar-sort-menu" label={t("More")}>
          <MenuLabel>{t("Sort")}</MenuLabel>
          {tagsTab
            ? TAG_SORT_KEYS.map((s) => (
              <MenuItem key={s} className="sidebar-sort-menu-item" checked={tagSort === s} onSelect={() => setTagSort(s)}>{TAG_SORT_LABELS[s]}</MenuItem>
            ))
            : SORT_KEYS.map((s) => (
              <MenuItem key={s} className="sidebar-sort-menu-item" checked={sortBy === s} onSelect={() => setSortBy(s)}>{SORT_LABELS[s]}</MenuItem>
            ))}
          <MenuSeparator />
          <MenuItem className="sidebar-sort-menu-item" onSelect={toggleExpandAll}>{expandLabel}</MenuItem>
          {!tagsTab && (
            <MenuItem className="sidebar-sort-menu-item" onSelect={() => setSheet({ kind: "note", pickPlace: true })}>{t("Where new notes go…")}</MenuItem>
          )}
        </Menu>
      )}
    </div>
  );
  // Desktop keeps its text buttons: ＋, 排序, 展開.
  const toolbar = (
    <>
      {createButton}
      <div className="sidebar-sort-dropdown" ref={sortMenu.anchor}>
        <Pressable className="sb-bar-btn" onClick={() => setSortDropOpen((o) => !o)} aria-haspopup="menu" aria-expanded={sortDropOpen}>
          {t("Sort")}
        </Pressable>
        {sortDropOpen && (
          <Menu popover={sortMenu} className="sidebar-sort-menu" label={t("Sort")}>
            {SORT_KEYS.map((s) => (
              <MenuItem
                key={s}
                className="sidebar-sort-menu-item"
                checked={sortBy === s}
                onSelect={() => setSortBy(s)}
              >
                {SORT_LABELS[s]}
              </MenuItem>
            ))}
          </Menu>
        )}
      </div>
      <Pressable className="sb-bar-btn" onClick={toggleExpandAll} title={expandLabel}>
        {allExpanded ? t("Close") : t("Open")}
      </Pressable>
    </>
  );
  // Arrow keys move between rows across the notes tree and the tag section
  // (every row button is in DOM order); Right/Left open and close a note
  // that has children (the tag rows do the same themselves).
  const rowKeys = (e: React.KeyboardEvent<HTMLElement>) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(NAV_ROWS);
    if (!row || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const rows = [...e.currentTarget.querySelectorAll<HTMLElement>(NAV_ROWS)];
      const next = rows[rows.indexOf(row) + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) { e.preventDefault(); next.focus(); }
    } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && row.classList.contains("obsidian-group-title")) {
      const group = row.closest<HTMLElement>("[data-sb-kind='group']");
      const open = group?.dataset.sbExpanded === "true";
      if (group?.dataset.sbId && open === (e.key === "ArrowLeft")) { e.preventDefault(); tree.toggleGroup(group.dataset.sbId); }
    }
  };
  return (
    <aside className="obsidian-sidebar" ref={sidebarRootRef} onKeyDown={rowKeys}>
      <PaneResizer side="sidebar" />
      <div className="obsidian-sidebar-header">
        <div className="sidebar-tabs">
          {([
            mobileLayout && { pane: "tags" as const, label: t("Tags"), mark: null },
            { pane: "nodes" as const, label: t("Notes"), mark: null },
            InboxPage && { pane: "inbox" as const, label: t("Inbox"), mark: inboxMark },
          ]).map((tab) => tab && (
            <Pressable key={tab.pane} className={classNames("sidebar-tab", overviewPane === tab.pane && "active")} onClick={() => setOverviewPane(tab.pane)}>
              {tab.label}{tab.mark && <NavMarks indicators={[tab.mark]} />}
            </Pressable>
          ))}
        </div>
        {overviewPane === "nodes" && (
          <Pressable type="button" ref={searchToggleRef} className="sidebar-search-toggle"
            aria-label={t("Search notes")} title={searchKeys ? t("Search notes ({keys})", { keys: searchKeys }) : t("Search notes")}
            aria-expanded={searchOpen} aria-controls={searchId}
            onClick={() => searchOpen ? closeSearch() : openOverviewSearch()}>
            <Search size={15} aria-hidden="true" />
          </Pressable>
        )}
        {overviewPane === "tags" && (
          <>
            <Pressable type="button" className="sidebar-search-toggle" aria-label={t("Search tags…")} title={t("Search tags…")}
              aria-expanded={tagFilterOpen} onClick={() => setTagFilterOpen((o) => !o)}>
              <Search size={15} aria-hidden="true" />
            </Pressable>
          </>
        )}
        {/* A phone has one header row: tabs left, the tools right. */}
        {mobileLayout && (showToolbar || tagsTab) && <>{createButton}{moreButton}</>}
      </div>
      {sheetEl}
      {searchOpen && overviewPane === "nodes" && (
        <SearchField
          ref={searchInputRef} id={searchId}
          label={t("Search notes…")} shortcut="focus-search"
          value={overviewSearch}
          onValueChange={(v) => { setOverviewSearch(v); setSearchIdx(0); }}
          nav={{ count: overviewSearchResults.length, active: searchIdx, onActive: setSearchIdx, onPick: (i) => { const r = overviewSearchResults[i]; if (r) openNote(r.id); } }}
          onEscape={closeSearch}
        />
      )}
      {showToolbar && !mobileLayout && <div className="sidebar-sort-bar">{toolbar}</div>}
      <div
        ref={pageListEl}
        className="obsidian-page-list"
        onScroll={virtualized && !mobileLayout ? (e) => {
          const el = e.currentTarget;
          measureRowPitch(el);
          setVirtScroll({ top: el.scrollTop, viewport: el.clientHeight });
        } : undefined}
      >
        {overviewPane === "inbox" && InboxPage ? (
          <Suspense fallback={null}>
            <InboxPage online={online} target={null} onOpenNode={openNote} onRefresh={noop} onImmersiveChange={noop} inTab />
          </Suspense>
        ) : overviewPane === "tags" ? (
          <SidebarTagTree nav={nav} rename={rename} onCreateTag={onCreateTag} onCreateInside={(tagId) => setSheet({ kind: "tag", tagParentId: tagId })} dropTagId={tree.tagDropId} tools={tagTools} />
        ) : overviewSearch.trim() ? (
          <>
            <p className="obsidian-search-count">
              {tn("1 result", "{count} results", overviewSearchResults.length)}
            </p>
            <SearchOfflineNotice outcome={overviewSearchOutcome} />
            {overviewSearchFailed && <p className="obsidian-search-count" role="alert">{t("Search is unavailable. Your query is still here.")}</p>}
            {overviewSearchResults.length === 0 && !overviewSearchFailed && overviewSearchOutcome && (
              <EmptyState
                variant="noResults"
                title={t("No results")}
                description={t("Nothing matched “{query}”.", { query: overviewSearch })}
              />
            )}
            {overviewSearchResults.map(({ id, node, node_type, title, snippet, path, titleIndices }, idx) => (
              <div className="obsidian-page-row obsidian-search-row" key={id}>
                <Pressable
                  className={classNames("obsidian-page-button", node_type === TAG_NODE_TYPE && "sb-tag-node", (id === overviewSelectedNode?.id || idx === searchIdx) && "active")}
                  onClick={() => openNote(id)}
                >
                  {path.length > 0 && (
                    <span className="search-result-path">{path.join(" › ")}</span>
                  )}
                  <span className="sb-item-title">{node_type === TAG_NODE_TYPE && <span className="sb-tag-hash" aria-hidden>#</span>}<SnippetText snippet={{ text: title, ranges: titleIndices }} markClassName="search-hl" /></span>
                  {snippet && <span className="obsidian-search-snippet"><SnippetText snippet={snippet} /></span>}
                </Pressable>
                {node && canDeleteRow(node) && <Pressable className="obsidian-delete-btn" onClick={() => actions.deleteNode(id)} aria-label={t("Delete")} title={t("Delete")}><Trash2 size={12} /></Pressable>}
              </div>
            ))}
          </>
        ) : (
          virtualized ? (() => {
            const { start, end } = sidebarWindow(flatRows.length, virtScroll.top, virtScroll.viewport, virtRow, VIRT_OVERSCAN);
            return (
              <>
                <div className="sb-virt-spacer" style={{ "--sb-spacer-h": `${start * virtRow}px` } as React.CSSProperties} />
                {flatRows.slice(start, end).map((row: FlatRow) =>
                  row.kind === "space"
                    ? row.label ? <SpaceHeading key={`space-${row.spaceId}`} spaceId={row.spaceId} label={row.label} shared={sharedSpaceIds.has(row.spaceId)} dropping={tree.dropSpaceId === row.spaceId} /> : null
                    : row.kind === "spaceEmpty"
                    ? <SpaceEmptyRow key={`empty-${row.spaceId}`} spaceId={row.spaceId} label={spaceLabels.get(row.spaceId) ?? ""} noNotes={!spacesWithNotes.has(row.spaceId)} dropping={tree.dropSpaceId === row.spaceId} onCreate={createInSpace} />
                    : row.kind === "pointer"
                    ? renderPointerRow(row.pointer, row.depth)
                    : renderItem(row.item, row.depth, new Set(), true))}
                <div className="sb-virt-spacer" style={{ "--sb-spacer-h": `${Math.max(0, (flatRows.length - end)) * virtRow}px` } as React.CSSProperties} />
              </>
            );
          })() : (() => {
            const roots = rootNodes;
            if (roots.length === 0 && !spaceGroups) {
              return (
                <EmptyState
                  variant="empty"
                  title={t("No notes yet")}
                  description={t("This space is yours — create your first note.")}
                  ctaLabel={t("New note")}
                  onCta={() => void create("note")}
                  ctaDisabled={!online}
                />
              );
            }
            if (spaceGroups) {
              return <>{spaceGroups.map((g) => (
                <div key={`space-${g.spaceId}`} className="sb-space-group">
                  {g.label && <SpaceHeading spaceId={g.spaceId} label={g.label} shared={sharedSpaceIds.has(g.spaceId)} dropping={tree.dropSpaceId === g.spaceId} />}
                  {g.roots.length === 0 && <SpaceEmptyRow spaceId={g.spaceId} label={g.label} noNotes={!spacesWithNotes.has(g.spaceId)} dropping={tree.dropSpaceId === g.spaceId} onCreate={createInSpace} />}
                  {g.roots.map((item) => renderItem(item, 0, new Set()))}
                </div>
              ))}</>;
            }
            return <>{roots.map((item) => renderItem(item, 0, new Set()))}</>;
          })()
        )}
      </div>

      {overviewPane === "nodes" && !mobileLayout && (
        <SidebarTagTree placement="section" nav={nav} rename={rename} onCreateTag={onCreateTag} onCreateInside={(tagId) => setSheet({ kind: "tag", tagParentId: tagId })} dropTagId={tree.tagDropId} springHint={tree.springHint} springOpen={tree.springOpened} springKept={tree.springKept} />
      )}
      {tree.dragOverlay && (
        <div
          className={classNames(layerClass.fixed, "sb-pointer-overlay", tree.dragOverlay.isGroup && "sb-pointer-overlay--group")}
          style={{
            "--sb-overlay-x": `${tree.dragOverlay.x}px`,
            "--sb-overlay-y": `${tree.dragOverlay.y}px`,
            "--sb-overlay-w": `${tree.dragOverlay.width}px`,
            "--sb-overlay-h": `${tree.dragOverlay.height}px`,
          } as React.CSSProperties}
        >
          <span className="sb-item-dot" />
          <span className="sb-item-title">{tree.dragOverlay.title}</span>
          {tree.dragOverlay.moveTo && <span className="sb-overlay-move">{dropTitle(tree.dragOverlay.moveTo)}</span>}
        </div>
      )}
    </aside>
  );
}

// H4 re-render hygiene: with store data self-sourced and BuilderApp's
// callbacks identity-stable, the sidebar skips renders for unrelated
// BuilderApp state (palette typing, dialogs, context menus).
export default memo(OverviewSidebar);

const noop = () => {};

/** A tree row's title: the note's colour dot, its title, a pin when pinned. */
function NoteTitle({ item, isTagNode }: { item: ContentNode; isTagNode: boolean }) {
  const t = useT();
  const color = noteColor(item);
  const label = noteLabel(item);
  return (
    <span className="sb-item-title">
      {color && <span className="sb-note-color" style={{ "--note-color": color } as React.CSSProperties} aria-hidden />}
      {isTagNode && <span className="sb-tag-hash" aria-hidden>#</span>}
      {label === untitledTitle() ? <span className="sb-untitled">{label}</span> : label}
      {isPinned(item) && <Pin size={11} className="sb-note-pin" aria-label={t("Pinned")} />}
    </span>
  );
}
