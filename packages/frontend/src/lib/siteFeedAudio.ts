// A note's first audio file as a podcast <enclosure> in the site's RSS feed
// (feed.xml.ts). Only the site's own uploaded files qualify, and only what the
// server confirms an anonymous reader may fetch: the check is a HEAD request
// to /api/media/<id>, which runs the same canReadMedia gate as any reader's
// request (a private note's file answers 404). The note text alone cannot say:
// a published note may embed a file owned by a private one.
import { mediaRefs, mediaTypeOf } from "@onden/markdown";

export type FeedEnclosure = { url: string; length: number; type: string };

/** What the server says about `/api/media/<id>` to an anonymous reader:
 *  null when it is not readable (or the server could not be asked). */
export type MediaHead = (id: string) => Promise<{ length: number | null } | null>;

/** `<enclosure>` for the first audio file `markdown` embeds, or null. `origin`
 *  is the site's public address; `length` is 0 when the size is not known. */
export async function firstAudioEnclosure(markdown: string, origin: string, head: MediaHead): Promise<FeedEnclosure | null> {
  const id = mediaRefs(markdown).find((ref) => mediaTypeOf(ref)?.kind === "audio");
  if (!id) return null;
  const found = await head(id);
  if (!found) return null;
  return { url: `${origin}/api/media/${encodeURIComponent(id)}`, length: found.length ?? 0, type: mediaTypeOf(id)!.mime };
}

/** The XML of one enclosure, as RSS 2.0 writes it. */
export const enclosureXml = (e: FeedEnclosure): string =>
  `      <enclosure url="${e.url.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" length="${e.length}" type="${e.type}"/>`;

/** The channel tags Apple Podcasts asks for. Written only for a feed that has
 *  an audio item: a site without audio gets exactly the feed it always had. */
export function itunesChannelTags(author: string, imageUrl: string | undefined, escape: (s: string) => string): string[] {
  return [
    `    <itunes:author>${escape(author)}</itunes:author>`,
    "    <itunes:explicit>false</itunes:explicit>",
    ...(imageUrl ? [`    <itunes:image href="${escape(imageUrl)}"/>`] : []),
  ];
}
