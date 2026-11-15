// What the server fixes at publish time and the pages draw: the rows a home
// component or a tag page lists, and the frozen design that carries them. The
// backend builds these (publishing/siteRows.ts, frozenDesign.ts), the site and
// the studio read them — one definition, so a field change breaks both sides at
// compile time (contract: docs/architecture/proposals/publish-redesign-2026-10-24.md §5.3).

/** One listed note, as /api/site gives it to the renderer. */
export type SiteRow = {
  id: string;
  title: string;
  /** The slug the site serves the note under (the candidate's, after clash renames). */
  slug: string;
  /** The note's created date, `YYYY-MM-DD`; "" when unknown. */
  date: string;
  /** The saved view's visible fields: field name → value. Empty without a view. */
  fields: Record<string, string | null>;
  /** The first image of the note: `https://…`, `http://…` or `/…`; "" for none. */
  image: string;
  /** The first paragraph with prose as plain text, at most 140 characters. */
  excerpt: string;
};

export type ViewKind = "list" | "cards" | "table";

export type SiteTagPage = { name: string; slug: string; viewKind: ViewKind; rows: SiteRow[] };

/** The frozen part of a design (`presentation.design` in the payload). */
export type FrozenDesign = {
  v: 3;
  preset: unknown;
  boxes: unknown;
  style: unknown;
  css: string;
  date_tags: unknown;
  reading: unknown;
  /** The old Puck home page; null unless it is the one drawn. */
  legacy_home: unknown;
  resolved: Record<string, SiteRow[]>;
  tag_pages: Record<string, SiteTagPage>;
  tag_names: Record<string, string>;
};
