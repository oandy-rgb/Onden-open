// What a note's 「簡報」 view stores (docs/architecture/proposals/slides-2026-10-31.md
// §4.2): only the choices — which layout each page took, and the deck's theme.
// The pages themselves are never stored; they are cut from the note's text when
// it is read. A page is found again by its key (the frontend's slides/pageKey).
//
// Kept as one note attribute, `slides_data`, written through the ordinary
// attribute writer (offline queue, history, restore). Reading never throws: a
// damaged or newer value reads as the defaults, and a layout id this reader does
// not know is kept (only the frontend decides what it draws).

/** The note attribute that holds the deck's choices. */
export const SLIDES_DATA_ATTR = "slides_data";

/** 跟網站一樣 / 深色 / 紙本. */
export const SLIDES_THEMES = ["site", "dark", "paper"] as const;
export type SlidesTheme = (typeof SLIDES_THEMES)[number];

export type SlidesData = {
  v: 1;
  theme: SlidesTheme;
  /** Page key → layout id. A page without an entry takes the layout its content suggests. */
  layouts: Record<string, string>;
};

const MAX_BYTES = 8 * 1024;
const MAX_LAYOUTS = 64;
const MAX_KEY_LENGTH = 120;
const LAYOUT_ID = /^[a-z][A-Za-z0-9]{0,31}$/;

const isTheme = (value: unknown): value is SlidesTheme => SLIDES_THEMES.includes(value as SlidesTheme);
const empty = (): SlidesData => ({ v: 1, theme: "site", layouts: {} });

/** The stored text as choices; anything unreadable is the defaults. */
export function parseSlidesData(raw: string | null | undefined): SlidesData {
  if (!raw) return empty();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return empty(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty();
  const { theme, layouts } = parsed as { theme?: unknown; layouts?: unknown };
  const clean: Record<string, string> = {};
  if (layouts && typeof layouts === "object" && !Array.isArray(layouts)) {
    for (const [key, id] of Object.entries(layouts)) {
      if (key && key.length <= MAX_KEY_LENGTH && typeof id === "string" && LAYOUT_ID.test(id)) clean[key] = id;
    }
  }
  return { v: 1, theme: isTheme(theme) ? theme : "site", layouts: clean };
}

/** The text to store, or null when there is nothing to keep (the default theme
 *  and no chosen layout: the attribute is removed, no empty shell). The oldest
 *  choices go first when there are too many or the text would be too long. */
export function serializeSlidesData(data: SlidesData): string | null {
  let keys = Object.keys(data.layouts).slice(-MAX_LAYOUTS);
  const text = () => JSON.stringify({ v: 1, theme: data.theme, layouts: Object.fromEntries(keys.map((key) => [key, data.layouts[key]])) });
  while (keys.length > 0 && new TextEncoder().encode(text()).length > MAX_BYTES) keys = keys.slice(1);
  return data.theme === "site" && keys.length === 0 ? null : text();
}

/** `data` with this page's layout chosen; `null` takes the choice back (automatic). */
export function withPageLayout(data: SlidesData, pageKey: string, layout: string | null): SlidesData {
  const { [pageKey]: _dropped, ...rest } = data.layouts; // a changed choice moves to the newest end
  return { ...data, layouts: layout === null ? rest : { ...rest, [pageKey]: layout } };
}

export function withSlidesTheme(data: SlidesData, theme: SlidesTheme): SlidesData {
  return { ...data, theme };
}
