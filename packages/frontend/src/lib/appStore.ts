// The app-wide external store (H4 structural fix).
//
// Why not React state in BuilderApp: the Bootstrap blob + selection + the
// editor draft all lived in useState hooks composed by BuilderApp, so every
// editor keystroke re-rendered the whole workspace tree. This store moves
// that state OUT of the render path; components subscribe to exactly the
// slice they need via `useAppSelector`, so a draft change re-renders only
// draft subscribers.
//
// Same pattern as lib/i18n.ts (useSyncExternalStore + module-level state) —
// deliberately hand-rolled, no zustand: the project vendors dependencies it
// can own, and selector-grade granularity only needs a cached-snapshot
// selector hook (below).
//
// Mutation flow is unchanged: the lib/data/ factories stay the mutation
// layer — their DataCtx now reads/writes this store instead of a useState
// pair (see useAppData.ts). Components NEVER write state directly; they call
// actions exported here or mutations from lib/data/.

import { setWorkspaceDayStartSource, setWorkspaceTimeZoneSource } from "./localDate";
import { workspaceZoneOf } from "./workspaceTime";
import { useCallback, useRef, useSyncExternalStore } from "react";
import { nodeIndexOf } from "./nodeIndex";
import { noWorkspaceData, type Bootstrap, type Canvas, type CanvasMeta, type ContentNode, type Tag } from "./api";
import type { LocalCopyState } from "./localCopyState";
import { isSystemNode, tagsById } from "./systemNodes";
import { canvasList } from "./canvasList";

// ── Types ────────────────────────────────────────────────────────────────────

export type ToastAction = { label: string; onClick: () => void };
export type ToastKind = "success" | "error" | "info" | "warning";
// `duration` = ms before auto-dismiss; 0 = sticky (the user must dismiss it).
// ToastStack owns the actual timer so it can pause on hover; the store only
// computes the intended lifetime here, severity-scaled.
/** `inDialog`: the answer to something the person just did inside the open dialog (a file that was downloaded from
 *  Settings), so it shows there instead of waiting for the dialog to close (ToastStack). */
export type Toast = { id: string; message: string; kind: ToastKind; duration: number; action?: ToastAction; inDialog?: boolean };
// "rejected" = saving failed (server rejection or local queue persistence).
// Keep Retry enabled and the draft intact; the error/recovery surface explains
// the cause. "saved" requires server or durable queue acknowledgement.
/** "queued": the save is durable on this device, waiting for the server. */
export type SaveStatus = "saved" | "queued" | "saving" | "unsaved" | "rejected";

/** The sidebar's tabs: 標籤 and 收件匣 (phone only), 筆記. The inbox tab shows the inbox page
 *  (modules/capture InboxScreen, where what waits for a decision is too). */
export type OverviewPane = "tags" | "nodes" | "inbox";

export type AppState = {
  /** The Bootstrap blob — server truth mirrored locally (sql.js write-through). */
  data: Bootstrap;
  online: boolean;
  bootstrapped: boolean;
  /** Step D display gate: true while read-membership may be stale (a permission
   *  change is pending reconciliation, or a reconcile failed). The UI suppresses
   *  possibly-restricted content + shows "updating permissions…" until it clears.
   *  This — NOT the `online` flag — is the real fail-closed lever: `online` drives
   *  the transition refresh and does not hide local content. Set true on a
   *  membership tick / when reconcile starts or fails; false only when a reconcile
   *  converges. */
  membershipGated: boolean;
  /** This device's offline copy (localDb LocalCopyState): "restarting" while its
   *  worker is replaced, "none" when it could not be opened at all. */
  localCopy: LocalCopyState;
  /** The server runs a newer build than this page (lib/buildVersion.ts). */
  newVersionAvailable: boolean;
  /** The server removed this account from the workspace (lib/accessRevoked.ts).
   *  The local mirror is wiped and the workspace is replaced by a notice. */
  accessRevoked: boolean;
  activeCanvas: Canvas | null;
  /** Focused node id (URL-synced). */
  selectedId: string | null;
  /** Editor draft slice — the HOT path. Only draft subscribers re-render per keystroke. */
  overviewDraft: string;
  overviewTitleDraft: string;
  saveStatus: SaveStatus;
  overviewView: "edit" | "preview";
  /** Sidebar state — hot while typing in the search box. */
  overviewSearch: string;
  overviewSearchOpen: boolean;
  overviewSearchFocusPending: boolean;
  /** 「前往標籤」 asked the sidebar's tag list to open and take focus. */
  sidebarTagsFocusPending: boolean;
  overviewPane: OverviewPane;
  toasts: Toast[];
};

function initialState(): AppState {
  return {
    data: noWorkspaceData,
    online: false,
    bootstrapped: false,
    membershipGated: false,
    localCopy: "ok",
    newVersionAvailable: false,
    accessRevoked: false,
    activeCanvas: null,
    selectedId: null,
    overviewDraft: "",
    overviewTitleDraft: "",
    saveStatus: "saved",
    overviewView: "edit",
    overviewSearch: "",
    overviewSearchOpen: false,
    overviewSearchFocusPending: false,
    sidebarTagsFocusPending: false,
    overviewPane: "nodes",
    toasts: [],
  };
}

// ── Core ─────────────────────────────────────────────────────────────────────

let state: AppState = initialState();
const listeners = new Set<() => void>();

/** The board open on the whiteboard right now (null when none). A narrow reader so board code does not reach for the whole store. */
export const getActiveCanvas = (): Canvas | null => getAppState().activeCanvas;

/** The modules the workspace has on (null/absent: every module, an older server). A narrow reader for code outside React that only asks which modules are on. */
export const getWorkspaceModules = (): readonly string[] | null | undefined => getAppState().data.workspace?.modules;

export function getAppState(): AppState {
  return state;
}

/** Merge a partial (or updater-returning-partial) into the state and notify.
 *  Bails without notifying when every named key is referentially unchanged. */
export function setAppState(
  partial: Partial<AppState> | ((s: AppState) => Partial<AppState>),
): void {
  const next = typeof partial === "function" ? partial(state) : partial;
  let changed = false;
  for (const key of Object.keys(next) as Array<keyof AppState>) {
    if (!Object.is(state[key], next[key])) { changed = true; break; }
  }
  if (!changed) return;
  state = { ...state, ...next };
  for (const l of [...listeners]) l();
}

export function subscribeApp(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test seam — restore pristine state (and notify any stray subscribers). */
export function resetAppState(seed?: Partial<AppState>): void {
  state = { ...initialState(), ...seed };
  for (const l of [...listeners]) l();
}

// ── Selector subscription hook ───────────────────────────────────────────────

/** True when a and b are shallow-equal objects/arrays (Object.is per slot). */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  const ka = Object.keys(a) as Array<keyof T>;
  const kb = Object.keys(b) as Array<keyof T>;
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is(a[k], b[k]));
}

/**
 * Subscribe a component to a slice of the store. Re-renders ONLY when the
 * selected value changes (Object.is by default; pass shallowEqual for
 * selectors that build objects/arrays). The cached snapshot keeps
 * useSyncExternalStore's getSnapshot referentially stable for equal values,
 * which is what makes selector granularity work without zustand.
 */
export function useAppSelector<T>(
  selector: (s: AppState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const isEqualRef = useRef(isEqual);
  isEqualRef.current = isEqual;
  const cacheRef = useRef<{ value: T } | null>(null);
  const getSnapshot = useCallback(() => {
    const next = selectorRef.current(getAppState());
    const cached = cacheRef.current;
    if (cached && isEqualRef.current(cached.value, next)) return cached.value;
    cacheRef.current = { value: next };
    return next;
  }, []);
  return useSyncExternalStore(subscribeApp, getSnapshot, getSnapshot);
}

// ── Stable primitive actions ─────────────────────────────────────────────────
// All referentially stable forever — safe props for React.memo children.

type Updater<T> = T | ((prev: T) => T);
function resolve<T>(updater: Updater<T>, prev: T): T {
  return typeof updater === "function" ? (updater as (p: T) => T)(prev) : updater;
}

export function setData(updater: Updater<Bootstrap>): void {
  setAppState((s) => ({ data: resolve(updater, s.data) }));
}
export function setOnline(online: boolean): void {
  setAppState({ online });
}
export function setBootstrapped(bootstrapped: boolean): void {
  setAppState({ bootstrapped });
}
/** Switch the 「有新版，重新載入」 notice on (lib/buildVersion). Only ever turned on; a reload clears it. */
export function setNewVersionAvailable(newVersionAvailable: boolean): void {
  setAppState({ newVersionAvailable });
}
export function setAccessRevoked(accessRevoked: boolean): void {
  setAppState({ accessRevoked });
}

/** Step D fail-closed display gate — see AppState.membershipGated. */
export function setMembershipGated(membershipGated: boolean): void {
  setAppState({ membershipGated });
}
export function setActiveCanvas(updater: Updater<Canvas | null>): void {
  setAppState((s) => ({ activeCanvas: resolve(updater, s.activeCanvas) }));
}
export function setSelectedId(updater: Updater<string | null>): void {
  setAppState((s) => ({ selectedId: resolve(updater, s.selectedId) }));
}
export function setOverviewView(updater: Updater<"edit" | "preview">): void {
  setAppState((s) => ({ overviewView: resolve(updater, s.overviewView) }));
}
export function setOverviewSearch(overviewSearch: string): void {
  setAppState({ overviewSearch });
}
/** Reveal the note search and request focus once. Keeping it expanded across
 * navigation does not request focus again when the sidebar remounts. */
export function openOverviewSearch(): void {
  setAppState({ overviewPane: "nodes", overviewSearchOpen: true, overviewSearchFocusPending: true });
}
/** Consume only after the sidebar has mounted its input. */
export function consumeOverviewSearchFocus(): boolean {
  if (!getAppState().overviewSearchFocusPending) return false;
  setAppState({ overviewSearchFocusPending: false });
  return true;
}
/** Ask the sidebar's tag list (the desktop's 標籤 section, the phone's 標籤
 *  tab) to open and take focus once. */
export function focusSidebarTags(): void {
  setAppState({ overviewPane: "tags", sidebarTagsFocusPending: true });
}
/** Consume only after the tag list has mounted. */
export function consumeSidebarTagsFocus(): boolean {
  if (!getAppState().sidebarTagsFocusPending) return false;
  setAppState({ sidebarTagsFocusPending: false });
  return true;
}
export function closeOverviewSearch(): void {
  setAppState({ overviewSearch: "", overviewSearchOpen: false, overviewSearchFocusPending: false });
}
export function setOverviewPane(overviewPane: OverviewPane): void {
  setAppState({ overviewPane });
}

// ── Toasts ───────────────────────────────────────────────────────────────────
// Store-resident so addToast is a stable module function (no prop-threading;
// mutations in lib/data/ and components alike just import it).

// Severity-scaled lifetime: info/success are transient (~3s); warnings/errors
// linger so the user actually reads them, scaling with message length. An error
// that needs a decision carries an action and stays until dismissed (0 =
// sticky); a plain error dismisses itself like a warning — unsaved input is
// kept by the recovery panel, not by a toast that never leaves.
function toastDuration(message: string, kind: ToastKind, action?: ToastAction): number {
  const readMs = Math.min(12000, 3000 + message.length * 60);
  if (kind === "error" && action) return 0; // sticky — dismiss via the X button
  if (action) return Math.max(6000, readMs);
  if (kind === "warning" || kind === "error") return readMs;
  return 3000;
}

export function addToast(
  message: string,
  kind: ToastKind = "success",
  action?: ToastAction,
  options?: { inDialog?: boolean },
): void {
  const id = Math.random().toString(36).slice(2);
  const duration = toastDuration(message, kind, action);
  // The same message still on screen is one notice, not a stack of repeats.
  if (!action && getAppState().toasts.some((toast) => toast.message === message && toast.kind === kind && !toast.action)) return;
  setAppState((s) => ({ toasts: [...s.toasts, { id, message, kind, duration, action, ...(options?.inDialog ? { inDialog: true } : {}) }] }));
}

export function dismissToast(id: string): void {
  setAppState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

// ── Derived selectors ────────────────────────────────────────────────────────
// Moved verbatim from useOverviewMode's useMemos. memoLast keeps reference
// identity across calls with unchanged inputs, so useAppSelector subscribers
// (and React.memo children) don't see spurious new arrays.

function memoLast<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
  let last: { args: Args; result: R } | null = null;
  return (...args: Args) => {
    if (last && last.args.length === args.length && last.args.every((a, i) => Object.is(a, args[i]))) {
      return last.result;
    }
    last = { args, result: fn(...args) };
    return last.result;
  };
}


const tagsByIdOf = memoLast((tags: Tag[] | undefined) => tagsById(tags));

const overviewNodesOf = memoLast((nodes: ContentNode[], tags: Tag[] | undefined) =>
  nodes.filter((node) =>
    !node.hidden && !isSystemNode(node, tagsByIdOf(tags)),
  ),
);

// Search finds hidden rows too (a hidden tag, or a note hidden before only
// tags could be, D104) — the server search and the palette agree.
const searchableNodesOf = memoLast((nodes: ContentNode[], tags: Tag[] | undefined) =>
  nodes.filter((node) => !isSystemNode(node, tagsByIdOf(tags))),
);

/** One store node by id in O(1), or undefined. The only way to look a node up
 *  by id in all of the workspace's nodes; do not `nodes.find` the store array. */
export function getNode(id: string | null | undefined): ContentNode | undefined {
  return id ? nodeIndexOf(state.data.nodes).get(id) : undefined;
}

const parentIdsOf = memoLast((nodes: ContentNode[]) => new Set(nodes.map((node) => node.parent_id)));

/** Whether any store node sits under `id` (a PDF's pages, a board's cards, a
 *  note under it), in O(1). */
export function hasChildNote(id: string): boolean {
  return parentIdsOf(state.data.nodes).has(id);
}

/** Whether the app can reach the server right now (the online write paths and 「需要連線」 states read this). */
export function useOnline(): boolean {
  return useAppSelector((s) => s.online);
}

/** Every node row in the workspace, for views that scan them all (e.g. “this
 *  week” summaries). Re-renders on any node change: prefer `useNode(id)` when
 *  you know the id. */
export function useAllNodes(): ContentNode[] {
  return useAppSelector((s) => s.data.nodes);
}

/** The workspace's tag rows. Re-renders when the tag list changes. */
export function useTagRows(): Bootstrap["tags"] {
  return useAppSelector((s) => s.data.tags);
}

/** The id of the focused note, or null. */
export function useSelectedId(): string | null {
  return useAppSelector((s) => s.selectedId);
}

/** The workspace is loaded and checked and has neither a note nor a tag with this id: it was deleted, or access to it was
 *  removed, and nothing is on its way. False while that cannot be told yet (a cold boot, a gated membership). */
export function isNoteGone(id: string): boolean {
  return state.bootstrapped && !state.membershipGated && !getNode(id) && !state.data.tags?.some((tag) => tag.id === id);
}

/** The workspace's notes are loaded and the membership check is done: a note id that is not among them is not on its way. */
export function useWorkspaceChecked(): boolean {
  return useAppSelector((s) => s.bootstrapped && !s.membershipGated);
}

/** The task rows of the workspace (standalone tasks and checkbox lines). Re-renders when any task changes. */
export function useTaskRows(): Bootstrap["tasks"] {
  return useAppSelector((s) => s.data.tasks);
}

/** Subscribes to one node: re-renders only when that node's row changes. */
export function useNode(id: string | null | undefined): ContentNode | undefined {
  return useAppSelector((s) => (id ? nodeIndexOf(s.data.nodes).get(id) : undefined));
}

const selectedNodeOf = memoLast((nodes: ContentNode[], selectedId: string | null) =>
  selectedId ? nodeIndexOf(nodes).get(selectedId) ?? null : null,
);

/** The canvas list, derived from the canvas nodes (lib/canvasList, D75). The
 *  same array while no canvas row changed, so a body edit elsewhere does not
 *  re-render its subscribers. */
let lastCanvases: CanvasMeta[] = [];
const canvasesOf = memoLast((nodes: ContentNode[]) => {
  const next = canvasList(nodes);
  if (next.length === lastCanvases.length && next.every((row, i) => row === lastCanvases[i])) return lastCanvases;
  lastCanvases = next;
  return next;
});

/** Visible workspace rows, including tagged notes and existing tag/canvas
 * navigation. A tag adds capabilities; it does not move a note out of this list. */
/** The tag catalog by id (memoized): isSystemNode's lookup. */
export function selectTagsById(s: AppState) {
  return tagsByIdOf(s.data.tags);
}

export function selectOverviewNodes(s: AppState): ContentNode[] {
  return overviewNodesOf(s.data.nodes, s.data.tags);
}

// "Today" for dates and the agenda is the workspace's day (lib/localDate).
setWorkspaceTimeZoneSource(() => workspaceZoneOf(getAppState().data));
setWorkspaceDayStartSource(() => getAppState().data.workspace?.day_start_hour ?? 0);

/** Every note search may return: the tree's notes plus hidden ones, never system rows. */
export function selectSearchableNodes(s: AppState): ContentNode[] {
  return searchableNodesOf(s.data.nodes, s.data.tags);
}

/** Every canvas, most recently updated first (one store: the canvas nodes). */
export function selectCanvases(s: AppState): CanvasMeta[] {
  return canvasesOf(s.data.nodes);
}

/** The focused node, or null. */
export function selectSelectedNode(s: AppState): ContentNode | null {
  return selectedNodeOf(s.data.nodes, s.selectedId);
}

/** The note the list/editor shows: only the explicitly selected one. With
 * nothing open there is no selection (no first-note fallback — it highlighted
 * and scrolled the list to a note the user never opened). */
export function selectOverviewSelectedNode(s: AppState): ContentNode | null {
  return selectSelectedNode(s);
}
