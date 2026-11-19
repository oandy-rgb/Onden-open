// Back is "the page I was on before" (hooks/useUrlLocation.ts, its table at the top), driven by random
// sequences of the moves a person makes, in a desktop and a phone layout.
//
// Real: useUrlSync / navigate / pushEntry / popstate handling, useUiMode, useWorkspaceFocus (openNote,
// followLink and the link trail, selectTab), useHistoryEntry (a full-screen sheet), the side-by-side
// store (lib/splitViewStore), makeNodeActions().delete (the selection rule of "delete the open note"),
// the app store, the window's history (happy-dom). Wired the way components/BuilderWorkspace.tsx wires
// them. A page reload is a fresh module registry over the same history, so the module-level state of
// useUrlLocation (depth, trail serial, bottom-bar stacks) starts over as it does in a browser.
//
// Also real: usePhoneInfoScreen (the Info screen's history entry and its ‹, closeInfo) and useDismiss (the one
// Esc/Back stack of menus and panels, with the browser's close request faked by test/fakeCloseWatcher.ts).
//
// Not driven: the components (NotesWorkspace's usePhoneBack only chooses between closeInfo, the link trail's goBack
// and goBackInApp, which are driven directly), useSplitView (the drop/menu entry points: the store is called
// directly), the bottom bar's tab stacks, the palette.
//
// Model: a stack of screens with a pointer, like the browser's own. A screen is what the person sees:
// the place, the note, its saved-view tab, the right-hand pane, the phone's Info screen, a sheet.
// Each move is, by the table in useUrlLocation.ts:
//   open a note (list, search result, sidebar)  a new page, unless it is the note already open
//   follow a link                               a new page (one entry), unless it is the note already open
//   switch the note's tab, open/close the       the same page changed: no entry
//     right-hand pane
//   open the phone's Info screen, open a sheet  a new page (useHistoryEntry)
//   open a menu or panel                        no page; Esc or Back closes it and nothing else
//   delete the open note                        an automatic move: the page is replaced by the neighbour
//                                               (the list on a phone), no entry
//   Back / Forward / the on-screen ‹            one step along the stack
//
// Invariants, after every command:
//   shown      what is on screen is the model's current screen (place, note, Info, sheet; tab and pane
//              too after a Back, Forward or reload: those are restored from the entry)
//   depth      the history entry the app is on is the model's pointer: Back never skips two screens,
//              never leaves an extra entry behind, and a move that is no page adds none
//   no push    Back and Forward call pushState zero times
//   one step   Esc or Back with a menu open closes the menu only: the page, the history entry and the
//              screen stay; the next press goes back one page. Back never leaves the app (the first
//              entry) while a menu, an Info screen or a sheet is open: that press closes it.
//   leavable   the shown screen's note exists (a screen of a missing note is a loading pane for good)
//   reload     the same page is shown after a reload on the current address
//   agree      the on-screen ‹ ends where the system Back would
//
// Known defects (the named cases at the bottom are `it.fails`; the property steers around their
// triggers, PROPS_INCLUDE_KNOWN=1 turns the steering off):
//   see the cases for the others the property found.
//
// Replay:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run src/test/properties/backNavigation
//          (fast-check prints the seed, path and the shrunk command list; PROPS_TRACE=1 adds the history log.)

import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { act, renderHook, type RenderHookResult } from "@testing-library/react";
import { useEffect, useState } from "react";
import { INCLUDE_KNOWN_CASES, PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";
import { installFakeCloseWatcher, liveWatchers, requestClose } from "../fakeCloseWatcher";

// The data layer is a long import chain (sync engine, local database) that the location hooks only touch for
// one background call; a reload re-imports the registry, so it is cut here.
vi.mock("../../lib/data", () => ({ runBackgroundWrite: (work: Promise<unknown>) => { void work.catch(() => {}); }, canvasWriter: {} }));

const RUNS = process.env.PROPS_RUNS ? PROPS_RUNS : Math.min(PROPS_RUNS, 80);

// ── the app under test ───────────────────────────────────────────────────────

type Mods = {
  url: typeof import("../../hooks/useUrlLocation");
  uiMode: typeof import("../../hooks/useUiMode");
  focus: typeof import("../../hooks/useWorkspaceFocus");
  historyEntry: typeof import("../../hooks/useHistoryEntry");
  phoneInfo: typeof import("../../hooks/usePhoneInfoScreen");
  dismiss: typeof import("../../hooks/useEscapeKey");
  store: typeof import("../../lib/appStore");
  split: typeof import("../../lib/splitViewStore");
  nodeActions: typeof import("../../lib/data/nodeActions");
  childOrder: typeof import("../../lib/childOrder");
  scroll: typeof import("../../lib/pageScrollRestore");
  api: typeof import("../../lib/api");
};

async function loadMods(): Promise<Mods> {
  vi.resetModules();
  const mods = {
    url: await import("../../hooks/useUrlLocation"),
    uiMode: await import("../../hooks/useUiMode"),
    focus: await import("../../hooks/useWorkspaceFocus"),
    historyEntry: await import("../../hooks/useHistoryEntry"),
    phoneInfo: await import("../../hooks/usePhoneInfoScreen"),
    dismiss: await import("../../hooks/useEscapeKey"),
    store: await import("../../lib/appStore"),
    split: await import("../../lib/splitViewStore"),
    nodeActions: await import("../../lib/data/nodeActions"),
    childOrder: await import("../../lib/childOrder"),
    scroll: await import("../../lib/pageScrollRestore"),
    api: await import("../../lib/api"),
  };
  (await import("../../lib/accountStorage")).bindAccountStorage("back-navigation-property", "");
  return mods;
}

const POOL = ["n1", "n2", "n3", "n4"] as const;
const TABS = ["content", "v1", "v2"] as const;
const MARKER = "ondenTestSheet";

type NodeRow = { id: string; sort_order: number };
const row = (n: NodeRow) => ({ id: n.id, title: n.id, node_type: "content", parent_id: null, hidden: false, markdown: "", source_type: "manual", slug: n.id, sort_order: n.sort_order, created_at: "2026-11-14T00:00:00Z" });

/** BuilderWorkspace's wiring of the location hooks, plus a sheet that uses useHistoryEntry. */
function makeShell(m: Mods, phone: boolean, initial: ReturnType<Mods["url"]["readLocation"]>) {
  return function useShell() {
    const ui = m.uiMode.useUiMode(initial.view, initial.lens, initial.viewTab ?? null);
    const focus = m.focus.useWorkspaceFocus({
      ui, initialLocation: initial,
      boards: { selectCanvas: (async () => {}) as never, createCanvas: (async () => null) as never },
      canvasImported: false, setCanvasNavStack: () => {},
    });
    const stored = m.split.useSplit();
    const right = phone ? null : stored.right; // useSplitView: a phone shows none, and keeps the stored one for later
    // BuilderWorkspace: the phone's Info screen is one history entry, and Back onto another note leaves it.
    const info = m.phoneInfo.usePhoneInfoScreen({ phone, tab: ui.overviewMobileTab, selectedId: focus.selectedId, setTab: ui.setOverviewMobileTab, setSelectedId: m.store.setSelectedId });
    m.url.useUrlSync(ui.mode, focus.selectedId, ui.notesView, ui.setMode, info.setNoteFromHistory, ui.setNotesView, ui.viewTab, ui.setViewTab, focus.followBrowserStep, right, phone);
    // useLandingNote: a deep link to a note drills into it on a phone.
    useEffect(() => { if (initial.nodeId) ui.setOverviewMobileTab("edit"); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- mount only, as there
    const [sheetOpen, setSheetOpen] = useState(false);
    const sheet = m.historyEntry.useHistoryEntry(sheetOpen, () => setSheetOpen(false), MARKER, () => setSheetOpen(true));
    // A menu or panel over the page: no history entry, Esc and Back close it through the one shared stack (hooks/useEscapeKey.ts useDismiss).
    const [menuOpen, setMenuOpen] = useState(false);
    m.dismiss.useDismiss(() => { setMenuOpen(false); }, menuOpen);
    return { ui, focus, right, sheetOpen, setSheetOpen, sheet, info, menuOpen, setMenuOpen };
  };
}

// ── screens and the model ────────────────────────────────────────────────────

type Screen = { view: string; node: string | null; tab: string | null; right: string | null; info: boolean; sheet: boolean };
const show = (s: Screen) => `${s.view}:${s.node ?? "list"}${s.tab ? `#${s.tab}` : ""}${s.right ? ` | ${s.right}` : ""}${s.info ? " [info]" : ""}${s.sheet ? " [sheet]" : ""}`;
const sameScreen = (a: Screen, b: Screen) => show(a) === show(b);
/** What a reload can bring back: the address holds the place, note, tab and pane; Info and a sheet are state of the page. */
const pageOf = (s: Screen): Screen => ({ ...s, info: false, sheet: false });

type Run = {
  phone: boolean;
  includeKnown: boolean;
  m: Mods;
  hook: RenderHookResult<ReturnType<ReturnType<typeof makeShell>>, unknown>;
  nodes: NodeRow[];
  entries: Screen[];
  index: number;
  problems: string[];
  /** The tab each note was last given by an explicit choice (a reload of an address with no tab shows it). */
  remembered: Map<string, string>;
  log: string[];
  pushes: number;
  /** The page is being torn down for a reload: a real page that closes runs no cleanup, so the history ignores what the old tree's cleanups ask. */
  dying: boolean;
  restore: Array<() => void>;
};

const depthOf = (): number => (window.history.state as { ondenDepth?: number } | null)?.ondenDepth ?? 0;
const shell = (run: Run) => run.hook.result.current;
const selectedNote = (run: Run): string | null => run.m.store.getAppState().selectedId;
const noteExists = (run: Run, id: string | null) => id === null || run.nodes.some((n) => n.id === id);

function observe(run: Run): Screen {
  const s = shell(run);
  const node = selectedNote(run);
  const right = s.right ? `${s.right.kind}:${"id" in s.right ? s.right.id : s.right.mode}:${"tab" in s.right ? s.right.tab : ""}` : null;
  return {
    view: s.ui.mode,
    node,
    tab: s.ui.viewTab,
    right,
    info: run.phone && node !== null && s.ui.overviewMobileTab === "info",
    sheet: s.sheetOpen,
  };
}
const top = (run: Run): Screen => run.entries[run.index]!;

async function mount(run: Run): Promise<void> {
  run.m = await loadMods();
  const { store, url, split, api } = run.m;
  store.resetAppState({ online: true, bootstrapped: true, data: { ...api.noWorkspaceData, nodes: run.nodes.map(row) as never, tags: [] } });
  const initial = url.readLocation({ view: "notes", nodeId: null, lens: "editor" });
  store.setSelectedId(initial.nodeId);
  split.applyUrlRight(url.readRightFromUrl(), true);
  run.hook = renderHook(makeShell(run.m, run.phone, initial));
  await act(async () => {});
}

/** The window's session history, as a browser keeps it: happy-dom's own `replaceState` drops the entries ahead of
 *  the current one (the spec keeps them, so Forward after a replace still works), so the list is kept here and
 *  happy-dom only holds the current address and state. Traversals are synchronous and dispatch `popstate`.
 *  Also counts the pushes, so that a Back that pushes is seen. */
function installSession(run: Run): void {
  const h = window.history;
  const original = { push: h.pushState.bind(h), replace: h.replaceState.bind(h), back: h.back.bind(h), forward: h.forward.bind(h), go: h.go.bind(h) };
  const here = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const stack: Array<{ url: string; state: unknown }> = [{ url: here(), state: h.state }];
  let at = 0;
  h.pushState = ((state: unknown, _title: string, url?: string | URL | null) => {
    run.pushes += 1; run.log.push(`push ${String(url)} ${JSON.stringify(state)}`);
    original.push(state, "", url ?? here());
    stack.length = at + 1;
    stack.push({ url: here(), state });
    at += 1;
  }) as typeof h.pushState;
  h.replaceState = ((state: unknown, _title: string, url?: string | URL | null) => {
    run.log.push(`replace ${String(url)} ${JSON.stringify(state)}`);
    original.replace(state, "", url ?? here());
    stack[at] = { url: here(), state };
  }) as typeof h.replaceState;
  const traverse = (to: number) => {
    if (run.dying || to < 0 || to >= stack.length || to === at) return;
    at = to;
    original.replace(stack[to]!.state, "", stack[to]!.url);
    window.dispatchEvent(new PopStateEvent("popstate", { state: stack[to]!.state }));
  };
  h.back = () => traverse(at - 1);
  h.forward = () => traverse(at + 1);
  h.go = (delta = 0) => traverse(at + delta);
  run.restore.push(() => { h.pushState = original.push as never; h.replaceState = original.replace as never; h.back = original.back; h.forward = original.forward; h.go = original.go; });
}

function stubLayout(phone: boolean, run: { restore: Array<() => void> }): void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: phone && query === "(max-width: 900px)", media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  run.restore.push(() => { window.matchMedia = original; });
}

async function newRun(phone: boolean, includeKnown: boolean): Promise<Run> {
  localStorage.clear(); sessionStorage.clear();
  window.history.replaceState(null, "", "/?view=notes&lens=editor");
  const run = { phone, includeKnown, nodes: POOL.map((id, i) => ({ id, sort_order: i + 1 })), entries: [], index: 0, problems: [], remembered: new Map<string, string>(), log: [], pushes: 0, dying: false, restore: [] } as unknown as Run;
  stubLayout(phone, run);
  installFakeCloseWatcher();
  installSession(run);
  await mount(run);
  run.entries = [observe(run)];
  run.index = 0;
  return run;
}

// ── checks ───────────────────────────────────────────────────────────────────

function problem(run: Run, name: string, message: string): void {
  run.problems.push(`${name}: ${message}\n  model: ${run.entries.map((e, i) => `${i === run.index ? "→" : " "}${show(e)}`).join("  ")}\n  now:   ${show(observe(run))}, entry depth ${depthOf()}`);
}

/** After a move that is a page, a change of the page, or nothing: `expected` is the model's screen (place, note, Info, sheet). */
function checkAfterMove(run: Run, name: string, expected: Pick<Screen, "view" | "node" | "info" | "sheet">): void {
  const now = observe(run);
  if (now.view !== expected.view || now.node !== expected.node || now.info !== expected.info || now.sheet !== expected.sheet) {
    problem(run, name, `expected ${show({ ...now, ...expected })} on screen`);
  }
  if (depthOf() !== run.index) problem(run, name, `expected the app to be on history entry ${run.index}, it is on ${depthOf()}`);
  run.entries[run.index] = now; // tab, pane and the like are the move's result: the entry holds them from now on
}

function checkLeavable(run: Run, name: string): void {
  const node = selectedNote(run);
  if (!noteExists(run, node)) problem(run, name, `the screen is note ${node}, which no longer exists: a loading pane nothing ends`);
}

function pushScreen(run: Run, next: Screen): void {
  run.entries.length = run.index + 1;
  run.entries.push(next);
  run.index += 1;
}

// ── commands ─────────────────────────────────────────────────────────────────

type Cmd = fc.AsyncCommand<object, Run>;
function cmd<A extends unknown[]>(name: (...a: A) => string, exec: (run: Run, ...a: A) => Promise<void> | void) {
  return (...args: A): Cmd => ({
    check: () => true,
    async run(_m, run) { run.log.push(`> ${name(...args)}`); await exec(run, ...args); },
    toString: () => name(...args),
  });
}
/** The i-th note that still exists (a removed note is not offered by the list, a search or a link). */
const pick = (run: Run, i: number): string => run.nodes[i % run.nodes.length]!.id;
const free = (run: Run) => !shell(run).sheetOpen; // a sheet covers the page: only its own moves apply

/** Open a note as a new page, or as nothing when it is the page already open. */
function openedNote(run: Run, name: string, id: string): void {
  const before = top(run);
  const same = before.view === "notes" && before.node === id && !before.info;
  if (!same) pushScreen(run, { ...before, view: "notes", node: id, info: false, sheet: false });
  checkAfterMove(run, name, { view: "notes", node: id, info: false, sheet: false });
}

const OpenNote = cmd((i: number) => `open note #${i} from the list`, async (run, i) => {
  if (!free(run)) return;
  const id = pick(run, i);
  const before0 = selectedNote(run);
  await act(async () => { shell(run).focus.openNote(id); });
  if (selectedNote(run) === id && before0 === id) run.remembered.delete(id);
  openedNote(run, `open ${id}`, id);
});
const FollowLink = cmd((i: number) => `follow a link to note #${i}`, async (run, i) => {
  if (!free(run) || selectedNote(run) === null) return;
  const id = pick(run, i);
  await act(async () => { shell(run).focus.followLink(id); });
  run.remembered.delete(id);
  openedNote(run, `follow a link to ${id}`, id);
});
const OpenSearchResult = cmd((i: number) => `open search result #${i}`, async (run, i) => {
  if (!free(run)) return;
  // KNOWN (palette-bypasses-openNote, scan 17 item 8): the palette selects with the store's setSelectedId, so the Info screen stays open over another note.
  if (!run.includeKnown && observe(run).info) return;
  const id = pick(run, i);
  // The palette opens a note this way (useCommandPalette runPaletteItem): the selection, the place, the lens.
  await act(async () => { run.m.store.setSelectedId(id); shell(run).ui.setMode("notes"); shell(run).ui.setNotesView("editor"); });
  const before = top(run);
  if (!(before.view === "notes" && before.node === id)) pushScreen(run, { ...before, view: "notes", node: id, info: observe(run).info, sheet: false });
  checkAfterMove(run, `open search result ${id}`, { view: "notes", node: id, info: observe(run).info, sheet: false });
});
const OpenSplit = cmd((i: number) => `open note #${i} on the right`, async (run, i) => {
  if (run.phone || !free(run) || shell(run).ui.mode !== "notes") return; // a phone has no second side
  const id = pick(run, i);
  if (selectedNote(run) === id) return; // the same text on both sides closes the right (useSplitView)
  await act(async () => { run.m.split.setRight({ kind: "note", id, tab: "content" }); });
  const before = top(run);
  checkAfterMove(run, `open ${id} on the right`, { view: before.view, node: before.node, info: false, sheet: false });
});
const CloseSplit = cmd(() => "close the right side", async (run) => {
  if (run.phone || !free(run)) return;
  await act(async () => { run.m.split.requestSplitClose(); });
  const before = top(run);
  checkAfterMove(run, "close the right side", { view: before.view, node: before.node, info: false, sheet: false });
});
const SwitchTab = cmd((k: number) => `switch to tab ${TABS[k]}`, async (run, k) => {
  if (!free(run) || selectedNote(run) === null || shell(run).ui.mode !== "notes" || observe(run).info) return;
  const id = selectedNote(run)!;
  await act(async () => { shell(run).focus.selectTab(TABS[k]!); });
  if (TABS[k] === "content") run.remembered.delete(id); else run.remembered.set(id, TABS[k]!);
  const before = top(run);
  checkAfterMove(run, `switch to tab ${TABS[k]}`, { view: before.view, node: before.node, info: false, sheet: false });
});
const OpenInfo = cmd(() => "open the phone's Info screen", async (run) => {
  if (!run.phone || !free(run) || selectedNote(run) === null || observe(run).info) return;
  await act(async () => { shell(run).ui.setOverviewMobileTab("info"); });
  pushScreen(run, { ...top(run), info: true });
  checkAfterMove(run, "open the Info screen", { view: top(run).view, node: top(run).node, info: true, sheet: false });
});
const OpenSheet = cmd(() => "open a full-screen sheet", async (run) => {
  if (!free(run)) return;
  await act(async () => { shell(run).setSheetOpen(true); });
  pushScreen(run, { ...top(run), sheet: true });
  checkAfterMove(run, "open a sheet", { view: top(run).view, node: top(run).node, info: top(run).info, sheet: true });
});
const DeleteOpen = cmd(() => "delete the open note", async (run) => {
  const id = selectedNote(run);
  if (!free(run) || id === null || shell(run).ui.mode !== "notes" || observe(run).info || run.nodes.length <= 1) return;
  const nodes = run.m.store.getAppState().data.nodes;
  const neighbour = run.phone ? null : run.m.childOrder.neighborAfterDelete(nodes, id);
  // KNOWN (split-pane-names-a-removed-note): useSplitView closes a right pane whose note is gone; this shell does not run it, so an entry's pane may name the note.
  if (!run.includeKnown && run.entries.some((e, at) => at !== run.index && e.right?.includes(`:${id}:`))) return;
  const actions = run.m.nodeActions.makeNodeActions(
    { get data() { return run.m.store.getAppState().data; } },
    {
      deleteNode: async (gone: string) => { run.m.store.setData((d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== gone) })); return true; },
      duplicateNode: async () => {}, promoteNode: async () => {}, renameNode: async () => true, assignToGroup: async () => {},
    } as never,
    {
      get selectedId() { return run.m.store.getAppState().selectedId; },
      clear: () => run.m.store.setSelectedId(null),
      select: (next: string) => run.m.store.setSelectedId(next),
      listIsSeparateScreen: run.phone,
    },
  );
  await act(async () => { await actions.delete(id); });
  run.nodes = run.nodes.filter((n) => n.id !== id);
  // An automatic move: the open page is replaced, it is not a new page.
  const before = top(run);
  run.entries[run.index] = { ...before, node: neighbour, tab: null, info: false };
  checkAfterMove(run, `delete ${id}`, { view: before.view, node: neighbour, info: false, sheet: false });
});
const RemovedBySync = cmd((i: number) => `note #${i} is removed by a sync`, async (run, i) => {
  if (run.nodes.length <= 1) return;
  const id = pick(run, i);
  // KNOWN (split-pane-names-a-removed-note): as above.
  const named = run.entries.some((e) => e.right?.includes(`:${id}:`)) || selectedNote(run) === id;
  if (!run.includeKnown && named) return;
  run.nodes = run.nodes.filter((n) => n.id !== id);
  await act(async () => { run.m.store.setData((d) => ({ ...d, nodes: d.nodes.filter((n) => n.id !== id) })); });
  checkAfterMove(run, `${id} removed by a sync`, { ...observe(run) });
});

/** An entry whose note is gone shows the list in its place: no note, so no tab and no Info screen. */
function livingScreen(run: Run, entry: Screen): Screen {
  return noteExists(run, entry.node) ? entry : { ...entry, node: null, tab: null, info: false };
}
/** Where Back goes: the page before, passing the entries whose note is gone (the first entry has nothing behind it and stays). */
function backTarget(run: Run): number {
  let target = run.index - 1;
  while (target > 0 && !noteExists(run, run.entries[target]!.node)) target -= 1;
  return target;
}
/** One step along the stack, however it was asked for: the model's pointer moves, and the screen must be the entry's. */
function steppedTo(run: Run, name: string, target: number, pushesBefore: number): void {
  if (run.pushes !== pushesBefore) problem(run, name, `${run.pushes - pushesBefore} entr${run.pushes - pushesBefore === 1 ? "y was" : "ies were"} pushed while going ${target < run.index ? "back" : "forward"}`);
  const expected = livingScreen(run, run.entries[target]!);
  run.index = target;
  const now = observe(run);
  if (!sameScreen(now, expected)) problem(run, name, `expected ${show(expected)} on screen`);
  if (depthOf() !== target) problem(run, name, `expected the app to be on history entry ${target}, it is on ${depthOf()}`);
  checkLeavable(run, name);
  run.entries[run.index] = now;
}
/** Esc or Back (Android's button) while a menu is open: the browser's close request goes to the newest surface. No history step. */
async function closeNewestSurface(run: Run, name: string): Promise<void> {
  const pushes = run.pushes;
  const before = observe(run);
  const depth = depthOf();
  const watchers = liveWatchers().length;
  await act(async () => { requestClose(); });
  if (shell(run).menuOpen) problem(run, name, "the menu is still open after the close request");
  if (liveWatchers().length !== watchers - 1) problem(run, name, "the close request closed more or less than one surface");
  if (run.pushes !== pushes || depthOf() !== depth) problem(run, name, "closing a menu moved the history");
  if (!sameScreen(observe(run), before)) problem(run, name, `closing a menu changed the page: expected ${show(before)}`);
}
const OpenMenu = cmd(() => "open a menu", async (run) => {
  if (shell(run).menuOpen) return;
  await act(async () => { shell(run).setMenuOpen(true); });
  if (liveWatchers().length !== 1) problem(run, "open a menu", "an open menu is not on the Esc/Back stack");
});
const Escape = cmd(() => "Esc", async (run) => {
  if (!shell(run).menuOpen) return; // nothing open: Esc is no navigation
  await closeNewestSurface(run, "Esc");
});
const Back = cmd(() => "browser Back", async (run) => {
  if (shell(run).menuOpen) return closeNewestSurface(run, "Back");
  if (run.index === 0) return; // the first entry: Back would leave the app
  const pushes = run.pushes;
  await act(async () => { window.history.back(); });
  steppedTo(run, "Back", backTarget(run), pushes);
});
const Forward = cmd(() => "browser Forward", async (run) => {
  if (run.index >= run.entries.length - 1) return;
  const pushes = run.pushes;
  await act(async () => { window.history.forward(); });
  steppedTo(run, "Forward", run.index + 1, pushes);
});
/** The sheet's own close button, and the phone's ‹ (NotesWorkspace usePhoneBack: Info → closeInfo, else the link trail, else the previous page). */
const OnScreenBack = cmd(() => "the on-screen back button", async (run) => {
  const s = shell(run);
  if (s.menuOpen) return closeNewestSurface(run, "the on-screen back button");
  if (run.index === 0) return;
  const pushes = run.pushes;
  const info = observe(run).info;
  if (s.sheetOpen) {
    await act(async () => { s.sheet.leave(); s.setSheetOpen(false); });
  } else if (run.phone && info) {
    await act(async () => { s.info.closeInfo(); });
  } else if (s.focus.canGoBack) {
    await act(async () => { s.focus.goBack(); });
  } else if (run.phone) {
    await act(async () => { run.m.url.goBackInApp(() => {}); });
  } else {
    return; // a desktop window has no ‹ of its own besides the link trail's
  }
  steppedTo(run, "the on-screen back button", backTarget(run), pushes);
});
const Reload = cmd(() => "reload", async (run) => {
  const before = pageOf(observe(run));
  const depth = depthOf();
  vi.useFakeTimers();
  run.dying = true;
  run.hook.unmount();
  vi.runOnlyPendingTimers(); // the deferred cleanups of the old tree (useHistoryEntry's) run against a history that ignores them
  run.dying = false;
  vi.useRealTimers();
  await mount(run);
  const now = observe(run);
  if (!sameScreen(now, before)) problem(run, "reload", `expected ${show(before)} after the reload`);
  if (depthOf() !== depth) problem(run, "reload", `the reload moved from history entry ${depth} to ${depthOf()}`);
  checkLeavable(run, "reload");
  // Info and a sheet were state of the page: the entry stays, the page under it is what shows.
  run.entries[run.index] = now;
});

const weighted = (entries: Array<{ weight: number; arbitrary: fc.Arbitrary<Cmd> }>): Array<fc.Arbitrary<Cmd>> =>
  entries.flatMap(({ weight, arbitrary }) => Array<fc.Arbitrary<Cmd>>(weight).fill(arbitrary));
const poolIndex = fc.nat(POOL.length - 1);
const commandArbs = weighted([
  { weight: 6, arbitrary: poolIndex.map((i) => OpenNote(i)) },
  { weight: 3, arbitrary: poolIndex.map((i) => FollowLink(i)) },
  { weight: 3, arbitrary: poolIndex.map((i) => OpenSearchResult(i)) },
  { weight: 2, arbitrary: poolIndex.map((i) => OpenSplit(i)) },
  { weight: 1, arbitrary: fc.constant(CloseSplit()) },
  { weight: 3, arbitrary: fc.nat(TABS.length - 1).map((k) => SwitchTab(k)) },
  { weight: 2, arbitrary: fc.constant(OpenInfo()) },
  { weight: 2, arbitrary: fc.constant(OpenSheet()) },
  { weight: 2, arbitrary: fc.constant(DeleteOpen()) },
  { weight: 1, arbitrary: poolIndex.map((i) => RemovedBySync(i)) },
  { weight: 2, arbitrary: fc.constant(OpenMenu()) },
  { weight: 2, arbitrary: fc.constant(Escape()) },
  { weight: 7, arbitrary: fc.constant(Back()) },
  { weight: 4, arbitrary: fc.constant(Forward()) },
  { weight: 3, arbitrary: fc.constant(OnScreenBack()) },
  { weight: 2, arbitrary: fc.constant(Reload()) },
]);

// ── running ──────────────────────────────────────────────────────────────────

/** The page of a finished run is gone: its hook must not keep answering the next run's popstate. */
function closePage(run: Run): void {
  run.dying = true;
  vi.useFakeTimers();
  run.hook.unmount();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  for (const undo of run.restore.splice(0)) undo();
  vi.unstubAllGlobals();
  vi.resetModules();
}

async function runCommands(phone: boolean, commands: Iterable<Cmd>, includeKnown = INCLUDE_KNOWN_CASES): Promise<string[]> {
  const run = await newRun(phone, includeKnown);
  try {
    await fc.asyncModelRun(() => ({ model: {}, real: run }), commands as never);
    return run.problems.length && process.env.PROPS_TRACE ? [...run.problems, ...run.log] : run.problems;
  } finally {
    closePage(run);
  }
}
const execute = async (phone: boolean, commands: Iterable<Cmd>) => { expect(await runCommands(phone, commands)).toEqual([]); };

describe("Back is the page before, in a desktop and a phone layout", () => {
  for (const phone of [false, true]) {
    it(`${phone ? "phone" : "desktop"}: any sequence of moves keeps the stack, Back, Forward, reload and the on-screen back in step`, async () => {
      await fc.assert(
        fc.asyncProperty(fc.commands(commandArbs, { maxCommands: 30, size: "max" }), (commands) => execute(phone, commands)),
        { seed: PROPS_SEED, numRuns: RUNS, verbose: 0 },
      );
    }, Number(process.env.PROPS_TIMEOUT ?? 300_000));
  }
});

// ── minimal reproductions of what the property found ────────────────────────
// Each is a command list the shrinker ended on, replayed with the steering off (found at seed 20261023; the default seed is fresh every run;
// `PROPS_SEED=20261023 PROPS_RUNS=<n> PROPS_INCLUDE_KNOWN=1` finds the same families). `it.fails`: when the fix lands
// vitest reports "expected to fail", and the case is flipped to `it`.

describe("what the property found (expected to fail until fixed)", () => {
  // Controls: the harness sees a correct Back, Forward, sheet and trail.
  it.each([false, true])("control (phone: %s): Back from an opened note shows the list, Forward returns, a sheet closes with Back and with its own button", async (phone) => {
    expect(await runCommands(phone, [OpenNote(0), Back(), Forward(), OpenSheet(), Back(), OpenSheet(), OnScreenBack(), Back()], true)).toEqual([]);
  });
  it("control: a followed link is one entry, Back returns to the note it came from, Forward goes on", async () => {
    expect(await runCommands(false, [OpenNote(0), FollowLink(1), Back(), Forward(), OnScreenBack(), Back()], true)).toEqual([]);
  });

  // Back never lands on a page whose note is gone: it passes that entry (the first entry, with nothing behind it, shows the list instead).
  // Found at 97 runs (phone), seed 20261023: n3, n1, n3 opened one after the other; the open n3 is deleted; Back, Back.
  it("back-lands-on-a-removed-note: Back passes the page of a note that was deleted", async () => {
    expect(await runCommands(true, [OpenNote(2), OpenNote(0), OpenNote(2), DeleteOpen(), Back(), Back()], true)).toEqual([]);
  });
  // The same, for a note a sync removed (no delete from this device).
  it("back-lands-on-a-removed-note: Back passes the page of a note that a sync removed", async () => {
    expect(await runCommands(false, [OpenNote(0), OpenNote(1), RemovedBySync(0), Back()], true)).toEqual([]);
  });
  // Forward cannot tell where the entries end, so it shows the list in the dead entry's place.
  it("back-lands-on-a-removed-note: Forward onto the page of a removed note shows the list", async () => {
    expect(await runCommands(false, [OpenNote(0), OpenNote(1), Back(), RemovedBySync(1), Forward()], true)).toEqual([]);
  });

  // Desktop. Open a note, delete it (the neighbour takes the focus): an automatic move (table in useUrlLocation.ts: "delete → neighbour"),
  // so the page is replaced and Back shows the list. The rule lives in nodeActions.delete (it states the replace intent), so a
  // wiring with a plain setSelectedId gets it too.
  it("delete-open-note-pushes: deleting the open note on a desktop replaces the page, and Back shows the list", async () => {
    expect(await runCommands(false, [OpenNote(0), DeleteOpen(), Back()], true)).toEqual([]);
  });

  // Phone. Scenario: open a note, its Info screen, follow a link from there (the Info screen lists links), Back.
  // Expected: Back shows the note's Info screen again, one step. Actual: openNote (hooks/useWorkspaceFocus.ts:247, which followLink calls, line 270) sets the tab to "edit" but
  // the Info entry (usePhoneInfoScreen → useHistoryEntry, still `pushed`) stays in the history, so Back lands on it and shows the note's content: a press
  // whose page is the same as the one under it (the next Back changes nothing visible again).
  it("info-entry-orphaned: following a link from the phone's Info screen leaves an entry that shows the note's content", async () => {
    expect(await runCommands(true, [OpenNote(0), OpenInfo(), FollowLink(1), Back()], true)).toEqual([]);
  });

  // Phone: the Info screen is one history entry (hooks/usePhoneInfoScreen.ts). Back and the ‹ both return to the note's content, one step.
  it("control: Back and the ‹ from the phone's Info screen return to the note, and Esc/Back close a menu before any page", async () => {
    expect(await runCommands(true, [OpenNote(0), OpenInfo(), Back(), OpenInfo(), OnScreenBack(), OpenMenu(), Back(), Back()], true)).toEqual([]);
    expect(await runCommands(false, [OpenNote(0), OpenMenu(), Escape(), OpenMenu(), Back(), OpenSheet(), OpenMenu(), Escape(), Back(), Back()], true)).toEqual([]);
  });

  // seed 20261023, found at 42 runs (desktop), shrunk 8 times. Scenario: open a note, follow a link, put a note on the right, Back.
  // Expected: Back shows the note the link was followed from.
  // Actual: the trail step restores the note but returns before showSearch (hooks/useUrlLocation.ts onPop: `if (!landedOnDefault && step && trailPop.current(step)) { ...; return; }`),
  // so the pane (`right=`) of the entry arrived at is not applied; the stale pane is written by useUrlSync's effect as a PUSH (viewChanged/nodeChanged).
  it("split-change-then-trail-back-pushes: Back after changing the side-by-side pane pushes an entry instead of going back", async () => {
    expect(await runCommands(false, [OpenSearchResult(1), FollowLink(0), OpenSplit(1), Back()], true)).toEqual([]);
  });

  // seed 8 at 500 runs (phone), shrunk to this. Scenario: follow two links, Back, delete the open note (the page is replaced by the list), Forward, ‹.
  // Expected: ‹ ends where Back would (the list entry). Actual: the link trail keeps the places it took before the delete, so the ‹ steps the trail
  // (stepTrailInHistory / restorePlace) onto a page that no longer matches the entry, and the screen is not the one the model's stack names.
  it("delete-during-a-trail-leaves-the-trail: deleting the open note in the middle of a link trail leaves ‹ and Back disagreeing", async () => {
    expect(await runCommands(true, [OpenSearchResult(0), FollowLink(1), FollowLink(0), Back(), DeleteOpen(), Forward(), OnScreenBack()], true)).toEqual([]);
  });

  // A link to the note that is already open is nothing: no entry for a page that shows the same address.
  it("self-link-pushes: following a link to the note already open adds no entry", async () => {
    expect(await runCommands(false, [OpenNote(0), FollowLink(0), Back()], true)).toEqual([]);
  });

  // Scenario: open a sheet, reload (the sheet is gone, its history entry stays), open a sheet again, Back.
  // Expected: Back closes the sheet and shows the page. Actual: Back reaches the first sheet's entry, whose marker useHistoryEntry takes for the
  // new sheet's own (`overlayEntryShown(marker)`), so the sheet stays open on a page the person already left.
  it("reload-leaves-a-stale-sheet-entry: Back after reopening a sheet that was open at a reload shows a sheet again", async () => {
    expect(await runCommands(false, [OpenSheet(), Reload(), OpenSheet(), Back()], true)).toEqual([]);
  });

  // Scenario: n1, n2, then n1 again; on this third page choose tab v1; Back, Back.
  // Expected: the first n1 page as it was shown (content). Actual: arriving on a note applies the tab remembered now (hooks/useWorkspaceFocus.ts, the
  // selectedId effect: `remembered = tabOf(selectedId)` → showTab), over the tab the entry's address holds, so Back shows tab v1 on the earlier page.
  it("tab-memory-overrides-the-entry: Back to an earlier page of a note shows the tab chosen later", async () => {
    expect(await runCommands(false, [OpenNote(0), OpenNote(1), OpenNote(0), SwitchTab(1), Back(), Back()], true)).toEqual([]);
  });

  // Scenario: open a sheet (useHistoryEntry), Back, Forward. Expected: Forward returns to the sheet. Actual: Forward reaches the entry the sheet pushed,
  // but nothing opens the sheet again (the entry's `onBack` already closed it): the page shows, on an entry that Back passes through to the same page.
  it("forward-onto-a-closed-sheet: Forward after Back from a sheet does not bring the sheet back", async () => {
    expect(await runCommands(false, [OpenSheet(), Back(), Forward()], true)).toEqual([]);
  });

  // Scenario: open a note, choose its tab v1 (remembered), open the same note from the list again (it shows its content), reload.
  // Expected: the same screen (the content). Actual: openNote for the note already open resets the tab for this visit without forgetting the remembered one
  // (hooks/useWorkspaceFocus.ts openNote: `tabByNode.current[id] = key` but no rememberTab), so the reload applies tab v1 again.
  it("reopen-resets-tab-for-this-visit: a reload after reopening the open note shows another tab", async () => {
    expect(await runCommands(false, [OpenNote(0), SwitchTab(1), OpenNote(0), Reload()], true)).toEqual([]);
  });

  // Scenario: n1, n2, n1 again; on the third page choose tab v1 (remembered for n1); Back, Back (the first n1 page, on 「內容」), reload.
  // Expected: 「內容」, the tab the entry showed (its history state says so). A page opened fresh, with no state, still shows the remembered tab.
  it("tabless-address-shows-the-remembered-tab: a reload shows the tab the entry showed, not the remembered one", async () => {
    expect(await runCommands(false, [OpenNote(0), OpenNote(1), OpenNote(0), SwitchTab(1), Back(), Back(), Reload()], true)).toEqual([]);
  });
  it("tabless-address-shows-the-remembered-tab: Back and Forward show each entry's own tab, and a reload on them keeps it", async () => {
    expect(await runCommands(true, [OpenNote(0), SwitchTab(1), OpenNote(1), Back(), Reload(), Forward(), Reload(), Back()], true)).toEqual([]);
  });
});

// The two situations the random property leaves out unless PROPS_INCLUDE_KNOWN=1 (`OpenSearchResult` while the Info screen is open;
// a note removed by a sync while it is open or named by an entry's right pane). Each is pinned open here: when its fix lands vitest reports
// "expected to fail", the case is flipped to `it`, and the matching exclusion in the commands above is deleted.
describe("known defects still open", () => {
  // KNOWN palette-bypasses-openNote: found at PROPS_INCLUDE_KNOWN=1 PROPS_SEED=11, shrunk to the palette choosing a note over the open Info screen.
  it.fails("palette-bypasses-openNote: choosing a search result while the Info screen is open leaves the Info screen over the other note", async () => {
    expect(await runCommands(true, [OpenNote(0), OpenInfo(), OpenSearchResult(1), Back(), Forward(), Reload()], true)).toEqual([]);
  });

  // KNOWN split-pane-names-a-removed-note (the `RemovedBySync` exclusion: the removed note is the open one or one an entry's pane names):
  // found at PROPS_INCLUDE_KNOWN=1 PROPS_SEED=22, shrunk to opening a note, a sync removing it, a reload, Back.
  it.fails("split-pane-names-a-removed-note: a sync that removes the open note, then a reload and Back, leaves the history out of step", async () => {
    expect(await runCommands(false, [OpenNote(2), RemovedBySync(2), Reload(), Back()], true)).toEqual([]);
  });
});
