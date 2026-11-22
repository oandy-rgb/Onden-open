// The shape of a website design. v2 (publish-redesign-2026-10-24.md §5.2): the home page is Puck
// data that stores ids only. v3 (site-boxes-2026-11-01.md): the pages are boxes that hold widgets
// (boxes.ts, widgets.ts); the Puck home survives as `legacy_home`.

/** A Puck component: `props.id` plus its own props; a slot prop holds an array
 *  of components. Our own minimal shape so this entry never imports Puck. */
export type PuckComponentData = { type: string; props: { id: string; [prop: string]: unknown } };
export type PuckData = { root: { props: Record<string, unknown> }; content: PuckComponentData[] };

export type FontKind = "serif" | "sans" | "kai";
/** 安靜、紙本、書冊、手寫. */
export type StylePresetName = "quiet" | "paper" | "folio" | "hand";
/** Which colours the visitor sees: their system's choice, or always light / dark. */
export type SiteScheme = "system" | "light" | "dark";

/** What the owner chooses; the type scale, spacing and both colour sets are computed from it (style.ts). */
export type SiteStyle = {
  preset: StylePresetName;
  /** `#rrggbb`. */
  accent: string;
  scheme: SiteScheme;
};

export type SiteFrames = {
  article: Record<string, boolean>;
  tag: Record<string, boolean>;
  /** Names of the tags whose notes show a date (default `文章`). */
  date_tags: string[];
};

/** The v2 design: a Puck home page plus switches for the article and tag frames.
 *  Kept as the shape the old home studio edits and that a stored v2 chrome is
 *  migrated from (migrate.ts); the stored and published design is `SiteDesign` (v3). */
export type SiteDesignV2 = {
  v: 2;
  /** The version of the stored design (the chrome store's `rev`). */
  rev: string;
  studio_draft: true;
  home: PuckData;
  style: SiteStyle;
  /** Site-wide CSS. */
  css: string;
  frames: SiteFrames;
};

/** What sits in a box: a widget and one of its looks. `null` in a box means the owner left it empty. */
export type BoxPick = { widget: string; variant: string };

/** The four ready-made home pages (presets.ts). */
export type HomePresetId = "simple" | "garden" | "newsletter" | "index";

/** Box id → what it holds: a list box an array (at most its `max`), a single box one pick or `null`. */
export type SiteBoxes = {
  header: BoxPick | null;
  "home.hero": BoxPick | null;
  "home.list": BoxPick[];
  "note.meta": BoxPick | null;
  "note.left": BoxPick | null;
  "note.right": BoxPick | null;
  "note.end": BoxPick[];
  "tag.desc": BoxPick | null;
  "tag.list": BoxPick | null;
  "tag.end": BoxPick[];
  foot: BoxPick[];
};

/** The v3 design (docs/architecture/proposals/site-boxes-2026-11-01.md §4). */
export type SiteDesign = {
  v: 3;
  /** The version of the stored design (the chrome store's `rev`). */
  rev: string;
  studio_draft: true;
  /** The home page style last chosen. `null` with a `legacy_home` = the old free-form home page is drawn. */
  preset: HomePresetId | null;
  boxes: SiteBoxes;
  style: SiteStyle;
  /** Site-wide CSS. */
  css: string;
  /** Names of the tags whose notes show a date (default `文章`). */
  date_tags: string[];
  /** Two reading behaviours that fill no box: the article's cover picture, and link preview cards. */
  reading: { cover: boolean; preview: boolean };
  /** The v2 Puck home page, kept until the owner picks a home page style. */
  legacy_home: PuckData | null;
};

/** The revision of a stored chrome (`rev`), or null for none (no chrome, or one saved before revisions).
 *  The server compares it with the one a save started from (a stale save is refused); the editor sends it. */
export function chromeRevision(chrome: unknown): string | null {
  const rev = chrome && typeof chrome === "object" ? (chrome as { rev?: unknown }).rev : undefined;
  return typeof rev === "string" && rev ? rev : null;
}
