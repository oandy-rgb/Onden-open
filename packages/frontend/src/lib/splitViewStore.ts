import { useSyncExternalStore } from "react";
import { createAccountPref } from "./accountPrefStore";
import { isMobileLayout } from "./mediaQuery";
import { PREFS } from "./prefs";
import { viewOfRetiredToday } from "./retiredViews";
import {
  SPLIT_RATIO_DEFAULT, clampRatio, decodePane, dropSideAt, encodePane, panesConflict, samePane,
  type PaneTarget, type Side,
} from "./splitView";

// The state of side by side: the right pane's destination and the split ratio.
// A phone has no side by side (owner, 2026-11-08): `canSplit` is the one answer, and
// every way in (drop, menu, shortcut, URL, saved pref) and the write-back ask it. Per person, per account
// (`splitPane` pref, kept per kind of screen: lib/accountPrefStore `deviceKind`) and in the URL (`right=…`) so a
// reload or a shared link comes back the same. Not data: nothing here writes
// a note. The drag controller at the bottom is the one place a drop is decided.

type Saved = { right: string | null; ratio: number };

/** A right pane named by the address or the saved pane. 「今天」 (a page until 2026-11-18) opens where `view=today` does;
 *  with neither 任務 nor 日記 on that is 筆記, which is no pane: the right side stays closed. */
function decodeRight(text: string | null | undefined): PaneTarget | null {
  if (text !== "page:today") return decodePane(text);
  const view = viewOfRetiredToday();
  return view === "notes" ? null : { kind: "page", mode: view };
}

const splitPanePref = createAccountPref<Saved>({
  serverKey: "splitPane",
  follows: "deviceKind", // a side-by-side pane exists only at desktop width; the phone has its own (empty) value
  copy: PREFS.splitPaneCopy,
  parse: (value) => {
    if (!value || typeof value !== "object") return null;
    const { right, ratio } = value as Record<string, unknown>;
    if (right !== null && typeof right !== "string") return null;
    return { right: right as string | null, ratio: typeof ratio === "number" ? clampRatio(ratio) : SPLIT_RATIO_DEFAULT };
  },
});
export const useKeepSplitPaneSynced = splitPanePref.useKeepInSync;

type State = { right: PaneTarget | null; ratio: number };
let state: State = { right: null, ratio: SPLIT_RATIO_DEFAULT };

/** Whether this device can show two sides: not in the phone layout (same test as `useIsMobile`). */
export const canSplit = (): boolean => !isMobileLayout();
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  listeners.forEach((fn) => fn());
};
const remember = () => {
  // A phone never writes the account's pane: it must not change what the desktop shows.
  if (!canSplit() || !splitPanePref.bound()) return;
  splitPanePref.store.save({ right: state.right ? encodePane(state.right) : null, ratio: state.ratio });
};

export const getSplit = (): State => state;
export const subscribeSplit = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const useSplit = (): State => useSyncExternalStore(subscribeSplit, getSplit, getSplit);

/** Why a destination cannot go to the right pane, or null. `left` is what the
 *  left pane shows now: one page twice, or one saved view twice. */
export function refuseRight(left: PaneTarget | null, target: PaneTarget): "same-view" | "same-page" | null {
  if (!left || !panesConflict(left, target)) return null;
  return target.kind === "page" ? "same-page" : "same-view";
}

export function setRight(target: PaneTarget | null): void {
  if (target && !canSplit()) return;
  if (samePane(target, state.right)) return;
  set({ right: target });
  remember();
}
export function setRatio(ratio: number): void { set({ ratio: clampRatio(ratio) }); }
export function commitRatio(): void { remember(); }

/** The URL (`right=`) says what the right pane shows — on load and on
 *  Back/forward. Absent: closed. Not saved: the address bar is only following. */
let urlNamedRight = false;
/** Whether the address named the right pane when the app opened (it wins over the saved one). */
export const addressNamedRight = (): boolean => urlNamedRight;
export function applyUrlRight(value: string | null, initial = false): void {
  // A phone shows only the left note: `right=` is ignored there, and never written.
  if (!canSplit()) return;
  const right = decodeRight(value);
  if (initial) urlNamedRight = right !== null;
  if (!samePane(right, state.right)) set({ right });
}
/** The account's saved pane, once, when the URL named none. */
export function applySavedSplit(saved: Saved | null): void {
  if (!saved || !canSplit()) return;
  set({ right: decodeRight(saved.right), ratio: clampRatio(saved.ratio) });
  // The retired 今天 pane is saved over with where it opened, so that it is not read (and resolved) again at every start.
  if (saved.right === "page:today") remember();
}
export function useSavedSplit(): { value: Saved | null; settled: boolean } {
  const { value, settled } = splitPanePref.useValue();
  return { value, settled };
}

/** `&right=…` for the URL writer, "" when closed. */
export function rightSearch(right: PaneTarget | null): string {
  return right ? `&right=${encodeURIComponent(encodePane(right))}` : "";
}

// ── Dragging into a side ────────────────────────────────────────────────────
// Three sources — a view tab, a note in the sidebar, a function in the top
// bar — plus the right pane's own header. Each has its own gesture (HTML5
// drag, the sidebar's pointer drag), but all report the same four things here
// and the drop is decided once: the right half of the window opens the
// destination on the right; the left half (only while dragging the right
// pane's header) brings it back to the left. Esc cancels (SplitDropHint, through hooks/useEscapeKey).

type DropSource = "tab" | "note" | "function" | "right-header" | "menu";
type Drag = { target: PaneTarget; from: Exclude<DropSource, "menu">; side: Side | null; cancelled: boolean };
let drag: Drag | null = null;
let dropHandler: ((target: PaneTarget, side: Side, from: DropSource) => void) | null = null;
const dragListeners = new Set<() => void>();
const tell = () => dragListeners.forEach((fn) => fn());
export const useSplitDrag = (): { target: PaneTarget; side: Side | null; from: Drag["from"] } | null =>
  useSyncExternalStore((fn) => { dragListeners.add(fn); return () => { dragListeners.delete(fn); }; }, () => drag, () => drag);

/** A menu entry (「開在右邊」) asks for the same thing a drop does. */
export function requestSplitOpen(target: PaneTarget, side: Side): void { if (canSplit()) dropHandler?.(target, side, "menu"); }
/** Close the right side from anywhere (a menu, the note's 編輯｜並排｜預覽): requestSplitOpen's pair. */
export function requestSplitClose(): void { setRight(null); }

/** The workspace says what a drop does (it knows the left pane). */
export function onSplitDrop(handler: typeof dropHandler): () => void {
  dropHandler = handler;
  return () => { if (dropHandler === handler) dropHandler = null; };
}

export const splitDrag = {
  begin(target: PaneTarget, from: Drag["from"]): void {
    if (!canSplit()) return;
    drag = { target, from, side: null, cancelled: false };
    tell();
  },
  /** The pointer is at `x`. Only the right half is a landing for a new
   *  destination; the left half only for the right pane's own header. */
  move(x: number): void {
    if (!drag) return;
    const side = dropSideAt(x, window.innerWidth);
    const landing = side === "right" || (side === "left" && drag.from === "right-header") ? side : null;
    if (landing !== drag.side) { drag = { ...drag, side: landing }; tell(); }
  },
  /** Released at `x`: true when it was a drop on a landing (the source then
   *  skips its own drop handling). */
  drop(x: number): boolean {
    if (!drag) return false;
    splitDrag.move(x);
    const done = drag;
    splitDrag.cancel();
    if (done.cancelled || !done.side) return false;
    dropHandler?.(done.target, done.side, done.from);
    return true;
  },
  /** Esc, or the source gave up. Returns whether anything was being dragged. */
  cancel(): boolean {
    if (!drag) return false;
    drag = { ...drag, cancelled: true };
    const was = drag;
    drag = null;
    tell();
    return !!was;
  },
  active: () => drag !== null,
};

/** While something is dragged: follow the pointer for the sources that drag with HTML5
 *  (view tab, top-bar function, pane header) — they report it through dragover/drop on the
 *  window. The sidebar's pointer drag calls splitDrag itself. Returns the stop function. */
export function followDragPointer(): () => void {
  const over = (event: DragEvent) => { splitDrag.move(event.clientX); if (splitDrag.active()) event.preventDefault(); };
  const drop = (event: DragEvent) => { if (splitDrag.drop(event.clientX)) event.preventDefault(); };
  window.addEventListener("dragover", over);
  window.addEventListener("drop", drop);
  return () => { window.removeEventListener("dragover", over); window.removeEventListener("drop", drop); };
}
