// Trusted iframe-embed host allowlist + media parser: which embeds a rendered
// note may frame, on every renderer (the app's MarkdownRenderer components,
// the backend exports' HTML post-processing, the site's CSP frame-src).

import { mediaTypeOf } from "./mediaTypes.js";

// Security boundary: an <iframe> can run arbitrary script in its src origin.
// rehype-sanitize's protocol allowlist only restricts the URL *scheme*
// (https), NOT the host — so on its own it would happily embed
// `https://evil.example`. We therefore additionally gate the host to a small
// set of trusted providers (YouTube / Vimeo) and ALWAYS render the iframe
// sandboxed. Any src whose host isn't on the list is dropped, not rendered.

// Hostnames (and their subdomains) we trust to be framed.
export const TRUSTED_EMBED_HOSTS = [
  "youtube.com",
  "youtube-nocookie.com",
  "player.vimeo.com",
  "vimeo.com",
] as const;

/** The sandbox flags every embedded iframe is locked to. Deliberately omits
 *  allow-same-origin so a framed page can't reach back into our origin's
 *  storage/cookies; allow-scripts + allow-presentation + allow-popups are the
 *  minimum a video player needs. */
export const EMBED_IFRAME_SANDBOX =
  "allow-scripts allow-presentation allow-popups";

function hostOf(src: string): string | null {
  try {
    // Protocol-relative (//host/…) and bare-host forms get a scheme so URL()
    // can parse them; anything non-https is rejected below.
    const normalized = src.startsWith("//") ? `https:${src}` : src;
    const u = new URL(normalized);
    if (u.protocol !== "https:") return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** `host` is `domain` or a subdomain of it: the match sits on a dot boundary,
 *  so `evilvimeo.com` is not `vimeo.com`. */
function isHostOrSubdomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** True iff `src` is an https URL whose host is (a subdomain of) a trusted
 *  embed provider. Used to gate <iframe src> on BOTH render paths. */
export function isAllowedEmbedSrc(src: string | null | undefined): boolean {
  if (!src) return false;
  const host = hostOf(src);
  if (!host) return false;
  return TRUSTED_EMBED_HOSTS.some((h) => isHostOrSubdomain(host, h));
}

export type MediaKind = "video" | "audio" | "iframe" | null;

/** Classify a media URL: a direct audio/video file (by its extension on the
 *  one media table, mediaTypes.ts) → video/audio; a trusted provider URL →
 *  iframe; otherwise null (caller falls back to a plain link/image). */
export function classifyMedia(src: string | null | undefined): MediaKind {
  if (!src) return null;
  const kind = mediaTypeOf(src)?.kind;
  if (kind === "video" || kind === "audio") return kind;
  if (toEmbedUrl(src)) return "iframe";
  return null;
}

/** Normalise a YouTube / Vimeo *watch* or *share* URL to its embeddable
 *  player URL. Returns null for anything not on a trusted host. Already-embed
 *  URLs (…/embed/…, player.vimeo.com/video/…) pass through unchanged. */
export function toEmbedUrl(src: string | null | undefined): string | null {
  if (!src) return null;
  const host = hostOf(src);
  if (!host) return null;

  const isYouTube = host === "youtu.be" || isHostOrSubdomain(host, "youtube.com") || isHostOrSubdomain(host, "youtube-nocookie.com");
  const isVimeo = isHostOrSubdomain(host, "vimeo.com");

  try {
    const u = new URL(src.startsWith("//") ? `https:${src}` : src);
    if (isYouTube) {
      // youtu.be/<id>, watch?v=<id>, /embed/<id>, /shorts/<id>
      let id: string | null = null;
      if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0] || null;
      else if (u.pathname === "/watch") id = u.searchParams.get("v");
      else if (u.pathname.startsWith("/embed/")) id = u.pathname.slice("/embed/".length).split("/")[0] || null;
      else if (u.pathname.startsWith("/shorts/")) id = u.pathname.slice("/shorts/".length).split("/")[0] || null;
      if (!id || !/^[\w-]{6,15}$/.test(id)) return null;
      return `https://www.youtube-nocookie.com/embed/${id}`;
    }
    if (isVimeo) {
      // player.vimeo.com/video/<id> (already embed) or vimeo.com/<id>
      if (host === "player.vimeo.com" && u.pathname.startsWith("/video/")) {
        const id = u.pathname.slice("/video/".length).split("/")[0];
        return /^\d+$/.test(id) ? `https://player.vimeo.com/video/${id}` : null;
      }
      const id = u.pathname.slice(1).split("/")[0];
      return /^\d+$/.test(id) ? `https://player.vimeo.com/video/${id}` : null;
    }
  } catch {
    return null;
  }
  return null;
}
