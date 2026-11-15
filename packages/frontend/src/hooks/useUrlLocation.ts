// URL-backed top-level location for BuilderApp (surface S2a/A).
//
// The app is an Astro `client:only` React island with no router, so the
// location — which place + which focused node + which per-node lens — lived
// only in React state and was lost on reload / unshareable / not back-able.
//
// Kept in the URL's SEARCH params (`?view=&node=&lens=`) via the History API.
// Because the island never server-renders, we read window.location synchronously
// (no hydration mismatch). No URL-hash channels remain (the old TagsMode
// `#tag-view=<id>` handoff is now a lifted BuilderApp prop).
//
//   view  — the place: "notes" (the node home) | tasks | website | timeline
//           | graph | tags (the capability overview). "timeline" is no longer a
//           lens-strip Place (the per-node History lens covers it), but stays a
//           valid view so `?view=timeline` deep links + the mobile nav slot keep
//           resolving to the merged TimelineLens (see BuilderApp secondaryLens).
//   node  — the focused node id
//   lens  — the per-node lens within the node home: editor | canvas | timeline
//           (History) | table (surface A). Persisted so a reload keeps the chosen
//           lens (a hard requirement from the per-node-lens UX research — losing
//           it destroyed trust elsewhere).
//   tab   — in the editor lens, the saved view the page's tab row is on (a view
//           id); absent = 「內容」. The whiteboard tab is lens=canvas.
//
// Navigation semantics — Back is "the page I was on before":
// a page is a place the user feels they went to; each gets one history entry.
//
//   | action                                                        | history |
//   | ------------------------------------------------------------- | ------- |
//   | switch place (view)                                           | push    |
//   | open another note, from any entry (sidebar, list, search,     | push    |
//   |   palette, relations, day notes, tasks, inbox) or a tag page  |         |
//   | follow a link (link trail, openTrailEntry)                    | push    |
//   | open a detail screen from a list (useHistoryEntry: a reader   | push    |
//   |   article, a phone settings level)                            |         |
//   | a new note opened right after creating it                     | push    |
//   | switch tab / lens inside one note (content, whiteboard, view) | replace |
//   | filter, sort, scroll, expand, side panels                     | replace |
//   | previous / next article inside an open detail screen          | replace |
//   | card selection on a whiteboard, selection cleared             | replace |
//   | automatic moves (boot canonicalization, landing note, delete  | replace |
//   |   → neighbour, reload) — `navigate(go, { history: "replace" })`|         |
//   | the same address again                                        | nothing |
//
// `navigate(go, { history })` is the one place a caller states the intent when the
// default (above) is wrong. Nothing else calls history.pushState / replaceState
// (lib/pageUrl only strips one-shot query parameters, never adds an entry).
//
// The default screen: on a phone, when the app was entered with no in-app page
// behind it (cold start, share, notification) the first entry is the notes list
// (the bottom bar's first slot) and the page entered goes on top of it, so Back
// goes page → list → out of the app. Desktop adds no such entry: the browser's
// own previous page is already behind it. `canGoBackInApp` / `goBackInApp` give
// the phone's ‹ the same answer as the Back key.
//
// The phone's bottom bar is a set of stacks (Android) with 「tap again = its top」 (iOS):
//   • the notes list is a page of its own (`?view=notes` with no `node`), so Back and Forward
//     land on the list or on a note and always agree with what is shown;
//   • each tab remembers where it was left (`lastLocationOf`); tapping it from another tab
//     returns there, tapping it while on it goes to its top (`reopenDestination`);
//   • inside a tab, Back is the previous page. Only a page that a tap on a bottom tab made (marked
//     TAB_STATE) is a new stack: Back from it goes to the default screen, the notes list, and from
//     there out of the app, the same rule as the default screen above (the first entry). A note opened
//     from the tasks page, a day or the graph belongs to that page's stack: Back returns to it.
//
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { AppMode, CoreMode } from "./useUiMode";
import { isModuleScreen, isReadingSection } from "../modules";
import type { NodeLens } from "../lib/nodeLens";
import { markBackNavigation } from "../lib/pageScrollRestore";
import { markHistoryArrival, navigate, takeHistoryIntent, type HistoryIntent } from "../lib/historyIntent";
import { isNoteGone } from "../lib/appStore";
import { PREFS, setPref } from "../lib/prefs";
import { activeTabKey, locationOfTab } from "../lib/viewTabs";
import type { PaneTarget } from "../lib/splitView";
import { applyUrlRight, rightSearch } from "../lib/splitViewStore";
import { getModuleAddress, setModuleAddress, useModuleAddress } from "../lib/moduleAddress";

export type AppView = AppMode;

// ── The link trail's history entries ─────────────────────────────────────
// useWorkspaceFocus owns the trail (which notes a link was followed from);
// this file owns the browser history. Each trail step has one history entry,
// marked in its state: `openTrailEntry` adds it just before a link is
// followed (a copy of the current location, which the state → URL sync below
// then rewrites to the note arrived at), so Back from there lands on the note
// the link was followed from.
//
// The mark is a serial that grows with each trail entry, so a popstate can tell
// from the entries alone which way it went (arrived below the entry it left =
// Back, above = Forward) instead of guessing from the note it landed on; an
// unrelated popstate (the settings dialog's own history.back()) leaves the
// serial where it was and is no trail step.
//
// A Back from a bottom tab's page jumps to the default screen over the entries in between (toDefault below),
// so the trail's steps there are no longer behind the page shown: the owner is told ("left") and drops them.
export type TrailPopStep = "back" | "forward" | "left";
const TRAIL_STATE = "ondenTrail";
let trailSerial = 0;
// The serial of the entry the app is on (0 = not a trail entry).
let trailHere = 0;
// A trail entry was just opened by a link follow and the location has not been
// written to it yet: a view change in that same follow rewrites it instead of
// pushing a second entry, so one follow = one history step.
let trailFresh = false;
// The entry ahead of this one belongs to the trail (set after stepping back
// through it), so 「下一頁」 may use the browser's Forward.
let trailAhead = false;
// How deep the entry the app is on is (DEPTH_STATE below), to tell Back from Forward in a popstate.
let hereDepth = 0;
// ...and whether that entry is one a bottom-tab tap made.
let hereTab = false;
// A bottom tab was just tapped: the next push is the start of its stack. Lapses like a navigate intent.
let pendingTab = false;
// Back from a tab's first page was sent to the default screen; its popstate is on the way.
let toDefault = false;
let tabTimer: ReturnType<typeof setTimeout> | undefined;
// Trail entries are made and used only while useUrlSync listens for the popstate.
let urlSyncs = 0;

// ── Every history entry carries how deep it is inside the app ────────────
// 0 = the first entry (the default screen); each push adds one. A reload keeps the
// entry's state, so "was this session already seeded" survives it.
const DEPTH_STATE = "ondenDepth";
// Marks every overlay entry (pushOverlayEntry): a detail screen that tapping its own tab again closes.
const OVERLAY_STATE = "ondenOverlay";
// The markers of every overlay that is open on an entry, oldest first.
const OVERLAYS_STATE = "ondenOverlays";
function overlaysOf(state: unknown): string[] {
  const list = (state as Record<string, unknown> | null)?.[OVERLAYS_STATE];
  return Array.isArray(list) ? list.filter((m): m is string => typeof m === "string") : [];
}
// Marks the entry a tap on a bottom tab made (the start of that tab's stack).
const TAB_STATE = "ondenTab";
// The tab ("content", "canvas" or a view id) the entry's note page showed. An address has no way to say 「內容」, so without this
// a reload would show the tab remembered for the note instead of the one this entry was showing. An entry without it (a pasted
// link, a new window) keeps the rule of a link without a tab: the remembered tab.
const SHOWN_TAB_STATE = "ondenShownTab";

function shownTabOf(state: unknown): string | null {
  const tab = (state as Record<string, unknown> | null)?.[SHOWN_TAB_STATE];
  return typeof tab === "string" && tab.length > 0 ? tab : null;
}

function depthOf(state: unknown): number | null {
  const d = (state as Record<string, unknown> | null)?.[DEPTH_STATE];
  return typeof d === "number" ? d : null;
}

/** The only pushState of the app: a new page on top of this one. */
function pushEntry(url: string, extra: Record<string, unknown> = {}): void {
  const state = window.history.state as Record<string, unknown> | null;
  const trail = state?.[TRAIL_STATE];
  const shown = shownTabOf(state);
  hereDepth = (depthOf(state) ?? 0) + 1;
  hereTab = TAB_STATE in extra;
  window.history.pushState({
    ...(typeof trail === "number" ? { [TRAIL_STATE]: trail } : {}),
    // The same address in a new entry (an overlay, a link follow) shows the same tab until the next location write says otherwise.
    ...(shown !== null ? { [SHOWN_TAB_STATE]: shown } : {}),
    ...extra,
    [DEPTH_STATE]: hereDepth,
  }, "", url);
}

/** A new page at the same address: what the page shows changes without its address changing (the note already open, shown
 *  from the phone's Info screen), so Back returns to what was there before. */
export function pushPageEntry(): void {
  pushEntry(window.location.href);
}

/** There is an in-app page behind this one (so ‹ / Back stays in the app). */
export function canGoBackInApp(): boolean {
  return (depthOf(window.history.state) ?? 0) > 0;
}

/** The phone's ‹: the previous page when there is one, else `toDefault` (go to the default screen in place). */
export function goBackInApp(toDefault: () => void): void {
  return canGoBackInApp() ? window.history.back() : toDefault();
}

// ── Stating the history intent ────────────────────────────────────────────
// The state → URL sync below decides push or replace from what changed; a caller
// whose move is automatic (or, for a landing, deliberate) says so here. The intent
// is for the next location write only, and lapses on its own if none follows.
export { navigate, type HistoryIntent };

/** Push or replace for one location write (the table at the top of this file). */
export function historyKindFor(c: {
  /** A link follow just opened this write's entry (openTrailEntry). */
  fresh: boolean;
  intent: HistoryIntent | null;
  viewChanged: boolean;
  nodeChanged: boolean;
  /** The note now shown (false = selection cleared). */
  hasNode: boolean;
}): HistoryIntent {
  if (c.fresh) return "replace";
  if (c.intent) return c.intent;
  if (c.viewChanged) return "push";
  if (c.nodeChanged && c.hasNode) return "push";
  return "replace";
}

/** Listen for the browser's Back / Forward (the one popstate listener outside useUrlSync); returns the stop. */
export const onHistoryPop = (listener: () => void): (() => void) => {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
};

/** Push a history entry for a full-screen overlay (same address, `marker` in its state) so the phone's
 *  Back gesture closes the overlay instead of leaving the page. Pair it with `popOverlayEntry`. */
export function pushOverlayEntry(marker: string): void {
  // An overlay opened over another one (a sheet over the phone's Info screen) keeps that one: both are still open on its entry.
  const open = overlaysOf(window.history.state).filter((m) => m !== marker);
  pushEntry(window.location.href, { [marker]: 2, [OVERLAY_STATE]: true, [OVERLAYS_STATE]: [...open, marker] });
}

/** The overlay made with `marker` belongs to the entry that is shown (alone, or under one opened over it). */
export const overlayEntryShown = (marker: string): boolean =>
  marker in (window.history.state ?? {}) || overlaysOf(window.history.state).includes(marker);

/** A page that was reloaded keeps its history entry, whose overlay (a sheet, the phone's Info screen) did not survive: take
 *  the marker off the entry that is shown, so Back from a screen opened later does not mistake it for its own. */
export function dropStaleOverlayMarker(marker: string): void {
  if (!overlayEntryShown(marker)) return;
  const { [marker]: _gone, [OVERLAY_STATE]: _overlay, [OVERLAYS_STATE]: _open, ...rest } = window.history.state as Record<string, unknown>;
  const stillOpen = overlaysOf(window.history.state).filter((m) => m !== marker);
  window.history.replaceState(stillOpen.length > 0 ? { ...rest, [OVERLAY_STATE]: true, [OVERLAYS_STATE]: stillOpen } : rest, "", window.location.href);
}

/** Take the overlay's entry back off the history (the overlay closed by itself, not through Back). */
export function popOverlayEntry(): void {
  window.history.back();
}

/** Open the history entry of a link follow; call before the location changes. */
export function openTrailEntry(): void {
  if (typeof window === "undefined" || urlSyncs === 0) return;
  trailSerial = Math.max(trailSerial, trailHere) + 1;
  trailHere = trailSerial;
  pushEntry(window.location.href, { [TRAIL_STATE]: trailHere });
  trailAhead = false;
  trailFresh = true;
}

function serialOf(state: unknown): number {
  const mark = (state as Record<string, unknown> | null)?.[TRAIL_STATE];
  return typeof mark === "number" ? mark : 0;
}

/** Which trail step a popstate to `arrived` is, judged by the entries alone. */
function trailDirection(arrived: unknown): "back" | "forward" | null {
  const to = serialOf(arrived);
  if (trailHere > to) return "back";
  if (to > trailHere) return "forward";
  return null;
}

/** Take a trail step through the browser history when its entry is there; the
 *  popstate then reaches `onTrailPop` (useUrlSync). False = no entry: the
 *  caller steps the trail in state alone. */
export function stepTrailInHistory(direction: "back" | "forward"): boolean {
  if (typeof window === "undefined" || urlSyncs === 0) return false;
  if (direction === "back") {
    if (serialOf(window.history.state) === 0) return false;
    window.history.back();
    return true;
  }
  if (!trailAhead) return false;
  window.history.forward();
  return true;
}

// ── The phone's bottom-bar tabs ───────────────────────────────────────────
// A tab (a nav destination) is the page `view` belongs to; the reading hub is one tab over
// its sections. A tab's top is its view with nothing opened inside it (for 筆記: the list).
let stacksOn = false; // a phone is listening (useUrlSync); a desktop has no bottom bar
let applyLocation: ((search: string) => void) | null = null;
const lastLocations = new Map<string, string>();

/** A phone's bottom bar is in use (its tabs are stacks). */
export const phoneStacks = (): boolean => stacksOn;

/** How the app's own first move (the launch setting's note) enters the history: on a phone it goes above the
 *  default screen (the notes list stays the bottom); elsewhere it takes the first entry's place. */
export const landingHistory = (resume: boolean): HistoryIntent => (resume || stacksOn ? "push" : "replace");

/** Whether a tab is at its top: a destination declares it (CorePage.top); the default is "always". */
export type TabTop = (loc: AppLocation, graphFocus: string | null) => boolean;

/** The tab (nav destination id) a view belongs to. */
export function destinationOfView(view: string): string {
  return isReadingSection(view) ? "reading" : view;
}

/** Test seam: forget where the tabs were left. */
export const forgetLastLocations = (): void => lastLocations.clear();

/** A bottom-bar tab was tapped (phone only). `current` = it is the tab on screen: go to its top (close the
 *  detail screen, or what `atTop` says is opened inside it); else return to where it was left. False = nothing to
 *  do here (no remembered place, or already there): the caller opens the tab as it always did, and the page
 *  that makes is still the start of the tab's stack. */
export function reopenDestination(destination: string, current: boolean, atTop?: TabTop): boolean {
  if (!stacksOn || !applyLocation) return false;
  pendingTab = true;
  clearTimeout(tabTimer);
  tabTimer = setTimeout(() => { pendingTab = false; }, 500);
  const here = parseLocation(window.location.search, { view: "notes", nodeId: null, lens: "editor" });
  let target: string | undefined;
  if (current) {
    pendingTab = false;
    if (overlayEntryShown(OVERLAY_STATE)) { window.history.back(); return true; } // the detail screen's own entry
    if (atTop?.(here, getGraphFocus()) ?? true) return true;
    target = locationToSearch({ view: here.view, nodeId: null, lens: "editor" });
  } else {
    target = lastLocations.get(destination);
    if (!target || target === locationToSearch(here, getGraphFocus())) return false;
  }
  const apply = applyLocation;
  navigate(() => apply(target), { history: "push" });
  return true;
}

const CORE_VIEWS: readonly CoreMode[] = ["notes", "today", "tasks", "timeline", "graph"];
// Valid URL lens ids. editor/canvas are live strip tabs (canvas is gated
// per-node, but its lens id is always a valid deep link).
// local-graph left NODE_LENSES — its this-note half lives in the inspector and
// the everything-graph is a Place — and `timeline` is no lens any more (a
// note's history is its time slider), so both deep links are aliased to editor
// in parseLocation below. Validate against the full union.
const LENSES: readonly NodeLens[] = ["editor", "canvas", "local-graph"];

function isView(v: string | null): v is AppView {
  return v != null && ((CORE_VIEWS as readonly string[]).includes(v) || isModuleScreen(v));
}
function isLens(v: string | null): v is NodeLens {
  return v != null && (LENSES as readonly string[]).includes(v);
}

export interface AppLocation {
  view: AppView;
  nodeId: string | null;
  lens: NodeLens;
  /** The open saved-view tab (a view id), in the editor lens; null/absent = 「內容」. */
  viewTab?: string | null;
  /** `lens` and `viewTab` come from the history entry's own record of the tab it showed, not from an address that cannot say 「內容」
   *  (readLocation): the note opens on it, not on the remembered tab. */
  tabShownByEntry?: boolean;
}

/** Parse a `?view=&node=&lens=` search string into a location, falling back per-field. */
export function parseLocation(search: string, fallback: AppLocation): AppLocation {
  const p = new URLSearchParams(search);
  const view = p.get("view");
  const node = p.get("node");
  const lens = p.get("lens");
  const tab = p.get("tab");
  const parsedLens: NodeLens = lens === "local-graph" || lens === "table" || lens === "timeline" ? "editor" : isLens(lens) ? lens : fallback.lens;
  return {
    // "tags" is no view (the sidebar lists tags): an old ?view=tags link
    // falls back like any unknown view.
    // "timeline" is no longer a lens-strip Place but remains a valid view, so
    // `?view=timeline` deep links keep resolving (the merged TimelineLens at
    // all-scope) rather than 404-ing back to the fallback.
    view: isView(view) ? view : fallback.view,
    nodeId: node && node.length > 0 ? node : null,
    // canvas is a live lens again (gated per-node, but always a valid deep
    // link). Only local-graph is aliased to editor — its this-note half moved
    // to the inspector and the everything-graph is a Place. Old links land on
    // the editor of the same node. So do old ?lens=table links: the table
    // lens became the children section of the note's page (its view tabs).
    lens: parsedLens,
    // A saved view's tab is the editor lens showing that view.
    ...(tab && tab.length > 0 && parsedLens === "editor" ? { viewTab: tab } : {}),
  };
}

/** Serialize a location to a canonical `?view=…[&node=…][&lens=…]` search string.
 *  lens is only carried in the node home ("notes") — places have no per-node lens. */
export function locationToSearch(loc: AppLocation, focusId: string | null = null, moduleAddress: string | null = null): string {
  const p = new URLSearchParams();
  p.set("view", loc.view);
  if (loc.nodeId) p.set("node", loc.nodeId);
  if (loc.view === "notes") p.set("lens", loc.lens);
  if (loc.view === "notes" && loc.lens === "editor" && loc.viewTab) p.set("tab", loc.viewTab);
  // The graph page can centre on one note (`focus`, the graph focus below).
  if (loc.view === "graph" && focusId) p.set("focus", focusId);
  // A module page's own place (lib/moduleAddress): the review page's group.
  if (moduleAddress && isModuleScreen(loc.view)) p.set("m", moduleAddress);
  return `?${p.toString()}`;
}

/** The `right=` value of the address (the side-by-side pane, lib/splitViewStore), or null. */
export function readRightFromUrl(): string | null {
  return typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("right");
}

/** The full address of a note, for a link that leaves the app (an excerpt's source). */
export function noteAddress(id: string): string {
  return `${window.location.origin}/${locationToSearch({ view: "notes", nodeId: id, lens: "editor" })}`;
}

/** Read the current location from `window.location` (client-only). */
export function readLocation(fallback: AppLocation): AppLocation {
  if (typeof window === "undefined") return fallback;
  const loc = parseLocation(window.location.search, fallback);
  const shown = shownTabOf(window.history.state);
  if (shown === null || loc.view !== "notes" || loc.nodeId === null) return loc;
  return { ...loc, ...locationOfTab(shown), tabShownByEntry: true };
}

// ── The graph page's focus ───────────────────────────────────────────────
// The note the graph page (`?view=graph&focus=<noteId>`) is centred on, or null
// for the whole workspace. It is not part of AppLocation because only the graph
// page reads it, but its URL is written here and read back on Back/forward by
// useUrlSync's one popstate listener: this file is the only owner of the history.

const focusListeners = new Set<() => void>();

/** The focus in a search string: only the graph view carries one. */
function focusFromSearch(search: string): string | null {
  const p = new URLSearchParams(search);
  const id = p.get("focus");
  return p.get("view") === "graph" && id ? id : null;
}

let graphFocus: string | null = typeof window === "undefined" ? null : focusFromSearch(window.location.search);

export const getGraphFocus = () => graphFocus;

// The module page's own place (lib/moduleAddress) as the app was opened.
if (typeof window !== "undefined") setModuleAddress(new URLSearchParams(window.location.search).get("m"));

/** Set the focus before switching to the graph view; useUrlSync then writes it into the URL. */
export function setGraphFocus(id: string | null): void {
  if (id === graphFocus) return;
  graphFocus = id;
  for (const l of focusListeners) l();
}

/** Re-centre while already on the graph page: a new history entry, so Back returns to the previous centre. */
export function recenterGraph(id: string): void {
  const p = new URLSearchParams(window.location.search);
  p.set("view", "graph");
  p.set("focus", id);
  pushEntry(`?${p.toString()}${window.location.hash}`);
  setGraphFocus(id);
}

export function useGraphFocus(): string | null {
  return useSyncExternalStore(
    (l) => { focusListeners.add(l); return () => { focusListeners.delete(l); }; },
    getGraphFocus,
    () => null,
  );
}

/**
 * Two-way sync between the URL and the existing {mode, selectedId, notesView}
 * state. No init here — callers seed their state from readLocation() (see
 * BuilderApp), so first render already matches the URL and we never clobber it.
 */
export function useUrlSync(
  view: AppView,
  nodeId: string | null,
  lens: NodeLens,
  setView: (v: AppView) => void,
  setNodeId: (id: string | null) => void,
  setLens: (l: NodeLens) => void,
  viewTab: string | null = null,
  setViewTab: (tab: string | null) => void = () => {},
  /** Back / forward crossed a trail entry: true when the link trail took the
   *  step (it restores the note itself, so the state is not set from the URL).
   *  "left" = the history jumped to the default screen past the trail's entries; the answer is ignored. */
  onTrailPop: (step: TrailPopStep) => boolean = () => false,
  /** The side-by-side pane (`right=`, lib/splitViewStore): written after the location, read back on Back/forward. */
  right: PaneTarget | null = null,
  /** A phone: with no in-app page behind the first one, put the default screen (the notes list) under it. */
  seedDefaultScreen = false,
): void {
  const moduleAddress = useModuleAddress();
  const trailPop = useRef(onTrailPop);
  trailPop.current = onTrailPop;
  const lastView = useRef<AppView>(view);
  const lastNode = useRef<string | null>(nodeId);
  const seedRef = useRef(seedDefaultScreen);
  seedRef.current = seedDefaultScreen;

  // Back/forward (and any external history change) → state.
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Show the location a search string names (the popstate below, and a tab tapped: reopenDestination).
    function showSearch(search: string) {
      const loc = parseLocation(search, { view, nodeId, lens, viewTab });
      // The page's note was deleted (or access to it removed) since: its place is the list, not a pane that loads for good.
      const gone = loc.nodeId !== null && isNoteGone(loc.nodeId);
      const shownNode = gone ? null : loc.nodeId;
      if (gone) {
        // The entry itself shows the list from now on (the state → URL write below does not run when the list is already shown).
        const p = new URLSearchParams(search);
        p.delete("node"); p.delete("tab"); p.set("lens", "editor");
        window.history.replaceState(window.history.state, "", `?${p.toString()}${window.location.hash}`);
      }
      setGraphFocus(focusFromSearch(search));
      setModuleAddress(new URLSearchParams(search).get("m"));
      applyUrlRight(readRightFromUrl());
      markHistoryArrival(shownNode);
      setView(loc.view);
      setNodeId(shownNode);
      setLens(gone ? "editor" : loc.lens);
      setViewTab(gone ? null : loc.viewTab ?? null);
    }
    function onPop() {
      const arrivedDepth = depthOf(window.history.state) ?? 0;
      const arrived = parseLocation(window.location.search, { view, nodeId, lens, viewTab });
      // Back onto a page whose note is gone: the page before that one, when there is one (a Forward cannot tell where the
      // entries end, and the first entry has nothing behind it: those show the list in its place, in showSearch).
      // Nothing is changed here, so the next popstate is judged against the entry the app is still on.
      if (arrived.nodeId !== null && isNoteGone(arrived.nodeId) && arrivedDepth > 0 && arrivedDepth < hereDepth) {
        window.history.back();
        return;
      }
      if (arrived.nodeId !== null && isNoteGone(arrived.nodeId)) arrived.nodeId = null;
      // Back from a page a bottom tab made lands in the tab before it; the default screen (the first
      // entry, the notes list) is where a phone goes instead, and from there out of the app.
      if (stacksOn && hereTab && arrivedDepth > 0 && arrivedDepth < hereDepth
        && destinationOfView(arrived.view) !== destinationOfView(lastView.current)) {
        toDefault = true;
        window.history.go(-arrivedDepth);
        return;
      }
      const landedOnDefault = toDefault;
      toDefault = false;
      hereDepth = arrivedDepth;
      hereTab = TAB_STATE in (window.history.state ?? {});
      markBackNavigation();
      const step = trailDirection(window.history.state);
      trailHere = serialOf(window.history.state);
      trailFresh = false;
      if (landedOnDefault) trailPop.current("left");
      if (!landedOnDefault && step && trailPop.current(step)) {
        trailAhead = true; // the entry just left, or the one beyond, is the trail's
        // The trail restores the note and its tab; the side-by-side pane is the entry's own, so it is read from the address
        // here (else the state → URL write below finds the old pane and pushes it as a new page).
        applyUrlRight(readRightFromUrl());
        lastView.current = "notes";
        lastNode.current = arrived.nodeId;
        return;
      }
      trailAhead = false;
      lastView.current = arrived.view;
      lastNode.current = arrived.nodeId;
      showSearch(window.location.search);
    }
    window.addEventListener("popstate", onPop);
    urlSyncs += 1;
    applyLocation = showSearch;
    seedFirstEntry(seedDefaultScreen, view === "notes" && !nodeId && right === null);
    hereDepth = depthOf(window.history.state) ?? 0;
    trailHere = serialOf(window.history.state);
    trailSerial = Math.max(trailSerial, trailHere);
    return () => {
      urlSyncs -= 1;
      window.removeEventListener("popstate", onPop);
      if (urlSyncs === 0) { stacksOn = false; applyLocation = null; }
    };
    // setters are stable; view/nodeId/lens only seed the popstate fallback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A window turned into a desktop (or a phone) mid-session changes what the bottom bar's taps do.
  useEffect(() => { stacksOn = seedDefaultScreen; }, [seedDefaultScreen]);

  // State → URL. Whether a location becomes a new history entry or rewrites the
  // current one is historyKindFor's call (the table at the top of this file).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (view !== "graph") setGraphFocus(null);
    if (!isModuleScreen(view)) setModuleAddress(null);
    const base = locationToSearch({ view, nodeId, lens, viewTab }, getGraphFocus(), isModuleScreen(view) ? getModuleAddress() : null);
    const search = base + rightSearch(right);
    // D5 "where I left off": every location is also the last location. A
    // per-account mirror of the canonical search string — the resume
    // landing parses it with the same parseLocation as a deep link.
    setPref(PREFS.lastLocation, base);
    lastLocations.set(destinationOfView(view), base);
    const fresh = trailFresh;
    trailFresh = false;
    const intent = takeHistoryIntent();
    const tabTap = pendingTab;
    pendingTab = false;
    const kind = historyKindFor({
      fresh, intent,
      viewChanged: view !== lastView.current,
      nodeChanged: nodeId !== lastNode.current,
      hasNode: nodeId !== null,
    });
    lastNode.current = nodeId;
    // The tab this page shows, kept in the entry itself (SHOWN_TAB_STATE); a page that is no note's has none.
    const shownTab = view === "notes" && nodeId !== null ? activeTabKey({ lens, viewTab }) : null;
    const entry = (): Record<string, unknown> => {
      const { [SHOWN_TAB_STATE]: _was, ...rest } = (window.history.state ?? {}) as Record<string, unknown>;
      return shownTab === null ? rest : { ...rest, [SHOWN_TAB_STATE]: shownTab };
    };
    if (search === window.location.search) {
      if (shownTab !== shownTabOf(window.history.state)) window.history.replaceState(entry(), "", window.location.href);
      lastView.current = view;
      return;
    }
    const url = search + window.location.hash;
    if (kind === "push") {
      pushEntry(url, { ...(tabTap ? { [TAB_STATE]: true } : {}), ...(shownTab !== null ? { [SHOWN_TAB_STATE]: shownTab } : {}) });
    } else {
      window.history.replaceState(entry(), "", url); // keeps a trail entry's mark
    }
    trailAhead = false;
    lastView.current = view;
  }, [view, nodeId, lens, viewTab, right, moduleAddress]);
}

/** The first entry of this session of the app. A phone with nothing in-app behind the page it was
 *  entered on gets the default screen (the notes list) as that first entry, the page on top of it. */
function seedFirstEntry(seedDefaultScreen: boolean, onDefault: boolean): void {
  if (depthOf(window.history.state) !== null) return; // reload / restored: already seeded
  const here = window.location.href;
  const keep = window.history.state;
  if (!seedDefaultScreen || onDefault) {
    window.history.replaceState({ ...keep, [DEPTH_STATE]: 0 }, "", here);
    return;
  }
  window.history.replaceState({ [DEPTH_STATE]: 0 }, "", locationToSearch({ view: "notes", nodeId: null, lens: "editor" }));
  window.history.pushState({ ...keep, [DEPTH_STATE]: 1 }, "", here); // the sync below then writes it in canonical form
}
