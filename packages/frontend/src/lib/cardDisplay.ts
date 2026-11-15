// How a board draws its cards: each card folded (title bar only) or expanded,
// the board's default for cards nobody chose for, and the far-zoom mode that
// keeps only titles. One place for the rules; CardNode, the 「顯示」 menu, the
// selection bar and the tree layout all read them from here
// (docs/agents/decisions-ui.md, 白板卡片顯示).
//
// What it replaces: the session-only 「精簡卡片」 flag (`data.compact`), the
// `zoom < 0.5` "simplified" card, and the `folded` flag nobody could toggle.
//   - 精簡卡片 on  → card default 「摺起來」; off or never stored → 「展開」.
//   - simplified   → title-only far zoom (below), switchable.
//   - folded       → the card's own choice, kept in the board's settings so a
//                    tree card the person never touched stores nothing.
// Zoom only changes how a card is drawn, never the geometry saved with it.

export type CardDefault = "folded" | "expanded";

/** As stored in the whiteboard tab's `layout_config.display`: a key is absent until chosen. */
export type CardDisplaySettings = {
  cardDefault?: CardDefault;
  /** Far zoom shows titles only. Absent: on. */
  titleOnlyFar?: boolean;
  /** Cards the person folded / expanded themselves; they beat `cardDefault`. */
  foldedIds?: readonly string[];
  expandedIds?: readonly string[];
};

const KEY = "display";
/** A board remembers at most this many individual choices of each kind. */
const MAX_CHOICES = 500;

const ids = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string").slice(-MAX_CHOICES) : undefined;

/** The display settings in a whiteboard tab's `layout_config`; unreadable parts count as unset.
 *  An old `compact` flag reads as the card default (see `cardDefaultFromCompact`). */
export function readDisplaySettings(layoutConfig: Record<string, unknown> | null | undefined): CardDisplaySettings {
  const raw = layoutConfig?.[KEY];
  if (!raw || typeof raw !== "object") return {};
  const { cardDefault, compact, titleOnlyFar, foldedIds, expandedIds } = raw as Record<string, unknown>;
  const chosen = cardDefault === "folded" || cardDefault === "expanded" ? cardDefault : typeof compact === "boolean" ? cardDefaultFromCompact(compact) : undefined;
  return {
    ...(chosen ? { cardDefault: chosen } : {}),
    ...(typeof titleOnlyFar === "boolean" ? { titleOnlyFar } : {}),
    ...(ids(foldedIds)?.length ? { foldedIds: ids(foldedIds) } : {}),
    ...(ids(expandedIds)?.length ? { expandedIds: ids(expandedIds) } : {}),
  };
}

/** `layoutConfig` with the display settings replaced and every other key kept. */
export function withDisplaySettings(layoutConfig: Record<string, unknown>, settings: CardDisplaySettings): Record<string, unknown> {
  return { ...layoutConfig, [KEY]: settings };
}

/** 精簡卡片 on meant folded cards; off, or never stored, meant expanded ones. */
export const cardDefaultFromCompact = (compact: boolean | undefined): CardDefault => compact ? "folded" : "expanded";

export const effectiveDefault = (settings: CardDisplaySettings): CardDefault => settings.cardDefault ?? "expanded";
export const titleOnlyFarOn = (settings: CardDisplaySettings): boolean => settings.titleOnlyFar ?? true;

/** Whether the card shows only its title bar: its own choice, else a stored
 *  `folded` flag from before cards could be chosen for, else the board default. */
export function isCardFolded(settings: CardDisplaySettings, card: { nodeId: string; folded?: boolean }): boolean {
  if (settings.foldedIds?.includes(card.nodeId)) return true;
  if (settings.expandedIds?.includes(card.nodeId)) return false;
  return card.folded === true || effectiveDefault(settings) === "folded";
}

/** The settings after `cardIds` are all folded or all expanded by the person. */
export function withCardsFolded(settings: CardDisplaySettings, cardIds: readonly string[], folded: boolean): CardDisplaySettings {
  const moved = new Set(cardIds);
  const keep = (list: readonly string[] | undefined) => (list ?? []).filter((id) => !moved.has(id));
  const foldedIds = folded ? [...keep(settings.foldedIds), ...cardIds] : keep(settings.foldedIds);
  const expandedIds = folded ? keep(settings.expandedIds) : [...keep(settings.expandedIds), ...cardIds];
  const { foldedIds: _f, expandedIds: _e, ...rest } = settings;
  return { ...rest, ...(foldedIds.length ? { foldedIds: foldedIds.slice(-MAX_CHOICES) } : {}), ...(expandedIds.length ? { expandedIds: expandedIds.slice(-MAX_CHOICES) } : {}) };
}

/** 全部摺起來／全部展開: the default moves and every individual choice is dropped. */
export function withEveryCardSet(settings: CardDisplaySettings, cardDefault: CardDefault): CardDisplaySettings {
  const { foldedIds: _f, expandedIds: _e, ...rest } = settings;
  return { ...rest, cardDefault };
}

// ── Heights (canvas px) ─────────────────────────────────────────────────────

/** A folded card: the title bar. */
export const FOLDED_CARD_H = 44;
/** Header of a card (its title bar). */
export const CARD_HEADER_H = 38;
/** An expanded card shows at most this much body before it fades out. */
export const BODY_MAX_H = 170;
/** Room under the body for 「開啟完整筆記」. */
export const OPEN_NOTE_ROW_H = 24;
/** The tallest an expanded card without a height of its own gets; tree rows are spaced by it. */
export const EXPANDED_CARD_MAX_H = CARD_HEADER_H + BODY_MAX_H + OPEN_NOTE_ROW_H;

/** The body is cut and fades only when it is taller than the limit. */
export const bodyOverflows = (bodyHeight: number): boolean => bodyHeight > BODY_MAX_H + 1;

/** The height a card takes on the board, for placing the cards around it. */
export function cardLayoutHeight(settings: CardDisplaySettings, card: { nodeId: string; height?: number; folded?: boolean }): number {
  if (isCardFolded(settings, card)) return FOLDED_CARD_H;
  return card.height ?? EXPANDED_CARD_MAX_H;
}

// ── Far zoom ────────────────────────────────────────────────────────────────

/** Thresholds, from nearest to farthest (the table in the PR description):
 *    zoom ≥ 0.30             cards as folded or expanded
 *    0.15 ≤ zoom < 0.30      titles only, in screen-size text (if 「縮小時只顯示標題」 is on)
 *    zoom < 0.15             cards inside a section hide; the section's title remains */
export const TITLE_ONLY_BELOW = 0.3;
export const SECTION_ONLY_BELOW = 0.15;
/** Screen font size of a title-only card, and where it grows. */
export const TITLE_SCREEN_PX = { near: 13, far: 16, farBelow: 0.22 } as const;
/** Titles stay at least this thick on screen: connection lines in far zoom. */
export const FAR_LINE_MIN_SCREEN_PX = 1.2;

export const showsTitleOnly = (zoom: number, settings: CardDisplaySettings): boolean => titleOnlyFarOn(settings) && zoom < TITLE_ONLY_BELOW;
export const sectionHidesCards = (zoom: number): boolean => zoom < SECTION_ONLY_BELOW;

/** The title's size in canvas px: the same on screen whatever the zoom. */
export function titleCanvasPx(zoom: number): number {
  const screen = zoom < TITLE_SCREEN_PX.farBelow ? TITLE_SCREEN_PX.far : TITLE_SCREEN_PX.near;
  return screen / zoom;
}

type Box = { nodeId: string; x: number; y: number; width?: number; height?: number };

/** How wide a title-only card may grow: at least the card's own width, at most
 *  up to the next card to its right whose rows it shares (less a small gap). */
export function titleOnlyMaxWidth(card: Box, cards: readonly Box[], defaultWidth: number, defaultHeight: number, gap = 24): number {
  const own = card.width ?? defaultWidth;
  const top = card.y;
  const bottom = card.y + (card.height ?? defaultHeight);
  let nextLeft = Infinity;
  for (const other of cards) {
    if (other.nodeId === card.nodeId || other.x < card.x + own) continue;
    const otherBottom = other.y + (other.height ?? defaultHeight);
    if (other.y < bottom && otherBottom > top) nextLeft = Math.min(nextLeft, other.x);
  }
  return Number.isFinite(nextLeft) ? Math.max(own, nextLeft - card.x - gap) : Math.max(own, own * 2);
}

/** The camera for a click on a title in far zoom: about 90%, the card centred. */
export const FOCUS_ZOOM = 0.9;
