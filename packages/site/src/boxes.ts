// The boxes of every page (docs/architecture/proposals/site-boxes-2026-11-01.md §2). Onden decides which
// boxes a page has, how big a list box may grow and how a box folds on a
// narrow screen; the owner decides only what sits in each box, and a box takes
// only the widgets of its class (widgets.ts).
import type { BoxPick, SiteBoxes } from "./design.js";

/** What a box accepts: a widget is allowed in a box when its `classes` include the box's class. */
export type BoxClass = "header" | "hero" | "section" | "meta" | "side" | "noteEnd" | "tagDesc" | "tagList" | "tagEnd" | "foot";

export type BoxPage = "all" | "home" | "note" | "tag";
export type BoxId = keyof SiteBoxes;

/** How a box folds when the screen is narrow: `after` moves it behind the main content, `hide` does not draw it, `flow` keeps its place. */
export type NarrowFold = "flow" | "after" | "hide";

export type BoxSpec = {
  id: BoxId;
  page: BoxPage;
  label: string;
  accepts: BoxClass;
  /** 1 = a single box; more = a list box that can grow to this many widgets. */
  max: number;
  /** A side column of the article when the screen is at least 1280px wide; below that it folds as `narrow` says. */
  column: boolean;
  narrow: NarrowFold;
};

export const BOX_SPECS: Record<BoxId, BoxSpec> = {
  header: { id: "header", page: "all", label: "頁首", accepts: "header", max: 1, column: false, narrow: "flow" },
  "home.hero": { id: "home.hero", page: "home", label: "首頁開頭", accepts: "hero", max: 1, column: false, narrow: "flow" },
  "home.list": { id: "home.list", page: "home", label: "首頁區塊", accepts: "section", max: 8, column: false, narrow: "flow" },
  "note.meta": { id: "note.meta", page: "note", label: "標題下的資訊", accepts: "meta", max: 1, column: false, narrow: "flow" },
  "note.left": { id: "note.left", page: "note", label: "內文左邊", accepts: "side", max: 1, column: true, narrow: "flow" },
  "note.right": { id: "note.right", page: "note", label: "內文右邊", accepts: "side", max: 1, column: true, narrow: "after" },
  "note.end": { id: "note.end", page: "note", label: "文末", accepts: "noteEnd", max: 4, column: false, narrow: "flow" },
  "tag.desc": { id: "tag.desc", page: "tag", label: "標籤說明", accepts: "tagDesc", max: 1, column: false, narrow: "flow" },
  "tag.list": { id: "tag.list", page: "tag", label: "標籤的筆記", accepts: "tagList", max: 1, column: false, narrow: "flow" },
  "tag.end": { id: "tag.end", page: "tag", label: "列表之後", accepts: "tagEnd", max: 3, column: false, narrow: "flow" },
  foot: { id: "foot", page: "all", label: "頁尾", accepts: "foot", max: 4, column: false, narrow: "flow" },
};
export const BOX_IDS = Object.keys(BOX_SPECS) as BoxId[];

/** A list box holds an array, a single box one pick or `null`. */
export const isListBox = (id: BoxId): boolean => BOX_SPECS[id].max > 1;

/** The picks of a box as a list (a single box: zero or one), for drawing in order. */
export function picksOf(boxes: SiteBoxes, id: BoxId): BoxPick[] {
  const value = boxes[id] as BoxPick | BoxPick[] | null;
  return Array.isArray(value) ? value : value ? [value] : [];
}

/** `boxes` with box `id` holding `value` (a list box: the array, cut at its `max`). */
export function withBox(boxes: SiteBoxes, id: BoxId, value: BoxPick | null | BoxPick[]): SiteBoxes {
  const next = isListBox(id)
    ? (Array.isArray(value) ? value : value ? [value] : []).slice(0, BOX_SPECS[id].max)
    : Array.isArray(value) ? value[0] ?? null : value;
  return { ...boxes, [id]: next };
}
