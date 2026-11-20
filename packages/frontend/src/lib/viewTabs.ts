import { CONTENT_LAYOUT } from "@onden/markdown/contract";
import { getPrefJson, PREFS, setPrefJson } from "./prefs";
import type { SavedView } from "./ownerViews";
import { isWhiteboardLayout, opensOnWhiteboardView, whiteboardTabIn } from "./whiteboardNote";

// The row of tabs above a note or a tag: 「內容」 first, then the ways of seeing
// it — the whiteboard, table, calendar, board, cards — then 「＋」.
//
// A tab is one of three things, named by a key:
//   "content"  the page itself (the note's text, the tag's description and notes)
//   "canvas"   the whiteboard
//   <view id>  a saved view of the owner's sub-notes (or the tag's notes)
// The whiteboard is kept as a saved view of layout "canvas" so that its name,
// its place among the tabs and its removal are stored with the others. It has
// no rows to run: its cards live on the board, keyed by the page's own id
// (the whiteboard is a view of a note, not a kind of note: migration 138). A
// note that already has cards on its board shows the tab without any stored
// record until its tab is renamed, moved or hidden. A note whose tab says it
// opens first (`layout_config.opens_first`; every board that existed before
// 138) opens on the whiteboard until the person chooses another tab.
//
// 「內容」 has two shapes, and a note is in exactly one of them:
//   · no record (every note made before the tab could be hidden): the built-in
//     tab, always first, never moved or renamed, as it has always been; it can
//     only be removed, which gives the note a record that says it is hidden;
//   · a record (a saved view of layout "content"): the tab is placed by its
//     `pin_order` like the others, and `layout_config.hidden` hides it. The text
//     is the note's body either way, so search, publishing and export do not
//     look at the tab. Added back from 「＋」 it goes last.

export const CONTENT_TAB = "content";
export const CANVAS_TAB = "canvas";

export type ViewTab = {
  key: string;
  kind: "content" | "canvas" | "view";
  name: string;
  /** The record behind a view tab or a stored whiteboard tab; null for 「內容」
   *  and for a whiteboard that has no record yet. */
  view: SavedView | null;
  /** Inherited from a parent tag: shown, but changed only on that tag. */
  inheritedName: string | null;
  /** Rename, move and delete are offered (the owner may change views). */
  editable: boolean;
  /** 「Remove tab」 is offered (only 「內容」 sets it: it hides the tab and keeps the text). */
  hideable: boolean;
  /** The whiteboard tab the page opens on until another tab is chosen (its record says so, or the note is still of the retired board kind). */
  opensFirst?: boolean;
};

/** The saved view that places or hides the note's 「內容」 tab, if it has one. */
export const contentTabIn = <V extends { layout?: string }>(views: readonly (V | null | undefined)[] | null | undefined): V | null =>
  (views ?? []).find((view): view is V => view?.layout === CONTENT_LAYOUT) ?? null;

/** The tab keeps its place at the front and has no menu of moves: the built-in 「內容」 with no record. */
export const isFixedFirstTab = (tab: Pick<ViewTab, "kind" | "view">): boolean => tab.kind === "content" && !tab.view;

/** A record of the whiteboard or of 「內容」 only keeps that the tab is gone; the board and the text are kept. */
export const isTabHidden = (view: SavedView) => view.layout_config?.hidden === true;

type TabsInput = {
  views: readonly SavedView[];
  /** 「白板」 is turned on in Settings › Modules. */
  canvasImported: boolean;
  /** The owner already has cards on its board (or is of the retired kind
   *  'canvas'): its tab shows before anything is stored. */
  earnsWhiteboard: boolean;
  /** The person may change this owner's views. */
  canManage: boolean;
  /** A tag's first tab (its list) cannot be removed; a note's 「內容」 can, by one who may change the note. Default: a note. */
  ownerKind?: "tag" | "node";
  /** The server says another tab shows, so 「內容」 may be removed (the list's `content_tab_removable`); not worked out here. */
  contentRemovable?: boolean;
  /** The note is still of the retired board kind: its whiteboard, with no record yet, is what it opens on. */
  retiredBoard?: boolean;
  /** The tab the page is on: a page opened on its whiteboard keeps that tab while it is open. */
  activeKey?: string;
  /** The translated names of 「內容」 and 「白板」. */
  contentName: string;
  whiteboardName: string;
  /** Layouts whose tab does not show on this page: a note view of a module that
   *  is off (its views are kept), or any note view on a tag's page. */
  hiddenLayouts?: ReadonlySet<string>;
};

/** The tabs in order: 「內容」 (first when it has no record, else where its record puts it), then the stored views by
 *  `pin_order` and name (the order the server lists them in; the one place the client orders them, so whoever asks
 *  gets the same answer), with a whiteboard that has no record first among them. */
export function buildViewTabs(input: TabsInput): ViewTab[] {
  const { canvasImported, canManage } = input;
  const views = [...input.views].sort((a, b) => (a.pin_order || 0) - (b.pin_order || 0) || String(a.name ?? "").localeCompare(String(b.name ?? "")));
  const contentRecord = contentTabIn(views);
  const showsContent = !contentRecord || !isTabHidden(contentRecord);
  const tabs: ViewTab[] = [];
  const contentTab = (): ViewTab => contentRecord
    ? { key: CONTENT_TAB, kind: "content", name: input.contentName, view: contentRecord, inheritedName: null, editable: canManage, hideable: false }
    : { key: CONTENT_TAB, kind: "content", name: input.contentName, view: null, inheritedName: null, editable: false, hideable: false };
  if (!contentRecord) tabs.push(contentTab());
  const stored = whiteboardTabIn(views);
  const showsWhiteboard = canvasImported && (stored ? !isTabHidden(stored) : input.earnsWhiteboard || input.activeKey === CANVAS_TAB);
  if (showsWhiteboard && !stored) {
    tabs.push({ key: CANVAS_TAB, kind: "canvas", name: input.whiteboardName, view: null, inheritedName: null, editable: canManage, hideable: false, opensFirst: !!input.retiredBoard });
  }
  for (const view of views) {
    if (input.hiddenLayouts?.has(view.layout)) continue;
    if (view.layout === CONTENT_LAYOUT) {
      if (view === contentRecord && showsContent) tabs.push(contentTab());
      continue;
    }
    if (isWhiteboardLayout(view)) {
      if (view !== stored || !showsWhiteboard) continue;
      // A record made by the server's own conversion is named in English; show it in the person's language.
      tabs.push({ key: CANVAS_TAB, kind: "canvas", name: view.name === "Canvas" ? input.whiteboardName : view.name, view, inheritedName: null, editable: canManage, hideable: false, opensFirst: opensOnWhiteboardView(view) });
      continue;
    }
    tabs.push({
      key: view.id, kind: "view", name: view.name, view,
      inheritedName: view.inherited_from ? view.inherited_name ?? "" : null,
      editable: canManage && !view.inherited_from, hideable: false,
    });
  }
  // A page always shows at least one tab. The server keeps 「內容」 showing when the note has no other view record
  // (services/functionRefs keepContentTabShowing); this is for a record that is there but not drawn here (its module is off):
  // 「內容」 shows, worked out each time, and is hidden again when the module comes back.
  if (tabs.length === 0) tabs.push(contentTab());
  if (input.ownerKind !== "tag" && canManage && input.contentRemovable && tabs.length > 1) {
    // The server's answer says a tab shows; this page must draw one too (a record whose module is off draws none here).
    const content = tabs.find((tab) => tab.kind === "content");
    if (content) content.hideable = true;
  }
  return tabs;
}

/** The tab a page opens on when none was chosen or the one remembered is gone: the whiteboard that opens first, else the
 *  built-in 「內容」 when it is there (as it always was), else the first tab showing. The one rule: the page, the tab row and
 *  the side-by-side pane all ask this, with tabs from buildViewTabs. */
export function defaultTabKey(tabs: readonly ViewTab[]): string {
  const opensFirst = tabs.find((tab) => tab.opensFirst);
  if (opensFirst) return opensFirst.key;
  return tabs.some(isFixedFirstTab) ? CONTENT_TAB : tabs[0]?.key ?? CONTENT_TAB;
}

/** The tab the page is on, from where the location says it is. */
export function activeTabKey({ lens, viewTab }: { lens: string; viewTab: string | null }): string {
  if (viewTab) return viewTab;
  return lens === "canvas" ? CANVAS_TAB : CONTENT_TAB;
}

/** The location of a tab: which lens and which saved view. */
export function locationOfTab(key: string): { lens: "editor" | "canvas"; viewTab: string | null } {
  if (key === CONTENT_TAB) return { lens: "editor", viewTab: null };
  if (key === CANVAS_TAB) return { lens: "canvas", viewTab: null };
  return { lens: "editor", viewTab: key };
}

/** A name for a new view that none of `taken` has. */
export function freeViewName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
}

/** What an automatic view name is made of: the kind's title and, when there is
 *  one, what sets the view apart (「表格 · 未完成」). */
export type ViewNameParts = { title: string; qualifier: string | null };

export const autoViewName = ({ title, qualifier }: ViewNameParts) => (qualifier ? `${title} · ${qualifier}` : title);

/** The name a view gets when its kind or what sets it apart changes from
 *  `before` to `after`: an automatic name (the name `before` makes, the bare
 *  title, either with a number after) follows the change; a name the person
 *  typed stays (null). `otherNames` are the owner's other views, so the new
 *  name is a free one. */
export function nameAfterViewChange(name: string, before: ViewNameParts, after: ViewNameParts, otherNames: readonly string[]): string | null {
  const automatic = [autoViewName(before), before.title].some((base) =>
    name === base || (name.startsWith(`${base} `) && /^\d+$/.test(name.slice(base.length + 1))));
  if (!automatic) return null;
  const next = freeViewName(autoViewName(after), otherNames);
  return next === name ? null : next;
}

/** `pin_order` for every tab but the built-in 「內容」 after `key` is dropped at `index` among
 *  them: all get their new place, so a tie never decides the order. Only the
 *  tabs whose stored place changes (or that are not stored yet) are returned. */
export function reorderTabs(tabs: readonly ViewTab[], key: string, index: number): Array<{ tab: ViewTab; pinOrder: number }> {
  const movable = tabs.filter((tab) => !isFixedFirstTab(tab));
  const from = movable.findIndex((tab) => tab.key === key);
  if (from < 0) return [];
  const next = movable.slice();
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(index, next.length)), 0, moved!);
  return next.flatMap((tab, place) => (tab.view && tab.view.pin_order === place ? [] : [{ tab, pinOrder: place }]));
}

/** Tab keys by note, on this account: the tab each note was last left on. */
function rememberedTabs(): Record<string, string> {
  const stored = getPrefJson(PREFS.noteViewTabs);
  return stored && typeof stored === "object" ? stored as Record<string, string> : {};
}

export function rememberedTab(ownerId: string): string | null {
  const key = rememberedTabs()[ownerId];
  return typeof key === "string" ? key : null;
}

/** `defaultKey` is the tab the page opens on when nothing is remembered:
 *  choosing it again forgets the choice. A page that opens on its whiteboard
 *  remembers 「內容」 like any other tab. */
export function rememberTab(ownerId: string, key: string, defaultKey: string = CONTENT_TAB): void {
  const tabs = rememberedTabs();
  if (key === defaultKey) delete tabs[ownerId];
  else if (tabs[ownerId] === key) return;
  else tabs[ownerId] = key;
  setPrefJson(PREFS.noteViewTabs, tabs);
}
