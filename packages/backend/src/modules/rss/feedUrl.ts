// Feed and item URLs — pure (no DB), shared by subscribe, OPML import and the
// fetch effect (depth audit D53).
//
// A feed URL arrives from a form, an OPML file or a browser's `feed:` handler.
// feedUrl() is the one gate: it turns `feed://` / `feed:https://` into the
// http(s) URL a fetch can use, refuses every other protocol, and stores one
// normalised form (lower-case scheme and host, no default port, no fragment).
// feedUrlKey() is the identity two subscriptions are compared by: the stored
// path keeps its trailing slash (WordPress serves /feed/ and redirects /feed),
// but /feed/ and /feed are the same subscription.

/** The http(s) URL to store and fetch for `raw`, or null when it is not one. */
export function feedUrl(raw: string): string | null {
  let s = raw.trim();
  // feed://host/path (scheme replaced) and feed:https://host/path (prefixed).
  if (/^feed:\/\//i.test(s)) s = `https://${s.slice("feed://".length)}`;
  else if (/^feed:https?:\/\//i.test(s)) s = s.slice("feed:".length);
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  url.hash = "";
  return url.href;
}

/** Duplicate identity of a feed URL (stored or raw): feedUrl() without a
 *  trailing slash on the path. Null when it is not a feed URL. */
export function feedUrlKey(raw: string): string | null {
  const href = feedUrl(raw);
  if (!href) return null;
  const url = new URL(href);
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
  return url.href;
}

/** An item's link resolved against its feed (Atom often carries relative
 *  hrefs, which would otherwise open on Onden's own origin). Only http(s)
 *  links are kept; anything else is no link at all. */
export function itemUrl(link: string | null | undefined, feed: string): string | null {
  if (!link?.trim()) return null;
  try {
    const url = new URL(link.trim(), feed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
