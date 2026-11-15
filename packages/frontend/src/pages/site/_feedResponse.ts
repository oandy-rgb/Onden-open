// The RSS 2.0 response of the site's two feeds (/site/feed.xml and a tag's feed.xml). It lives with the pages
// because the article text in each item is drawn by _siteFeedBody, which lib/ may not import.
import { escapeHtml } from "@onden/markdown";
import { feedSummary, headSiteMedia, sortByUpdatedDesc, type SiteSnapshot } from "../../lib/siteFeed";
import { enclosureXml, firstAudioEnclosure, itunesChannelTags } from "../../lib/siteFeedAudio";
import { shareImageUrl } from "../../lib/siteShareImage";
import { siteName } from "../../lib/siteName";
import type { PublishedNode } from "../../lib/publishedNode";
import { cdata, feedBodyHtml } from "./_siteFeedBody";

const maxItems = 50;

/** The RSS 2.0 feed of `nodes` (newest 50, each with its full text as the article page draws it):
 *  the whole site's, or one tag's (`tag`: its name and page address). */
export async function feedResponse({ snapshot, origin, nodes, tag }: {
  snapshot: SiteSnapshot; origin: string; nodes: PublishedNode[]; tag?: { name: string; path: string };
}): Promise<Response> {
  const { site } = snapshot;
  const brand = siteName(site.brand, null);
  const title = tag ? `${tag.name} — ${brand}` : brand;
  const description = site.description || site.tagline || title;
  const newest = sortByUpdatedDesc(nodes).slice(0, maxItems);
  // A note with an audio file is a podcast episode: its first file is the item's enclosure.
  const enclosures = await Promise.all(newest.map((n) => firstAudioEnclosure(n.markdown ?? "", origin, headSiteMedia)));
  const hasAudio = enclosures.some(Boolean);
  const items = newest
    .map((n, i) => {
      const link = `${origin}/site/${n.slug}`;
      const pubDate = n.updated_at ? new Date(n.updated_at).toUTCString() : "";
      const summary = feedSummary(n);
      return [
        "    <item>",
        `      <title>${escapeHtml(n.title)}</title>`,
        `      <link>${escapeHtml(link)}</link>`,
        `      <guid isPermaLink="false">${escapeHtml(n.id)}</guid>`,
        pubDate ? `      <pubDate>${pubDate}</pubDate>` : null,
        summary ? `      <description>${escapeHtml(summary)}</description>` : null,
        enclosures[i] ? enclosureXml(enclosures[i]!) : null,
        // The article text is drawn from every published note: links and frozen query results resolve against them all.
        `      <content:encoded>${cdata(feedBodyHtml(snapshot.nodes, n, origin, site.locale))}</content:encoded>`,
        "    </item>",
      ].filter(Boolean).join("\n");
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"${hasAudio ? ' xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"' : ""}>
  <channel>
    <title>${escapeHtml(title)}</title>
    <link>${escapeHtml(`${origin}${tag?.path ?? "/site/"}`)}</link>
    <description>${escapeHtml(description)}</description>
${hasAudio ? `${itunesChannelTags(brand, shareImageUrl(site.logo, origin), escapeHtml).join("\n")}\n` : ""}${items}
  </channel>
</rss>
`;
  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
}
