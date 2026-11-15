import type { ReactNode } from "react";
import type { SiteRow } from "../rows.js";

/** What the site components read from Puck's `puck.metadata`. The caller
 *  (the published site, the studio preview) supplies it; the design itself
 *  holds ids only. */
export type SiteNote = { id: string; title: string; slug: string; markdown: string; date?: string; tags?: string[];
  /** The paragraphs links and embeds point to (anchor id, place in `markdown`); the text itself carries no `^id`. */
  part_anchors?: Array<{ id: string; from: number; to: number }> };

export type SiteRenderMeta = {
  /** Published notes by id. A note that is not here is unpublished and renders nothing. */
  notes: Record<string, SiteNote>;
  /** In the studio: the notes the page points at that are not published, by id. They draw as their title and a 「未發布」 mark. */
  drafts?: Record<string, { title: string }>;
  /** The rows of each `tag_view` / `timeline`, fixed at publish, by component id. */
  resolved: Record<string, SiteRow[]>;
  /** Tag names by tag id (for headings). */
  tagNames: Record<string, string>;
  /** Markdown → React, supplied by the caller (the published-profile renderer). */
  renderMarkdown: (markdown: string) => ReactNode;
  hrefFor: (slug: string) => string;
  /** In the studio: unpublished / empty content shows a marker instead of nothing. */
  editing?: boolean;
};

export const EMPTY_META: SiteRenderMeta = {
  notes: {},
  resolved: {},
  tagNames: {},
  renderMarkdown: (markdown) => markdown,
  hrefFor: (slug) => `/site/${slug}/`,
};
