// Which buttons the editor's two toolbars show, and in what order (Settings ›
// 工具列). Pure rules only; where the choice is kept is lib/toolbarLayoutStore,
// what each button does is components/MarkdownEditor's.
//
//   bar        the phone and tablet formatting bar (no text selected)
//   selection  the bar over selected text (floating on a desktop, in the
//              phone's bar on a touch screen)
//
// A layout of a surface is the ids of the buttons it SHOWS, in order; null is
// the default. Every other button of that surface waits in 「更多」, so turning
// one off never loses it. A button added by a later version is not in a stored
// list and so starts in 「更多」, as a module imported later does in the nav.
//
// Labels: a general format (bold, a heading…) is an icon with a tooltip; an
// Onden action (「變成子筆記」, 「加標籤」, 「複製段落連結」) is an icon with its words.
// A touch bar has room for TOUCH_LABELED_LIMIT of those; further ones wait in
// 「更多」 there, as the nav's phone bar shows only its first few.

import { blockAnchorsEnabled } from "./blockAnchorStore";

export type ToolbarSurface = "bar" | "selection";

export type ToolDef = {
  id: string;
  /** i18n key: the button's name, tooltip and the settings row's. */
  label: string;
  /** An Onden action (icon and words) rather than a general format (icon). */
  onden: boolean;
};

const format = (id: string, label: string): ToolDef => ({ id, label, onden: false });
const onden = (id: string, label: string): ToolDef => ({ id, label, onden: true });

/** With paragraph anchors on, 「變成子筆記」「展開回內文」 are 「獨立出去」「收回原文」: the same paragraph, one identity
 *  (its task, schedule and links stay). The ids and the stored layout do not change, only the words. */
const STANDING_LABELS: Readonly<Record<string, string>> = { toChild: "Stand alone as its own note", expand: "Take back into the text" };
export const toolLabel = (tool: Pick<ToolDef, "id" | "label">): string => (blockAnchorsEnabled() ? STANDING_LABELS[tool.id] : undefined) ?? tool.label;

/** The phone and tablet bar's buttons, in the default order. */
export const BAR_TOOLS: readonly ToolDef[] = [
  onden("tag", "Add tag"),
  onden("copyLink", "Copy block link"),
  format("ai", "AI"),
  onden("toChild", "Turn into a child note"),
  onden("history", "History of this part…"),
  onden("convertTask", "Convert this checkbox into an agenda task"),
  onden("expand", "Expand back into the text"),
  format("wikilink", "Link to a note"),
  format("insertFile", "Insert file"),
  format("h1", "Heading 1"),
  format("h2", "Heading 2"),
  format("bold", "Bold"),
  format("italic", "Italic"),
  format("code", "Inline code"),
  format("bullet", "Bullet list"),
  format("number", "Numbered list"),
  format("task", "Checklist"),
  format("quote", "Quote"),
];

/** The selection bar's buttons, in the default order: the Onden actions first,
 *  because the phone's row scrolls and these are what the bar is for. The last four wait in
 *  「更多」 by default; the last two appear only where they apply (a checkbox
 *  line, a `![[child]]` line). */
export const SELECTION_TOOLS: readonly ToolDef[] = [
  onden("toChild", "Turn into a child note"),
  onden("tag", "Add tag"),
  // Icon only, so the phone's row (which labels only two Onden buttons) keeps it in view.
  format("ai", "AI"),
  format("bold", "Bold"),
  format("italic", "Italic"),
  format("strike", "Strikethrough"),
  format("underline", "Underline"),
  format("highlight", "Highlight"),
  format("code", "Inline code"),
  format("link", "Link"),
  format("quote", "Quote"),
  format("h1", "Heading 1"),
  format("h2", "Heading 2"),
  format("h3", "Heading 3"),
  onden("copyLink", "Copy block link"),
  onden("history", "History of this part…"),
  onden("convertTask", "Convert this checkbox into an agenda task"),
  onden("expand", "Expand back into the text"),
];

/** The buttons that act on a paragraph, in the order every surface lists them (the phone bar,
 *  the selection bar and the desktop handle's menu draw this one list). Labels: the tools' own. */
export const PARAGRAPH_TOOLS = ["tag", "ai", "copyLink", "history", "toChild", "convertTask", "expand"] as const;

/** How many Onden buttons (icon and words) a touch bar shows before the rest wait in 「更多」. */
export const TOUCH_LABELED_LIMIT = 2;

/** The selection bar's buttons that wait in 「更多」 until the person brings them out. */
const SELECTION_IN_MORE: ReadonlySet<string> = new Set(["copyLink", "history", "convertTask", "expand"]);

/** What each surface shows until it is edited. */
const DEFAULT_SHOWN: Record<ToolbarSurface, readonly string[]> = {
  bar: BAR_TOOLS.map((tool) => tool.id),
  selection: SELECTION_TOOLS.filter((tool) => !SELECTION_IN_MORE.has(tool.id)).map((tool) => tool.id),
};

export const toolsOf = (surface: ToolbarSurface): readonly ToolDef[] => (surface === "bar" ? BAR_TOOLS : SELECTION_TOOLS);

export type ToolbarLayout = {
  /** Ids shown in the phone and tablet bar, in order; null: the default. */
  bar: readonly string[] | null;
  /** Ids shown in the selection bar, in order; null: the default. */
  selection: readonly string[] | null;
};

export const DEFAULT_TOOLBAR_LAYOUT: ToolbarLayout = { bar: null, selection: null };

/** The buttons a surface shows and the ones that wait in 「更多」, over the
 *  registry: an unknown or repeated id drops out; everything not shown is in
 *  `more`, in registry order. */
export function resolveToolbar(stored: ToolbarLayout | null, surface: ToolbarSurface): { shown: ToolDef[]; more: ToolDef[] } {
  const tools = toolsOf(surface);
  const byId = new Map(tools.map((tool) => [tool.id, tool]));
  const ids = stored?.[surface] ?? DEFAULT_SHOWN[surface];
  const shown: ToolDef[] = [];
  for (const id of ids) {
    const tool = byId.get(id);
    if (tool && !shown.includes(tool)) shown.push(tool);
  }
  return { shown, more: tools.filter((tool) => !shown.includes(tool)) };
}

/** What a bar draws of `resolveToolbar`'s answer: only the tools that apply
 *  now (`available`), and on a touch screen no more than TOUCH_LABELED_LIMIT
 *  Onden buttons (the rest join 「更多」, which then lists them). */
export function toolbarRows(
  stored: ToolbarLayout | null, surface: ToolbarSurface, available: ReadonlySet<string>, touch: boolean,
): { shown: ToolDef[]; more: ToolDef[] } {
  const { shown, more } = resolveToolbar(stored, surface);
  let labeled = 0;
  const kept: ToolDef[] = [], pushed: ToolDef[] = [];
  for (const tool of shown.filter((candidate) => available.has(candidate.id))) {
    if (touch && tool.onden && ++labeled > TOUCH_LABELED_LIMIT) pushed.push(tool);
    else kept.push(tool);
  }
  return { shown: kept, more: [...pushed, ...more.filter((tool) => available.has(tool.id))] };
}

export function isDefaultToolbar(stored: ToolbarLayout | null, surface: ToolbarSurface): boolean {
  return (stored?.[surface] ?? null) === null;
}

const withSurface = (stored: ToolbarLayout | null, surface: ToolbarSurface, ids: readonly string[] | null): ToolbarLayout | null => {
  const next: ToolbarLayout = { ...(stored ?? DEFAULT_TOOLBAR_LAYOUT), [surface]: ids };
  return next.bar === null && next.selection === null ? null : next;
};

const shownIds = (stored: ToolbarLayout | null, surface: ToolbarSurface) => resolveToolbar(stored, surface).shown.map((tool) => tool.id);

/** Show or hide `id`; a button turned on joins the end. */
export function setToolShown(stored: ToolbarLayout | null, surface: ToolbarSurface, id: string, on: boolean): ToolbarLayout | null {
  if (!toolsOf(surface).some((tool) => tool.id === id)) return stored;
  const ids = shownIds(stored, surface).filter((other) => other !== id);
  return withSurface(stored, surface, on ? [...ids, id] : ids);
}

/** Move a shown button one place up (-1) or down (+1). */
export function moveTool(stored: ToolbarLayout | null, surface: ToolbarSurface, id: string, delta: -1 | 1): ToolbarLayout | null {
  const ids = shownIds(stored, surface);
  const at = ids.indexOf(id), to = at + delta;
  if (at < 0 || to < 0 || to >= ids.length) return stored;
  [ids[at], ids[to]] = [ids[to]!, ids[at]!];
  return withSurface(stored, surface, ids);
}

/** Drag-to-reorder: put a shown button before the row now at `index` of the shown list (0…its length). */
export function placeTool(stored: ToolbarLayout | null, surface: ToolbarSurface, id: string, index: number): ToolbarLayout | null {
  const ids = shownIds(stored, surface);
  const from = ids.indexOf(id);
  if (from < 0) return stored;
  const rest = ids.filter((other) => other !== id);
  const to = Math.max(0, Math.min(rest.length, index > from ? index - 1 : index));
  return withSurface(stored, surface, [...rest.slice(0, to), id, ...rest.slice(to)]);
}

/** 「恢復預設」 for one surface. */
export function resetToolbar(stored: ToolbarLayout | null, surface: ToolbarSurface): ToolbarLayout | null {
  return withSurface(stored, surface, null);
}

/** The most ids a stored surface keeps (the server accepts as many). */
const MAX_STORED_IDS = 64;

/** A stored layout read back (local copy or server), or null when it is not one. */
export function parseToolbarLayout(value: unknown): ToolbarLayout | null {
  if (!value || typeof value !== "object") return null;
  const { bar, selection } = value as { bar?: unknown; selection?: unknown };
  const ids = (list: unknown): string[] | null | undefined => {
    if (list === null) return null;
    if (!Array.isArray(list) || !list.every((id) => typeof id === "string" && id.length > 0 && id.length <= 64)) return undefined;
    return [...new Set(list as string[])].filter((_, i) => i < MAX_STORED_IDS);
  };
  const b = ids(bar), s = ids(selection);
  return b === undefined || s === undefined ? null : { bar: b, selection: s };
}
