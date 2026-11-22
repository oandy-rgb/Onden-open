import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch, type SetStateAction, type DragEvent, type KeyboardEvent } from "react";
import { ChevronRight, Eye, EyeOff, Pin, PinOff, Plus, Pencil, Trash2 } from "lucide-react";
import { useAppSelector, consumeSidebarTagsFocus, useSelectedId, useAllNodes } from "../lib/appStore";
import { t, tn } from "../lib/i18n";
import { classNames } from "../lib/utils";
import { PREFS, usePersistedFlag } from "../lib/prefs";
import { directTagUsage } from "../lib/nodeTags";
import {
  canMoveTagUnder, filterTagTree, pinnedThenName, pinnedThenUsed, splitTagSections, tagTreeRows, withDescendants, type TagSort, type TagTreeRow,
} from "../lib/tagTree";
import type { Tag } from "../lib/api";
import { backgroundWrite, nodeActions, tagWriter } from "../lib/data";
import { useIsOwner } from "../lib/capabilities";
import { useSidebarTagPrefs } from "../hooks/useSidebarTagPrefs";
import { Menu, MenuItem, MenuSeparator, Pressable, SearchField, usePopover } from "./ui";
import { useLongPress } from "../hooks/useLongPress";
import { holdSurface, beginTouchHold, type TouchHoldHandlers, createEdgeAutoScroll, createTouchPressGuard } from "../lib/touchHold";
import { NewTagField, useNewTag } from "./NewTagField";
import RenameInput from "./RenameInput";
import { lazyWithReload } from "../lib/lazyWithReload";
import { loadTagDeleteConfirm, loadTagMoveConfirm, loadTagTidy } from "./lateShell";
import ShellDialog from "./ShellDialog";
import type { SidebarNav, SidebarRename } from "./sidebarGroups";
import { isImeComposing } from "../lib/keys";
import { TAG_NAME_MAX } from "@onden/markdown";
import { elementAtPoint } from "../lib/documentAccess";

const TagDeleteConfirm = lazyWithReload(loadTagDeleteConfirm);
const TagMoveConfirm = lazyWithReload(loadTagMoveConfirm);
const TagTidy = lazyWithReload(loadTagTidy);

// The tag tree of the sidebar — ONE component on both layouts (tags and notes
// are both nodes: one entry, two sides):
//   • "tab": the phone Notes home's 標籤 tab. Its ＋ and filter sit in the
//     tabs' row like the 筆記 tab's tools (`tools`, the sidebar's), so the
//     list starts with the first tag;
//   • "section": the desktop's 「標籤」 section under the notes tree, folded by
//     its header (open or closed is remembered on this device).
// The tag hierarchy as folders: ▸ opens CHILD tags (never member notes); the
// name opens the tag's page, where its notes and views are — it does not
// filter the notes tree. Each row: colour dot, #name, direct note count
// (directTagUsage). Order at every level: pinned tags first (in pin order),
// then by note count, ties by name (lib/tagTree pinnedThenUsed).
// A right click or long press on a row opens 釘選 / 從側欄隱藏 / 重新命名 /
// 刪除. Pins and hidden tags are the account's (hooks/useSidebarTagPrefs), the
// same on every device. "Hidden" only leaves a tag (and its sub-tags) out of
// this list; the quiet last line 「還有 N 個隱藏的標籤」 shows them again, and
// the tags the owner hid workspace-wide (D104) are in that line too.
// Dragging: a note from the notes tree dropped on a row applies the tag (the
// drop is useSidebarDrag's; `dropTagId` is its highlight); a tag dragged onto
// another tag moves under it after a confirm. Arrow keys: Up/Down move
// between rows (the sidebar handles that across both sections), Right/Left
// open and close the sub-tags. Only the person's own tags are
// listed: a function is no part of the tag tree and never a #tag here (it has
// its own entries in 更多 and the nav; docs/architecture/module-library.md). In the desktop section the filter box shows
// only past FILTER_THRESHOLD tags; in the tab it opens from the row's 🔍.

const EMPTY_TAGS: Tag[] = [];

/** The filter box appears past this many of the person's own tags. */
export const TAG_FILTER_THRESHOLD = 12;

/** The rows to show: a row is hidden while any ancestor is folded. */
function visibleRows(rows: ReadonlyArray<TagTreeRow>, open: ReadonlySet<string>): Array<TagTreeRow> {
  const out: Array<TagTreeRow> = [];
  let foldedAt: number | null = null;
  for (const row of rows) {
    if (foldedAt !== null) {
      if (row.depth > foldedAt) continue;
      foldedAt = null;
    }
    out.push(row);
    if (row.childCount > 0 && !open.has(row.tag.id)) foldedAt = row.depth;
  }
  return out;
}

/** The 標籤 tab's tools, drawn by the sidebar in the tabs' row. The sidebar's
 *  ⋯ menu owns the order and the open folders (全部展開 / 全部收合). */
export type TagTabTools = {
  filterOpen: boolean; closeFilter: () => void;
  sort: TagSort;
  open: ReadonlySet<string>; setOpen: Dispatch<SetStateAction<ReadonlySet<string>>>;
};

export default function SidebarTagTree({ nav, rename, onCreateTag, onCreateInside, placement = "tab", dropTagId = null, springHint = null, springOpen, springKept, tools }: {
  nav: Pick<SidebarNav, "openTag">;
  /** The sidebar's rename-in-place state (a tag is a node). */
  rename: SidebarRename;
  /** Create a tag by name and go to it (the caller's). */
  onCreateTag?: (name: string) => Promise<void> | void;
  /** Open the create sheet for a tag under `tagId` (the owner's 「在裡面新增」). */
  onCreateInside?: (tagId: string) => void;
  placement?: "tab" | "section";
  /** The row a held note would tag (the notes tree's drag, tree.tagDropId). */
  dropTagId?: string | null;
  /** A folded tag a held note is waiting over (it opens after `ms`), and the tags that wait already opened
   *  (shown open for this drag only; the notes tree's drag owns both). */
  springHint?: { id: string; ms: number } | null;
  springOpen?: ReadonlySet<string>;
  /** Tags a drop kept open: taken into the open set (the drag's openings otherwise fold back). */
  springKept?: ReadonlySet<string>;
  /** Given: the ＋ and filter are in the sidebar's tabs' row, not above the list. */
  tools?: TagTabTools;
}) {
  const tags = useAppSelector((s) => s.data.tags ?? EMPTY_TAGS);
  const nodes = useAllNodes();
  const openTagId = useSelectedId();
  // Tag definitions (rename, delete, moving under another tag) are the workspace owner's.
  const canManage = useIsOwner();
  const section = placement === "section";
  const [sectionOpen, setSectionOpen] = usePersistedFlag(PREFS.sidebarTagsOpen, true);
  const [ownOpen, setOwnOpen] = useState<ReadonlySet<string>>(new Set());
  const savedOpen = tools?.open ?? ownOpen;
  const open = useMemo(
    () => (springOpen && springOpen.size > 0 ? new Set([...savedOpen, ...springOpen]) : savedOpen),
    [savedOpen, springOpen],
  );
  const setOpen = tools?.setOpen ?? setOwnOpen;
  useEffect(() => {
    if (springKept && springKept.size > 0) setOpen((prev) => new Set([...prev, ...springKept]));
  }, [springKept]); // eslint-disable-line react-hooks/exhaustive-deps -- setOpen is a state setter
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<Tag | null>(null);
  const [moving, setMoving] = useState<{ tag: Tag; parent: Tag } | null>(null);
  const [draggedTagId, setDraggedTagId] = useState<string | null>(null);
  const [overTagId, setOverTagId] = useState<string | null>(null);
  // A tag row held by a finger (lifted); the mouse drag uses draggedTagId alone.
  const [liftedTagId, setLiftedTagId] = useState<string | null>(null);
  const liftedRef = useRef<string | null>(null);
  const touchGuard = useRef(createTouchPressGuard()).current;
  const [revealHidden, setRevealHidden] = useState(false);
  const { pinned: pinnedIds, hidden: hiddenIds, isPinned, isHidden, togglePin, toggleHidden } = useSidebarTagPrefs();
  const ownNewTag = useNewTag(onCreateTag);
  const newTag = ownNewTag;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rootEl = useCallback((el: HTMLDivElement | null) => { rootRef.current = el; holdSurface(el); }, []);

  const usage = useMemo(() => directTagUsage(nodes, tags), [nodes, tags]);
  const { own, hidden: hiddenTags } = useMemo(() => splitTagSections(tags), [tags]);
  // A function is not a tag: a hidden one is Settings › 功能's, never listed here.
  const workspaceHidden = useMemo(() => hiddenTags.filter((tag) => !tag.schema_module), [hiddenTags]);
  // Tags the account left out of the list, with their sub-tags.
  const outOfList = useMemo(() => withDescendants(own, hiddenIds), [own, hiddenIds]);
  const shown = useMemo(() => revealHidden ? own : own.filter((tag) => !outOfList.has(tag.id)), [revealHidden, own, outOfList]);
  const sortByName = tools?.sort === "name";
  const allRows = useMemo(
    () => tagTreeRows(shown, sortByName ? pinnedThenName(pinnedIds) : pinnedThenUsed(pinnedIds, usage)),
    [shown, pinnedIds, usage, sortByName],
  );
  const searching = query.trim() !== "";
  const showFilter = tools ? tools.filterOpen : own.length > TAG_FILTER_THRESHOLD;
  // Closing the tab's filter clears it, like the notes search.
  useEffect(() => { if (tools && !tools.filterOpen) setQuery(""); }, [tools?.filterOpen]); // eslint-disable-line react-hooks/exhaustive-deps -- only the open flag matters
  const rows = useMemo(
    () => showFilter && searching ? filterTagTree(allRows, query) : visibleRows(allRows, open),
    [allRows, open, query, showFilter, searching],
  );
  const hiddenCount = outOfList.size + workspaceHidden.length;

  // 「前往標籤」: open the section and, once it is drawn, put focus on its first row.
  const focusRequested = useAppSelector((s) => s.sidebarTagsFocusPending);
  const [focusNext, setFocusNext] = useState(false);
  useEffect(() => {
    if (!focusRequested || !consumeSidebarTagsFocus()) return;
    if (section) setSectionOpen(true);
    setFocusNext(true);
  }, [focusRequested, section, setSectionOpen]);
  useEffect(() => {
    if (!focusNext || (section && !sectionOpen)) return;
    setFocusNext(false);
    const root = rootRef.current;
    (root?.querySelector<HTMLElement>(".sb-tagtree-name") ?? root?.querySelector<HTMLElement>(".sb-tagtree-section-toggle"))?.focus();
  }, [focusNext, section, sectionOpen]);

  const toggle = (id: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const countOf = (id: string) => usage.get(id) ?? 0;
  const startRename = (tag: Tag) => { rename.setDraft(tag.name); rename.setNodeId(tag.id); };
  const commitRename = (tag: Tag) => {
    const name = rename.draft.trim();
    rename.setNodeId(null);
    if (name && name !== tag.name) void nodeActions.rename(tag.id, name);
  };
  const dropOnTag = (target: Tag) => {
    const dragged = tags.find((tag) => tag.id === draggedTagId);
    setDraggedTagId(null);
    setOverTagId(null);
    if (dragged && canMoveTagUnder(tags, dragged.id, target.id)) setMoving({ tag: dragged, parent: target });
  };

  const tagUnderFinger = (x: number, y: number): string | null =>
    elementAtPoint(x, y)?.closest<HTMLElement>("[data-sb-tag-id]")?.dataset.sbTagId ?? null;
  const overTagAt = (dragId: string, x: number, y: number) => {
    const id = tagUnderFinger(x, y);
    setOverTagId(id && canMoveTagUnder(tags, dragId, id) ? id : null);
  };
  const autoScroll = useRef(createEdgeAutoScroll(() => liftedRef.current !== null, (x, y) => {
    if (liftedRef.current) overTagAt(liftedRef.current, x, y);
  }));
  const endTouchDrag = () => {
    autoScroll.current.stop();
    liftedRef.current = null;
    setLiftedTagId(null);
    setOverTagId(null);
  };

  const row = (tag: Tag, extra?: { depth?: number; childCount?: number; count?: number; workspaceHidden?: boolean }) => {
    const depth = extra?.depth ?? 0;
    const childCount = extra?.childCount ?? 0;
    const expanded = open.has(tag.id);
    const heldTagId = draggedTagId ?? liftedTagId;
    const droppable = !!heldTagId && canMoveTagUnder(tags, heldTagId, tag.id) && !extra?.workspaceHidden;
    const canDrag = canManage && !extra?.workspaceHidden && !tag.reserved_key && rename.nodeId !== tag.id;
    // Held with a finger: lifts, moves → drags onto another tag (the move confirm), in place → the menu.
    const touchDrag: TouchTagDrag | undefined = canDrag ? {
      guard: touchGuard,
      onLift: () => { liftedRef.current = tag.id; setLiftedTagId(tag.id); },
      onDrag: (x, y) => { overTagAt(tag.id, x, y); autoScroll.current.start(x, y); },
      onRelease: (x, y, moved) => {
        const targetId = moved ? tagUnderFinger(x, y) : null;
        const target = targetId ? tags.find((candidate) => candidate.id === targetId) : undefined;
        endTouchDrag();
        if (target && canMoveTagUnder(tags, tag.id, target.id)) setMoving({ tag, parent: target });
      },
      onAbort: endTouchDrag,
    } : undefined;
    return (
      <TagRow key={tag.id} tag={tag} depth={depth} count={extra?.count ?? countOf(tag.id)}
        current={openTagId === tag.id} pinned={isPinned(tag.id)}
        childCount={childCount} expanded={expanded}
        renaming={rename.nodeId === tag.id}
        // 取消隱藏 for the workspace-hidden ones; the rest is the account's own choice.
        workspaceHidden={extra?.workspaceHidden === true}
        sidebarHidden={outOfList.has(tag.id)} hiddenByChoice={isHidden(tag.id)}
        canPin={!extra?.workspaceHidden} canHide={!extra?.workspaceHidden}
        canRename={canManage} canDelete={canManage && !tag.reserved_key}
        canUnhideForAll={canManage}
        onCreateInside={canManage && onCreateInside && !extra?.workspaceHidden ? () => onCreateInside(tag.id) : undefined}
        draggable={canDrag} touchDrag={touchDrag} lifted={liftedTagId === tag.id}
        noteDropActive={dropTagId === tag.id} springMs={springHint?.id === tag.id ? springHint.ms : undefined} tagDropActive={overTagId === tag.id && droppable}
        onOpen={() => nav.openTag(tag.id)} onToggle={() => toggle(tag.id)}
        onPin={() => togglePin(tag.id)} onToggleHidden={() => toggleHidden(tag.id)}
        onUnhideForAll={backgroundWrite(() => tagWriter.setHidden(tag.id, false))}
        onRename={() => startRename(tag)} onDelete={() => setDeleting(tag)}
        onTagDragStart={() => setDraggedTagId(tag.id)}
        onTagDragEnd={() => { setDraggedTagId(null); setOverTagId(null); }}
        onTagDragOver={() => { if (droppable) { setOverTagId(tag.id); return true; } return false; }}
        onTagDrop={() => { if (droppable) dropOnTag(tag); }}
        renameInput={<RenameInput value={rename.draft} onChange={rename.setDraft} maxLength={TAG_NAME_MAX}
          onCommit={() => commitRename(tag)} onCancel={() => rename.setNodeId(null)} />} />
    );
  };

  const newTagButton = onCreateTag && (
    <Pressable type="button" className="sidebar-tag-new" onClick={() => { if (section) setSectionOpen(true); newTag.toggle(); }}
      title={t("New tag — name it, then shape it on its own page")} aria-label={t("New tag")}>
      <Plus size={14} />
    </Pressable>
  );
  const body = (
    <>
      <NewTagField newTag={newTag} />
      {showFilter && (
        <SearchField label={t("Search tags…")} value={query} onValueChange={setQuery} autoFocus={!!tools}
          onEscape={tools ? tools.closeFilter : undefined} />
      )}
      {own.length === 0 && workspaceHidden.length === 0 ? (
        <p className="sb-tagtree-empty">{t("No tags yet. Add one to a note with “+ Tag” under its title; to tag just one paragraph, type {example} at the end of it.", { example: `{${t("tag name")}}` })}</p>
      ) : (
        <ul className="sb-tagtree-list" aria-label={t("Your tags")}>
          {rows.map(({ tag, depth, childCount }) => row(tag, { depth, childCount: searching ? 0 : childCount }))}
          {revealHidden && !searching && workspaceHidden.map((tag) => row(tag, { workspaceHidden: true }))}
        </ul>
      )}
      {searching && showFilter && rows.length === 0 && (
        <p className="sb-tagtree-empty">{t("No tag matches “{query}”.", { query: query.trim() })}</p>
      )}
      {hiddenCount > 0 && !searching && (
        <Pressable type="button" className="sb-tagtree-hidden-line" aria-expanded={revealHidden} onClick={() => setRevealHidden((v) => !v)}>
          {revealHidden ? t("Hide the hidden tags again") : t(hiddenCount === 1 ? "1 more hidden tag" : "{n} more hidden tags", { n: hiddenCount })}
        </Pressable>
      )}
    </>
  );
  // The owner's quiet 整理 line: unused tags and similar names; collapsed. In the
  // desktop section it sits below the scrolling tag list, not inside it: opening
  // it used to push the used tags out of the section's small scroll box.
  const tidy = !searching && <Suspense fallback={null}><TagTidy openTag={nav.openTag} /></Suspense>;

  return (
    <div className={classNames("sb-tagtree", section && "sb-tagtree--section")} ref={rootEl} data-placement={placement}>
      {section ? (
        <div className="sb-tagtree-heading sb-tagtree-heading--section">
          <Pressable type="button" className="sb-tagtree-section-toggle" aria-expanded={sectionOpen}
            onClick={() => setSectionOpen(!sectionOpen)}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return;
              if (e.key === "ArrowRight" && !sectionOpen) { e.preventDefault(); setSectionOpen(true); }
              if (e.key === "ArrowLeft" && sectionOpen) { e.preventDefault(); setSectionOpen(false); }
            }}>
            <ChevronRight size={14} className="sb-tagtree-chevron" aria-hidden="true" />
            {t("Tags")}
          </Pressable>
          {newTagButton}
        </div>
      ) : !tools && (
        <div className="sb-tagtree-heading">
          <span className="sb-space-heading">{t("Your tags")}</span>
          {newTagButton}
        </div>
      )}
      {(!section || sectionOpen) && (section
        ? <><div className="sb-tagtree-scroll">{body}</div>{tidy}</>
        : <>{body}{tidy}</>)}
      {deleting && (
        <ShellDialog label={t("Delete #{name}", { name: deleting.name })} className="sb-tagtree-delete" onClose={() => setDeleting(null)}>
          <Suspense fallback={null}>
            <TagDeleteConfirm tag={deleting} onDeleteNode={nodeActions.delete}
              onDone={() => setDeleting(null)} onCancel={() => setDeleting(null)} />
          </Suspense>
        </ShellDialog>
      )}
      {moving && (
        <ShellDialog label={t("Move #{name}", { name: moving.tag.name })} className="sb-tagtree-delete" onClose={() => setMoving(null)}>
          <Suspense fallback={null}>
            <TagMoveConfirm tag={moving.tag} parent={moving.parent}
              onDone={() => { setOpen((prev) => new Set(prev).add(moving.parent.id)); setMoving(null); }} onCancel={() => setMoving(null)} />
          </Suspense>
        </ShellDialog>
      )}
    </div>
  );
}

interface TouchTagDrag extends Omit<TouchHoldHandlers, never> {
  guard: ReturnType<typeof createTouchPressGuard>;
}

function TagRow({
  tag, depth, count, current, pinned, childCount, expanded, springMs, renaming, workspaceHidden, sidebarHidden, hiddenByChoice,
  canPin, canHide, canRename, canDelete, canUnhideForAll, draggable, touchDrag, lifted, noteDropActive, tagDropActive,
  onOpen, onToggle, onPin, onToggleHidden, onUnhideForAll, onRename, onDelete, onCreateInside,
  onTagDragStart, onTagDragEnd, onTagDragOver, onTagDrop, renameInput,
}: {
  tag: Tag; depth: number; count: number; current: boolean; pinned: boolean;
  childCount: number; expanded: boolean; springMs?: number; renaming: boolean;
  /** Hidden for everyone by the owner (D104), listed only while the hidden are shown. */
  workspaceHidden: boolean;
  /** Out of the list by the account's choice (itself or a parent), shown dimmed while revealed. */
  sidebarHidden: boolean;
  /** This very tag is hidden by the account's choice (the menu offers to show it). */
  hiddenByChoice: boolean;
  canPin: boolean; canHide: boolean; canRename: boolean; canDelete: boolean; canUnhideForAll: boolean;
  draggable: boolean;
  /** Touch hold-to-drag; absent for rows that cannot be moved (long press = menu). */
  touchDrag?: TouchTagDrag;
  /** The row is lifted by a finger. */
  lifted: boolean;
  /** A held note would tag this row / a held tag would move under it. */
  noteDropActive: boolean; tagDropActive: boolean;
  onOpen: () => void; onToggle: () => void; onPin: () => void; onToggleHidden: () => void; onUnhideForAll: () => void;
  onRename: () => void; onDelete: () => void;
  /** Owner's 「在裡面新增」: absent on a function and for a non-owner. */
  onCreateInside?: () => void;
  onTagDragStart: () => void; onTagDragEnd: () => void;
  /** Whether a held tag may drop here (shows the highlight). */
  onTagDragOver: () => boolean; onTagDrop: () => void;
  renameInput: React.ReactNode;
}) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const menu = usePopover<HTMLLIElement>({ open: !!menuAt, onClose: () => setMenuAt(null), placement: "bottom-start", at: menuAt ?? undefined });
  // The press position is not known to useLongPress's callback; open the menu under the row.
  const openMenu = () => {
    const box = menu.anchor.current?.getBoundingClientRect();
    setMenuAt({ x: box ? box.left + 24 : 24, y: box ? box.bottom - 8 : 24 });
  };
  const press = useLongPress(openMenu);
  // The click that follows a lifted touch press is not a tap on the row.
  const heldTouch = useRef(false);
  const pressHandlers = {
    ...press,
    onPointerDown: (e: React.PointerEvent) => {
      heldTouch.current = false;
      if (touchDrag && beginTouchHold(e, touchDrag.guard, {
        onLift: () => { heldTouch.current = true; touchDrag.onLift(); },
        onDrag: touchDrag.onDrag,
        onRelease: (x, y, moved) => { touchDrag.onRelease(x, y, moved); if (!moved) openMenu(); },
        onAbort: touchDrag.onAbort,
      })) return;
      press.onPointerDown(e);
    },
    onContextMenu: (e: React.MouseEvent) => { if (!touchDrag?.guard.swallow(e)) press.onContextMenu(e); },
    onClickCapture: (e: React.MouseEvent) => {
      if (heldTouch.current) { e.preventDefault(); e.stopPropagation(); heldTouch.current = false; }
      else press.onClickCapture(e);
    },
  };
  const name = tag.name;
  const leaf = childCount === 0;
  const keys = (e: KeyboardEvent) => {
    if (isImeComposing(e)) return;
    if (e.key === "ArrowRight" && !leaf && !expanded) { e.preventDefault(); onToggle(); }
    else if (e.key === "ArrowLeft" && !leaf && expanded) { e.preventDefault(); onToggle(); }
  };
  const dragOver = (e: DragEvent) => { if (onTagDragOver()) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } };
  return (
    <li ref={menu.anchor} className={classNames("obsidian-page-row sb-tagtree-item", lifted && "sb-dragging", depth > 0 && "obsidian-page-row--child", leaf && "sb-tagtree-item-leaf")}
      data-pinned={pinned || undefined}
      data-sb-tag-id={workspaceHidden ? undefined : tag.id}
      data-sidebar-hidden={sidebarHidden || workspaceHidden || undefined}
      data-sb-expanded={leaf ? undefined : String(expanded)}
      data-spring={springMs !== undefined || undefined}
      style={{ "--depth": depth, "--sb-spring-ms": springMs === undefined ? undefined : `${springMs}ms` } as CSSProperties}
      data-note-drop={noteDropActive || undefined} data-tag-drop={tagDropActive || undefined}
      draggable={draggable || undefined}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", `#${tag.name}`); onTagDragStart(); }}
      onDragEnd={onTagDragEnd}
      onDragOver={dragOver}
      onDrop={(e) => { e.preventDefault(); onTagDrop(); }}
      onKeyDown={keys}>
      {!leaf ? (
        <Pressable type="button" className="obsidian-group-toggle sb-tagtree-toggle" aria-expanded={expanded}
          aria-label={t(expanded ? "Hide sub-tags of #{name}" : "Show sub-tags of #{name}", { name })}
          onClick={onToggle}>
          {expanded ? "▾" : "▸"}
        </Pressable>
      ) : (
        // A leaf's colour sits where a parent's ▸ is, so names line up with note titles.
        <span className="obsidian-group-toggle sb-tagtree-toggle" aria-hidden="true">
          <span className="sb-tagtree-dot" style={{ "--tag-color": tag.color || undefined } as CSSProperties} />
        </span>
      )}
      {renaming ? renameInput : (
        <Pressable type="button" className={classNames("obsidian-page-button sb-tag-node sb-tagtree-name", current && "active")} aria-label={t("Open #{name}", { name })}
          aria-current={current ? "page" : undefined} aria-haspopup="menu" onClick={onOpen} {...pressHandlers}>
          <span className="sb-tag-hash" aria-hidden="true">#</span>
          <span className="sb-tagtree-label">{name}</span>
          {pinned && <Pin size={11} className="sb-tagtree-pin" aria-label={t("Pinned")} />}
          <span className="sb-tagtree-count" title={tn("1 directly tagged note", "{n} directly tagged notes", count)}>{count}</span>
        </Pressable>
      )}
      {menuAt && (
        <Menu popover={menu} label={t("Tag actions")}>
          {onCreateInside && <MenuItem onSelect={onCreateInside}><Plus size={14} aria-hidden="true" />{t("New inside")} ▸</MenuItem>}
          {canPin && (
            <MenuItem onSelect={onPin}>
              {pinned ? <PinOff size={14} aria-hidden="true" /> : <Pin size={14} aria-hidden="true" />}
              {t(pinned ? "Unpin from top" : "Pin to top")}
            </MenuItem>
          )}
          {canHide && (
            <MenuItem onSelect={onToggleHidden}>
              {hiddenByChoice ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}
              {t(hiddenByChoice ? "Show in sidebar" : "Hide from sidebar")}
            </MenuItem>
          )}
          {workspaceHidden && canUnhideForAll && (
            <MenuItem onSelect={onUnhideForAll}><Eye size={14} aria-hidden="true" />{t("Unhide tag")}</MenuItem>
          )}
          {canRename && <MenuItem onSelect={onRename}><Pencil size={14} aria-hidden="true" />{t("Rename")}</MenuItem>}
          {canDelete && (<>
            <MenuSeparator />
            <MenuItem danger onSelect={onDelete}><Trash2 size={14} aria-hidden="true" />{t("Delete tag")}</MenuItem>
          </>)}
        </Menu>
      )}
    </li>
  );
}
