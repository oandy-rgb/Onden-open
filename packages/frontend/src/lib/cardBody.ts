// Card-body shape detection for the canvas (CardNode). Pure so the render
// branches stay testable. A card whose whole body is a single image markdown
// renders as a filled image card (⑨ Heptabase-style), not a clamped preview;
// one whose body is a single audio/video file renders as a filled player.

import { mediaTypeOf } from "@onden/markdown";

export type MediaOnlyCard = { kind: "image" | "audio" | "video"; url: string; alt: string };

/** If `body` is exactly one `![alt](url "title")` with nothing else, what it
 *  shows: an audio/video file (by its extension on the one media table,
 *  @onden/markdown mediaTypes.ts — the sidebar's audio/video notes are
 *  written this way) is a player, any other image-capable URL an image. A
 *  known non-image file (.pdf, .docx…) is not a media card: null, as for any
 *  other body. An extensionless URL (an image CDN) stays an image. The url is
 *  the token before any optional markdown title. */
export function mediaOnlyCard(body: string): MediaOnlyCard | null {
  const m = body.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
  if (!m) return null;
  const url = m[2].trim().split(/\s+/)[0];
  if (!url) return null;
  const known = mediaTypeOf(url)?.kind;
  if (known === "audio" || known === "video") return { kind: known, url, alt: m[1] };
  if (known && known !== "image") return null;
  return { kind: "image", url, alt: m[1] };
}
