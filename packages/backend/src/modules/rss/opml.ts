// OPML import/export — pure string functions (no DB), unit-tested DB-free.
//
// OPML is the lingua franca for moving subscription lists between readers.
// We parse with regexes rather than an XML dependency: the subset that
// matters is `<outline ... xmlUrl="...">`, and real-world OPML (Feedly,
// Inoreader, NetNewsWire exports) is exactly that shape.

import { decodeHtmlEntities, escapeHtml } from "@onden/markdown";
import { feedUrl, feedUrlKey } from "./feedUrl.js";

export type OpmlEntry = { url: string; title: string };

export function parseOpml(xml: string): OpmlEntry[] {
  const out: OpmlEntry[] = [];
  const seen = new Set<string>();
  // Every <outline …> carrying an xmlUrl is a feed, regardless of nesting
  // (folders are outlines WITHOUT xmlUrl — we flatten them away).
  const outlineRe = /<outline\b[^>]*>/gi;
  for (const m of xml.matchAll(outlineRe)) {
    const tag = m[0];
    const attr = (name: string): string | null => {
      const am = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"))
        ?? tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i"));
      return am ? decodeHtmlEntities(am[1]) : null;
    };
    // The same gate as the subscribe form (feedUrl.ts): feed:// becomes
    // https://, any other protocol is not a feed, and /feed/ = /feed.
    const raw = attr("xmlUrl");
    const url = raw ? feedUrl(raw) : null;
    const key = url ? feedUrlKey(url) : null;
    if (!url || !key || seen.has(key)) continue;
    seen.add(key);
    out.push({ url, title: attr("title") ?? attr("text") ?? url });
  }
  return out;
}

export function buildOpml(entries: OpmlEntry[], docTitle = "Onden subscriptions"): string {
  const outlines = entries
    .map((e) => `    <outline type="rss" text="${escapeHtml(e.title)}" title="${escapeHtml(e.title)}" xmlUrl="${escapeHtml(e.url)}"/>`)
    .join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<opml version="2.0">`,
    `  <head><title>${escapeHtml(docTitle)}</title></head>`,
    `  <body>`,
    outlines,
    `  </body>`,
    `</opml>`,
    ``,
  ].join("\n");
}
