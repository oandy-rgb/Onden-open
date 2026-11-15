// Server reads of the optional modules (depth audit D11, deep-modules review
// 2026-10-24 sync-data #1). Modules used to import api()/apiFetch() themselves
// and so each owned its own offline and error handling; their endpoints now
// sit beside the core reads and callers use `reads.modules.<module>.<read>`.
//
// Each read is the same request the module made before. A response shape that
// only one module renders stays declared in that module and comes in as a type
// parameter, like the other reads (reads.ts); lib/data never imports a module.
// Handling a failure (keep the last value, show a notice) stays with the
// caller, which knows what its screen should do.
//
// Download links (`links`) are addresses the browser fetches itself, so no
// api() is involved — they are here because the API base is the data layer's.

import { api, getApiBase, postRead } from "../api";

const enc = encodeURIComponent;

const review = {
  /** A small read-filtered GET (counts, due lists) addressed by its path. */
  resource: <Raw>(path: string) => api<Raw>(path),
  /** The due cards at `url` (the review queue's own query string). */
  queue: <T>(url: string, signal: AbortSignal) => api<T>(url, { signal }),
  /** A board's saved layout, for placing extracted cards beside their source. */
  canvas: <T>(canvasId: string) => api<T>(`/api/canvases/${canvasId}`),
};

const importers = {
  /** The sources earlier folder imports came from (the "update this import" choices). */
  sources: <T>() => api<{ sources: T[] }>("/api/import/sources"),
};

const semantic = {
  /** Notes whose meaning is near `text`, among those the reader may read (empty while the module is off). */
  search: (text: string, signal?: AbortSignal) =>
    api<Array<{ id: string; title: string; distance: number }>>(`/api/semantic/search?q=${enc(text)}`, { signal }),
  /** How many of the reader's notes are ready to be found by meaning. */
  status: () => api<{ ready: number; total: number; working: boolean }>("/api/semantic/status"),
};

const rss = {
  items: <T>(query: URLSearchParams) => api<T>(`/api/rss/items?${query.toString()}`),
  item: <T>(id: string) => api<T>(`/api/rss/items/${id}`),
  /** A link inside an article: another article of the same source to read in place, or the browser's (links.ts). */
  link: <T>(id: string, url: string) => api<T>(`/api/rss/items/${id}/link?url=${encodeURIComponent(url)}`),
  sources: <T>() => api<T>("/api/rss/sources"),
  mutes: <T>() => api<T>("/api/rss/mutes"),
};

const website = {
  /** The published site's saved payload. */
  site: <T>() => api<T>("/api/site"),
  /** Where a note is served on the published site (null until it is). */
  publishedUrl: (nodeId: string) => api<{ published_url: string | null }>(`/api/site/url/${enc(nodeId)}`),
  /** Whether the site has a note, and whether a publish would change what readers see of it. */
  noteSiteStatus: (nodeId: string) =>
    api<{ state: "not_on_site" | "outdated" | "current" }>(`/api/site/status/${enc(nodeId)}`),
  snapshots: <T>() => api<T[]>("/api/snapshots"),
  /** What publishing `body` would put on the site (read-only). */
  publishPreview: <T>(body: unknown) =>
    postRead<T>("/api/publish/preview", body, { headers: { "Content-Type": "application/json" } }),
};

/** Addresses the browser opens by itself (an <a href download>). */
const links = {
  rssOpml: () => `${getApiBase()}/api/rss/opml`,
  staticExport: () => `${getApiBase()}/api/export-static`,
};

export const moduleReads = { review, rss, semantic, website, links, importers };
