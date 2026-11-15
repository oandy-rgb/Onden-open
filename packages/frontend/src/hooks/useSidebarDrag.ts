import { useEffect, useMemo, useRef, useState } from "react";
import { canPlaceUnder, noteStructure, runBackgroundWrite, tagWriter } from "../lib/data";
import { addToast, getAppState, getNode } from "../lib/appStore";
import { t } from "../lib/i18n";
import type { ContentNode } from "../lib/api";
import { useCapabilities } from "../lib/capabilities";
import { spaceLabel, useSpaces, type Space } from "../lib/spaces";
import { groupNodes } from "../lib/utils";
import { PREFS, getPrefJson, setPrefJson } from "../lib/prefs";
import { beginTouchHold, createEdgeAutoScroll, createTouchPressGuard, isHoldPointer } from "../lib/touchHold";
import { SPRING_OPEN_MS, SPRING_OPEN_TOUCH_MS, createSpringOpen, type SpringOpen } from "../lib/springOpen";
import { ancestorsOf, indexById } from "../lib/treeWalk";
import { displayTitle } from "../lib/noteLabel";
import { nodeHasTag } from "../lib/nodeTags";
import { DRAG_SLOP_PX } from "../lib/pointerDrag";
import { useEscapeCancel } from "./useEscapeKey";
import { onPageHide } from "../lib/pageHide";
import { splitDrag } from "../lib/splitViewStore";
import { CONTENT_TAB } from "../lib/viewTabs";
import { isTag } from "@onden/markdown/contract";

interface UseSidebarDragOptions {
  nodes: ContentNode[];
  online: boolean;
  selectedNodeId: string | null | undefined;
  selectedNodeParentId: string | null | undefined;
}

/** A note dropped on another space, waiting for the person to confirm the move
 *  (components/MoveToSpaceConfirm). `parentId` is the note it will sit under there, null: the top level. */
export type SidebarSpaceMove = { node: ContentNode; to: Space; parentId: string | null };

type DropPos = "above" | "below" | "into";

export function useSidebarDrag({ nodes, online, selectedNodeId, selectedNodeParentId }: UseSidebarDragOptions) {
  const { canEdit, canMoveInto, canMoveOut } = useCapabilities(online);
  const { spaces } = useSpaces(online);
  const [sbDragId, setSbDragId] = useState<string | null>(null);
  // A note held over a tag row of the sidebar's tag list (dropping applies the tag).
  const [sbTagDropId, setSbTagDropId] = useState<string | null>(null);
  // `moveTo`: the space a drop here would move the note to (after the person confirms).
  const [sbDropTarget, setSbDropTarget] = useState<{ id: string; pos: DropPos; moveTo?: string } | null>(null);
  // A space's heading held over: dropping moves the note to that space's top level.
  const [sbDropSpace, setSbDropSpace] = useState<{ id: string; label: string } | null>(null);
  const [sbSpaceMove, setSbSpaceMove] = useState<SidebarSpaceMove | null>(null);
  const [sbDragOverlay, setSbDragOverlay] = useState<{ title: string; isGroup: boolean; x: number; y: number; width: number; height: number } | null>(null);
  // Persisted (per account: the ids are this account's notes) so the sidebar's expand/collapse state
  // survives refresh and re-mount. Without persistence the same tree row
  // could appear collapsed on one render and expanded on another after
  // an autoexpand (e.g. selectedNodeParentId effect below), which was
  // the "有時折疊有時展開" report.
  const [openGroups, setExpandedGroups] = useState<Set<string>>(() => {
    const arr = getPrefJson(PREFS.expandedGroups);
    return new Set(Array.isArray(arr) ? arr.filter((v): v is string => typeof v === "string") : []);
  });

  // Write-through on every set so the stored state is always current.
  useEffect(() => {
    setPrefJson(PREFS.expandedGroups, [...openGroups]);
  }, [openGroups]);

  // Rows (notes and tags) a held note opened by staying over them (lib/springOpen). Shown open like the
  // saved ones but never saved: the drag's end clears them, and only the place a drop lands is kept open.
  const [springOpened, setSpringOpened] = useState<ReadonlySet<string>>(new Set());
  // The row waiting to open (its hint) and how long it waits.
  const [springHint, setSpringHint] = useState<{ id: string; ms: number } | null>(null);
  // Tags a drop on a tag row kept open (the tag list owns its own open set and takes these into it).
  const [springKept, setSpringKept] = useState<ReadonlySet<string>>(new Set());
  // Handed over once: the tag list's effect (a child's, so it runs first) has taken them by now. Left set,
  // a tag list mounted later would reopen a tag the person has folded since.
  useEffect(() => {
    if (springKept.size > 0) setSpringKept(new Set());
  }, [springKept]);
  const springOpenedRef = useRef<ReadonlySet<string>>(springOpened);
  springOpenedRef.current = springOpened;
  const springRef = useRef<SpringOpen | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const expandedGroups = useMemo(
    () => (springOpened.size === 0 ? openGroups : new Set([...openGroups, ...springOpened])),
    [openGroups, springOpened],
  );

  const sbDragRef = useRef<{
    id: string;
    title: string;
    isGroup: boolean;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
  } | null>(null);
  const sbDropTargetRef = useRef<{ id: string; pos: DropPos; isGroup: boolean } | null>(null);
  const sbTagDropRef = useRef<string | null>(null);
  const sbSpaceDropRef = useRef<string | null>(null);
  const touchGuardRef = useRef(createTouchPressGuard());
  const autoScrollRef = useRef(createEdgeAutoScroll(() => !!sbDragRef.current, (x, y) => updateSidebarDropTargetRef.current(x, y)));
  const updateSidebarDropTargetRef = useRef<(x: number, y: number) => void>(() => {});

  useEffect(() => {
    if (selectedNodeParentId) {
      setExpandedGroups((prev) => new Set([...prev, selectedNodeParentId]));
    }
  }, [selectedNodeId, selectedNodeParentId]);

  /** Whether dropping `dragId` at `pos` of row `targetId` is a place the note
   *  may go (lib/data canPlaceUnder, the one placement rule — D101): not a
   *  tag, not itself or a descendant, the same space, live, a parent this
   *  person can edit. "into" makes the row the parent; above/below makes the
   *  row's parent the parent. A drop that keeps the parent (a reorder) is not
   *  a move and needs no placement.
   *
   *  Beside a top-level row the parent is the top level, which the rule always
   *  allows — but the sidebar groups top-level notes by space, so a line
   *  beside another space's row would show the note landing in that space
   *  while it stays in its own. A parent change never moves spaces by itself:
   *  such a drop is a move to that space (spaceDrop), confirmed first. */
  function dropAllowed(dragId: string, targetId: string, pos: DropPos): boolean {
    const dragged = nodes.find((n) => n.id === dragId);
    const target = nodes.find((n) => n.id === targetId);
    if (!dragged || !target || dragId === targetId) return false;
    const parentId = pos === "into" ? target.id : target.parent_id ?? null;
    if (parentId === null) return !dragged.space_id || !target.space_id || dragged.space_id === target.space_id;
    if (parentId === (dragged.parent_id ?? null)) return true;
    return canPlaceUnder(nodes.find((n) => n.id === parentId), dragged, { nodes, canEdit });
  }

  /** Whether `dragged` may be moved into `to`: online, a note this person can edit, out of a
   *  space it may leave, into one they may write, and (under `parentId`) a place the placement
   *  rule allows once it is in `to`. The same checks as the note menu's 「移動到…」 offers. */
  function spaceMoveAllowed(dragged: ContentNode, to: Space, parentId: string | null): boolean {
    const from = spaces.find((s) => s.id === dragged.space_id);
    if (!online || !from || from.id === to.id || isTag(dragged)) return false;
    if (!canEdit(dragged) || !canMoveOut(from) || !canMoveInto(to)) return false;
    if (parentId === null) return true;
    return canPlaceUnder(nodes.find((n) => n.id === parentId), { ...dragged, space_id: to.id }, { nodes, canEdit });
  }

  /** Where dropping `dragId` at `pos` of row `targetId` would move it, when that row is in
   *  another space and the move is allowed: the space and the note it ends up under there. */
  function spaceDrop(dragId: string, targetId: string, pos: DropPos): { to: Space; parentId: string | null } | null {
    const dragged = nodes.find((n) => n.id === dragId);
    const target = nodes.find((n) => n.id === targetId);
    if (!dragged || !target || dragId === targetId || !dragged.space_id || !target.space_id || dragged.space_id === target.space_id) return null;
    const to = spaces.find((s) => s.id === target.space_id);
    const parentId = pos === "into" ? target.id : target.parent_id ?? null;
    return to && spaceMoveAllowed(dragged, to, parentId) ? { to, parentId } : null;
  }

  /** Whether `noteId` may take `tagId` by a drop: a note (not a tag) this
   *  person can edit that does not carry the tag yet. */
  function tagDropAllowed(noteId: string, tagId: string): boolean {
    const note = nodes.find((n) => n.id === noteId);
    if (!note || isTag(note) || !canEdit(note)) return false;
    return !nodeHasTag(note, tagId);
  }

  async function dropOnTag(noteId: string, tagId: string, opened: ReadonlySet<string>) {
    if (!online || !tagDropAllowed(noteId, tagId)) return;
    const tags = getAppState().data.tags ?? [];
    const tag = tags.find((candidate) => candidate.id === tagId);
    if (!tag?.name) return;
    // The tag row it lands on stays visible: the tags this drag opened above it (and it) stay open while the
    // write runs, and are kept in the tag list's own open set once it is accepted.
    const kept = [tag.id, ...ancestorsOf(indexById(tags), tag).map((above) => above.id)].filter((id) => opened.has(id));
    setSpringOpened(new Set(kept));
    try {
      await tagWriter.apply(noteId, tagId);
      if (kept.length > 0) setSpringKept(new Set(kept));
    } catch {
      return; // The writer has reported the failure and put the note back.
    } finally {
      setSpringOpened((prev) => (prev.size === 0 ? prev : new Set([...prev].filter((id) => !kept.includes(id)))));
    }
    addToast(t("Added #{name}", { name: tag.name }), "success", {
      label: t("Undo"),
      onClick: () => runBackgroundWrite(tagWriter.remove(noteId, tagId)),
    });
  }

  /** Moves the drop highlight to what is under the pointer and tells the spring timer which folded row, if
   *  any, the held note is waiting over. */
  function updateSidebarDropTarget(clientX: number, clientY: number) {
    const drag = sbDragRef.current;
    if (!drag) return;
    lastPointerRef.current = { x: clientX, y: clientY };
    springRef.current?.hover(locateDropTarget(drag, clientX, clientY));
  }

  /** Sets the drop state for the point and returns the folded row a drop there would open, else null. */
  function locateDropTarget(drag: NonNullable<typeof sbDragRef.current>, clientX: number, clientY: number): string | null {
    const hit = document.elementFromPoint(clientX, clientY);
    // A tag row of the tag list: dropping a note on it applies the tag.
    const tagId = hit?.closest<HTMLElement>("[data-sb-tag-id]")?.dataset.sbTagId ?? null;
    const tagDrop = tagId && tagDropAllowed(drag.id, tagId) ? tagId : null;
    sbTagDropRef.current = tagDrop;
    setSbTagDropId(tagDrop);
    if (tagId) {
      sbDropTargetRef.current = null;
      setSbDropTarget(null);
      sbSpaceDropRef.current = null;
      setSbDropSpace(null);
      return hit?.closest<HTMLElement>("[data-sb-tag-id]")?.dataset.sbExpanded === "false" ? tagId : null;
    }
    const spaceHeadingId = hit?.closest<HTMLElement>("[data-sb-space-id]")?.dataset.sbSpaceId ?? null;
    const headingSpace = spaceHeadingId ? spaces.find((s) => s.id === spaceHeadingId) : undefined;
    const dragged = nodes.find((n) => n.id === drag.id);
    const headingDrop = headingSpace && dragged && spaceMoveAllowed(dragged, headingSpace, null) ? headingSpace : null;
    sbSpaceDropRef.current = headingDrop?.id ?? null;
    setSbDropSpace(headingDrop ? { id: headingDrop.id, label: spaceLabel(headingDrop) } : null);
    if (spaceHeadingId) {
      sbDropTargetRef.current = null;
      setSbDropTarget(null);
      return null;
    }
    const el = hit?.closest<HTMLElement>("[data-sb-id]");
    const id = el?.dataset.sbId;
    if (!el || !id || id === drag.id) {
      sbDropTargetRef.current = null;
      setSbDropTarget(null);
      return null;
    }

    const isGroup = el.dataset.sbKind === "group";
    const row = el.querySelector<HTMLElement>(".obsidian-group-header") ?? el;
    const r = row.getBoundingClientRect();
    const y = clientY - r.top;
    let pos: DropPos;

    if (y < r.height * 0.25) pos = "above";
    else if (y > r.height * 0.75) pos = "below";
    else pos = "into";

    // An invalid drop shows no target at all (no line, no highlight), rather
    // than a target the server then refuses and the move rolls back.
    const moving = spaceDrop(drag.id, id, pos);
    if (!moving && !dropAllowed(drag.id, id, pos)) {
      sbDropTargetRef.current = null;
      setSbDropTarget(null);
      return null;
    }

    sbDropTargetRef.current = { id, pos, isGroup };
    setSbDropTarget({ id, pos, moveTo: moving ? spaceLabel(moving.to) : undefined });
    // The "into" band starts the wait (it is the drop the row is drawn for); once waiting, the finger may drift
    // into the row's upper or lower quarter without restarting it, as long as it stays on the row.
    const folded = isGroup && el.dataset.sbExpanded === "false";
    return folded && (pos === "into" || springRef.current?.current() === id) ? id : null;
  }

  // The folded row opened: redo the hit test on the longer list, which has moved under a still pointer.
  useEffect(() => {
    const at = lastPointerRef.current;
    if (springOpened.size > 0 && at && sbDragRef.current) updateSidebarDropTargetRef.current(at.x, at.y);
  }, [springOpened]);

  updateSidebarDropTargetRef.current = updateSidebarDropTarget;
  const stopSidebarAutoScroll = () => autoScrollRef.current.stop();
  const startSidebarAutoScroll = (x: number, y: number) => autoScrollRef.current.start(x, y);

  function onSbDragEnd() {
    springRef.current?.cancel();
    springRef.current = null;
    lastPointerRef.current = null;
    setSpringOpened((prev) => (prev.size === 0 ? prev : new Set()));
    splitDrag.cancel();
    stopSidebarAutoScroll();
    sbDragRef.current = null;
    sbDropTargetRef.current = null;
    sbTagDropRef.current = null;
    sbSpaceDropRef.current = null;
    setSbTagDropId(null);
    setSbDropSpace(null);
    setSbDragId(null);
    setSbDropTarget(null);
    setSbDragOverlay(null);
  }

  /** A touch press is in progress (or just ended): the browser's own
   *  long-press contextmenu belongs to it and is swallowed — the press opens
   *  the menu itself when the finger lifts without moving. */
  function consumeTouchContextMenu(e: React.MouseEvent): boolean {
    return touchGuardRef.current.swallow(e);
  }

  function onSbPointerDown(e: React.PointerEvent, item: ContentNode, isGroup: boolean, onHoldRelease?: (x: number, y: number) => void) {
    if (e.button !== 0 || !online) return;
    const target = e.target as HTMLElement;
    if (target.closest(".obsidian-delete-btn, .obsidian-group-toggle, .sb-rename-input")) return;

    e.stopPropagation();
    const source = e.currentTarget as HTMLElement;
    const row = source.querySelector<HTMLElement>(".obsidian-group-header") ?? source;
    const rect = row.getBoundingClientRect();
    const offsetX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const offsetY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
    const startX = e.clientX;
    const startY = e.clientY;
    let active = false;
    const drag = { id: item.id, title: item.title, isGroup, offsetX, offsetY, width: rect.width, height: rect.height };

    // Touch and S Pen: a move-threshold drag start NEVER survives here — the browser claims the
    // gesture for scrolling and fires pointercancel a few px in (the "手機拖動" report). So the
    // shared hold gesture (lib/touchHold, also the tag rows') decides: held still for HOLD_MS lifts
    // the row, then moving drags it and lifting in place opens the row's menu — never both; moving
    // before the lift, or the browser scrolling, hands the gesture to the list.
    const activate = () => {
      sbDragRef.current = drag;
      sbDropTargetRef.current = null;
      const ms = isHoldPointer(e.pointerType) ? SPRING_OPEN_TOUCH_MS : SPRING_OPEN_MS;
      springRef.current = createSpringOpen(ms, {
        onArm: (id) => setSpringHint({ id, ms }),
        onDisarm: () => setSpringHint(null),
        onOpen: (id) => { setSpringHint(null); setSpringOpened((prev) => new Set(prev).add(id)); },
        stillOver: () => {
          const at = lastPointerRef.current;
          const live = sbDragRef.current;
          return at && live ? locateDropTarget(live, at.x, at.y) : null;
        },
      });
      // Dragged to the right half of the window, the note opens beside (lib/splitViewStore).
      splitDrag.begin({ kind: "note", id: item.id, tab: CONTENT_TAB }, "note");
      setSbDragId(item.id);
      setSbDropTarget(null);
    };
    const showOverlay = (x: number, y: number) => {
      if (!sbDragRef.current) return; // the drag was cancelled (Esc, window lost focus)
      setSbDragOverlay({ title: drag.title, isGroup: drag.isGroup, x: x - offsetX, y: y - offsetY, width: drag.width, height: drag.height });
    };
    const finishDrop = (x: number, y: number) => {
      if (splitDrag.drop(x)) { stopSidebarAutoScroll(); onSbDragEnd(); return; }
      const srcId = sbDragRef.current?.id ?? null;
      // Recompute the drop target from the RELEASE coordinates rather than
      // trusting the last pointermove's ref: a live re-render can shift the list
      // between the final move and the lift, leaving sbDropTargetRef stale or null
      // and silently dropping the 'into' reparent.
      updateSidebarDropTarget(x, y);
      const drop = sbDropTargetRef.current;
      const tagDrop = sbTagDropRef.current;
      const headingSpaceId = sbSpaceDropRef.current;
      const opened = springOpenedRef.current;
      stopSidebarAutoScroll();
      onSbDragEnd();
      if (srcId && tagDrop) void dropOnTag(srcId, tagDrop, opened);
      else if (srcId && headingSpaceId) askToMoveToSpace(srcId, headingSpaceId, null);
      else if (srcId && drop) void performSidebarDrop(srcId, drop.id, drop.isGroup, drop.pos);
    };
    const tookPress = beginTouchHold(e, touchGuardRef.current, {
      onLift: () => { activate(); showOverlay(startX, startY); },
      onDrag: (x, y) => {
        splitDrag.move(x);
        showOverlay(x, y);
        startSidebarAutoScroll(x, y);
        updateSidebarDropTarget(x, y);
      },
      onRelease: (x, y, moved) => {
        if (!moved) {
          // Held and let go in place: the menu, no drop.
          onSbDragEnd();
          onHoldRelease?.(startX, startY);
          return;
        }
        finishDrop(x, y);
      },
      onAbort: () => { stopSidebarAutoScroll(); onSbDragEnd(); },
    });
    if (tookPress) return;

    // Mouse: dragging starts once the pointer has moved a few px.
    const onMove = (moveEvent: PointerEvent) => {
      if (!active) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_SLOP_PX) return;
        active = true;
        activate();
      } else if (!sbDragRef.current) {
        removeListeners(); // cancelled meanwhile
        return;
      }
      moveEvent.preventDefault();
      splitDrag.move(moveEvent.clientX);
      showOverlay(moveEvent.clientX, moveEvent.clientY);
      startSidebarAutoScroll(moveEvent.clientX, moveEvent.clientY);
      updateSidebarDropTarget(moveEvent.clientX, moveEvent.clientY);
    };
    const removeListeners = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    const onUp = (upEvent: PointerEvent) => {
      removeListeners();
      if (!active) return;
      upEvent.preventDefault();
      finishDrop(upEvent.clientX, upEvent.clientY);
    };
    const onCancel = () => {
      removeListeners();
      stopSidebarAutoScroll();
      onSbDragEnd();
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp, { passive: false });
    window.addEventListener("pointercancel", onCancel);
  }

  /** Opens the confirmation for moving `noteId` to `spaceId` (under `parentId` there); the move itself
   *  is `finishSpaceMove`, once the person has seen who gains and loses sight of the note. */
  function askToMoveToSpace(noteId: string, spaceId: string, parentId: string | null) {
    const node = nodes.find((n) => n.id === noteId);
    const to = spaces.find((s) => s.id === spaceId);
    if (node && to && spaceMoveAllowed(node, to, parentId)) setSbSpaceMove({ node, to, parentId });
  }

  /** Runs the write that puts `srcId` under `parentId`, with the path down to `parentId` shown open meanwhile
   *  (the drag's own openings are already cleared, and the note must not vanish into a folded parent while the
   *  server answers). The path is saved as open only once the note really is under `parentId`: the writers
   *  roll a refused move back and swallow the error, so the store is the answer. The one place the drag's
   *  opening becomes the saved open state. */
  async function landUnder(parentId: string, srcId: string, write: () => Promise<unknown>) {
    const parent = nodes.find((n) => n.id === parentId);
    const path = [...(parent ? ancestorsOf(indexById(nodes), parent).map((n) => n.id) : []), parentId];
    setSpringOpened(new Set(path));
    try {
      await write();
    } finally {
      if (getNode(srcId)?.parent_id === parentId) {
        setExpandedGroups((prev) => new Set([...prev, ...path]));
      }
      setSpringOpened((prev) => (prev.size === 0 ? prev : new Set([...prev].filter((id) => !path.includes(id)))));
    }
  }

  /** The note is in its new space now (moveToSpace puts it at the top level): place it under the
   *  note it was dropped on, by the ordinary change of parent. */
  async function finishSpaceMove() {
    const move = sbSpaceMove;
    setSbSpaceMove(null);
    if (!move?.parentId) return;
    const parentId = move.parentId;
    await landUnder(parentId, move.node.id, () => noteStructure.appendChild(parentId, move.node.id));
  }

  async function performSidebarDrop(srcId: string, targetId: string, isGroup: boolean, pos: DropPos) {
    if (!srcId || srcId === targetId || !online) return;
    const srcNode = nodes.find((n) => n.id === srcId);
    const tgtNode = nodes.find((n) => n.id === targetId);
    if (!srcNode || !tgtNode) return;
    const moving = spaceDrop(srcId, targetId, pos);
    if (moving) { askToMoveToSpace(srcId, moving.to.id, moving.parentId); return; }
    if (!dropAllowed(srcId, targetId, pos)) return;

    if (pos === "into") {
      if (srcNode.parent_id === targetId) return;
      // Through the note writer: shown moved at once, queued when offline, and
      // moved back if the server refuses (the raw call never rolled back).
      // Last among its new siblings, the place it is shown landing.
      await landUnder(targetId, srcId, () => noteStructure.appendChild(targetId, srcId));
      return;
    }

    const newParentId = tgtNode.parent_id ?? null;

    // Only the target's siblings are renumbered, and only the rows whose
    // sort_order must change (noteStructure.reorder).
    const ids = noteStructure.children(newParentId).map((n) => n.id).filter((id) => id !== srcId);
    const idx = ids.indexOf(targetId);
    if (idx < 0) return;
    ids.splice(pos === "above" ? idx : idx + 1, 0, srcId);
    const reorder = () => noteStructure.reorder(newParentId, ids, srcId);
    if (newParentId) await landUnder(newParentId, srcId, reorder); else await reorder();
  }

  function toggleGroup(groupId: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      return next;
    });
  }

  function expandAllGroups() {
    setExpandedGroups(new Set(groupNodes(nodes).map((n) => n.id)));
  }

  function collapseAllGroups() {
    setExpandedGroups(new Set());
  }

  // A drag that ends any way but a drop: Esc, or the page going to the background (an app switch).
  const dragging = sbDragId !== null;
  useEscapeCancel(() => { if (sbDragRef.current) onSbDragEnd(); }, dragging);
  useEffect(() => {
    if (!dragging) return;
    return onPageHide(() => onSbDragEnd());
  }, [dragging]); // eslint-disable-line react-hooks/exhaustive-deps -- onSbDragEnd only touches refs and setters

  // Unmounted mid-drag: no timer or scroll loop left running.
  useEffect(() => () => {
    springRef.current?.cancel();
    sbDragRef.current = null;
    autoScrollRef.current.stop();
    splitDrag.cancel();
  }, []);

  const dragOverlay = useMemo(() => {
    if (!sbDragOverlay) return null;
    const moveTo = sbDropSpace?.label ?? sbDropTarget?.moveTo;
    return moveTo ? { ...sbDragOverlay, moveTo } : sbDragOverlay;
  }, [sbDragOverlay, sbDropSpace, sbDropTarget]);

  return {
    sbDragId,
    sbDropTarget,
    sbDropSpace,
    sbSpaceMove,
    cancelSpaceMove: () => setSbSpaceMove(null),
    nodeTitle: (id: string) => displayTitle(nodes.find((n) => n.id === id)?.title),
    finishSpaceMove,
    sbTagDropId,
    springHint,
    springOpened,
    springKept,
    sbDragOverlay: dragOverlay,
    expandedGroups,
    setExpandedGroups,
    onSbPointerDown,
    consumeTouchContextMenu,
    onSbDragEnd,
    performSidebarDrop,
    toggleGroup,
    expandAllGroups,
    collapseAllGroups,
  };
}
