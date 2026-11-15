import { useCallback, useEffect, useMemo, useRef } from "react";
import { isTagBoard } from "../lib/nodeTags";
import { addToast, getAppState, useAllNodes } from "../lib/appStore";
import { dayNotes } from "../lib/data";
import { t } from "../lib/i18n";
import { CONTENT_TAB, activeTabKey } from "../lib/viewTabs";
import { defaultRightNote, isModClick, notePress, panesConflict, samePane, type PaneTarget, type Side } from "../lib/splitView";
import {
  addressNamedRight, applySavedSplit, canSplit, onSplitDrop, refuseRight, setRight, useSavedSplit, useSplit,
} from "../lib/splitViewStore";
import { isModuleScreen } from "../modules";
import type { AppMode } from "./useUiMode";
import { useIsMobile } from "./useIsMobile";

type Args = {
  mode: AppMode;
  setMode: (mode: AppMode) => void;
  selectedId: string | null;
  notesView: string;
  viewTab: string | null;
  openNote: (id: string, opts?: { content?: boolean }) => void;
  selectTab: (key: string) => void;
  openModuleScreen: (view: string) => void;
};

/** Side by side, for the workspace: what the left pane shows, and the
 *  operations that open, swap and close the right one. Every entry — a drop,
 *  a tab's menu, the shortcut, a Ctrl-click — ends in these, so the rules
 *  (two sides, no pair that would overwrite or repeat) live once. */
export function useSplitView({ mode, setMode, selectedId, notesView, viewTab, openNote, selectTab, openModuleScreen }: Args) {
  const stored = useSplit();
  const phone = useIsMobile();
  // A window narrowed to a phone mid-session keeps the stored pane (it is back when widened) but shows none.
  const split = useMemo(() => (phone && stored.right ? { ...stored, right: null } : stored), [stored, phone]);
  const nodes = useAllNodes();
  const saved = useSavedSplit();

  // What the left pane shows. A note's tab is its view key (content, canvas, a saved view).
  const left: PaneTarget | null = mode === "notes"
    ? (selectedId ? { kind: "note", id: selectedId, tab: activeTabKey({ lens: notesView, viewTab }) } : null)
    : { kind: "page", mode };
  const leftRef = useRef(left); leftRef.current = left;

  // The URL names the pane first (App seeds it before this runs); otherwise
  // the account's saved pane, once the account's preference has loaded.
  const restored = useRef(addressNamedRight());
  useEffect(() => {
    if (restored.current || !saved.settled || phone) return;
    restored.current = true;
    applySavedSplit(saved.value);
  }, [saved.settled, saved.value, phone]);

  useEffect(() => {
    const press = (event: PointerEvent) => notePress(event, performance.now());
    window.addEventListener("pointerdown", press, true);
    return () => window.removeEventListener("pointerdown", press, true);
  }, []);

  const openLeft = useCallback((target: PaneTarget) => {
    if (target.kind === "page") {
      if (isModuleScreen(target.mode)) openModuleScreen(target.mode); else setMode(target.mode);
      return;
    }
    openNote(target.id);
    if (target.tab !== CONTENT_TAB) selectTab(target.tab);
    else selectTab(CONTENT_TAB);
  }, [openModuleScreen, setMode, openNote, selectTab]);

  const openRight = useCallback((target: PaneTarget): boolean => {
    if (!canSplit()) return false;
    const refused = refuseRight(leftRef.current, target);
    if (refused) {
      addToast(refused === "same-page"
        ? t("That page is already open on the left.")
        : t("That view is already open on the left."), "info");
      return false;
    }
    setRight(target);
    return true;
  }, []);

  /** Open `target` on `side`: the right side is the pane, the left is where a click goes. */
  const openOn = useCallback((target: PaneTarget, side: Side) => {
    if (side === "left") { openLeft(target); return; }
    openRight(target);
  }, [openLeft, openRight]);

  const closeRight = useCallback(() => setRight(null), []);

  /** ⇄: the right pane's destination becomes the left, the left's the right. */
  const swap = useCallback(() => {
    const right = split.right;
    const now = leftRef.current;
    if (!right) return;
    openLeft(right);
    setRight(now);
  }, [split.right, openLeft]);

  /** A note or page opened FROM one side lands on the other (Ctrl-click, a
   *  table row, a task's note) — except that the far side is only replaced when
   *  it shows a note; a function page never replaces itself. */
  const openBeside = useCallback((id: string, from: Side) => {
    if (from === "left" && canSplit()) openRight({ kind: "note", id, tab: CONTENT_TAB });
    else openLeft({ kind: "note", id, tab: CONTENT_TAB });
  }, [openRight, openLeft]);

  /** Ctrl+\: the current tab on the right, else the default note, or close. */
  const toggleCurrent = useCallback(async () => {
    if (!canSplit()) return;
    if (split.right) { setRight(null); return; }
    const now = leftRef.current;
    if (now?.kind === "note" && now.tab !== CONTENT_TAB) {
      // Whiteboard or a saved view: it goes right and the text takes its place on the left
      // (the left changes first, so the pair is never the same view twice).
      selectTab(CONTENT_TAB);
      setRight(now);
      return;
    }
    const leftNoteId = now?.kind === "note" ? now.id : null;
    let today: string | null = null;
    if (!defaultRightNote(nodes, leftNoteId, null)) {
      try { today = (await dayNotes.openToday({ create: false }))?.node.id ?? null; } catch { today = null; }
    }
    const target = defaultRightNote(nodes, leftNoteId, today);
    if (target) openRight(target);
    else addToast(t("Write a note first, then open it beside."), "info");
  }, [split.right, nodes, openRight, selectTab]);

  // The left changed so that it now repeats the right (a note opened on the
  // left that the right also shows as text): the right side gives way.
  useEffect(() => {
    const right = split.right;
    if (right && left && panesConflict(left, right)) {
      setRight(null);
      addToast(t("The right side was closed: it showed what is now open on the left."), "info");
    }
  }, [split.right, left && (left.kind === "note" ? `${left.id}:${left.tab}` : left.mode)]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed by the left's identity

  // The right note was deleted: nothing to show.
  const rightGone = split.right?.kind === "note" && nodes.length > 0 && !nodes.some((n) => n.id === (split.right as { id: string }).id) && !splitRightIsTag(split.right.id);
  useEffect(() => { if (rightGone) setRight(null); }, [rightGone]);

  // A drop decides here, for every source.
  useEffect(() => onSplitDrop((target, side, from) => {
    if (from === "right-header") { if (side === "left") swapTo(target); return; }
    if (from === "menu" && side === "left") { openLeft(target); return; }
    openOn(target, side);
  }), [openOn]); // eslint-disable-line react-hooks/exhaustive-deps -- swapTo reads refs

  function swapTo(target: PaneTarget) { if (samePane(target, split.right)) swap(); }

  return {
    split, phone, left, openOn, openRight, closeRight, swap, openBeside, toggleCurrent, openLeft,
    /** A tab's menu 「在這裡看／開在右邊」 for the note on the left. */
    openTabOnRight: (noteId: string, tab: string) => openRight({ kind: "note", id: noteId, tab }),
    /** The click being handled held Ctrl/⌘, and the window has two sides. */
    modClick: () => !phone && isModClick(performance.now()),
  };
}

const splitRightIsTag = (id: string): boolean => isTagBoard(getAppState().data, id);
