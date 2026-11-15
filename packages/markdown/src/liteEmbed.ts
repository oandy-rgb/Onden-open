// A YouTube / Vimeo embed drawn "lite": a thumbnail (or a neutral box) with a
// play button, which becomes the real iframe only when the reader presses it
// (mediaEnhance.ts). Its own file, like embedFrame.ts: only the renderers
// that draw a note need it, not the app's boot JS.
//
// One model, three drawers: the app and the site (MarkdownRenderer, React) and
// the exports (backend htmlUtils, hast) all read liteEmbedOf and the class
// names below, and frontend/src/test/renderParity.test.tsx holds them together.
// Without script the thumbnail is a plain link to the video.

import { EMBED_IFRAME_ATTRS } from "./embedFrame.js";
import { escapeHtml } from "./html.js";
import { isAllowedEmbedSrc } from "./mediaEmbed.js";
import {
  LITE_EMBED_CLASS, LITE_EMBED_HOST_CLASS, LITE_EMBED_LINK_CLASS, LITE_EMBED_PLAY_CLASS, LITE_EMBED_THUMB_CLASS,
} from "./mediaMarkup.js";

export { LITE_EMBED_CLASS, LITE_EMBED_HOST_CLASS, LITE_EMBED_LINK_CLASS, LITE_EMBED_PLAY_CLASS, LITE_EMBED_THUMB_CLASS };

/** The only host a thumbnail is fetched from (the site's CSP img-src and the
 *  readers' privacy note both name it). */
export const YOUTUBE_THUMB_HOST = "i.ytimg.com";


export type LiteEmbed = {
  /** The iframe address (a trusted embed URL, toEmbedUrl). */
  frameSrc: string;
  /** The video's own page: where the link goes with no script. */
  watchUrl: string;
  /** YouTube's thumbnail; null for Vimeo, which has none without its API. */
  thumbUrl: string | null;
  /** The domain shown on the neutral box that stands in for a missing thumbnail. */
  host: string;
};

/** The lite parts of a trusted embed URL (toEmbedUrl's result), or null for
 *  anything else — a caller then draws the plain iframe. */
export function liteEmbedOf(embedUrl: string): LiteEmbed | null {
  if (!isAllowedEmbedSrc(embedUrl)) return null;
  const url = new URL(embedUrl);
  const id = url.pathname.split("/")[2] ?? "";
  if (url.hostname.endsWith("youtube-nocookie.com") && /^[\w-]{6,15}$/.test(id)) {
    return {
      frameSrc: embedUrl,
      watchUrl: `https://www.youtube.com/watch?v=${id}`,
      thumbUrl: `https://${YOUTUBE_THUMB_HOST}/vi/${id}/hqdefault.jpg`,
      host: "youtube.com",
    };
  }
  if (url.hostname === "player.vimeo.com" && /^\d+$/.test(id)) {
    return { frameSrc: embedUrl, watchUrl: `https://vimeo.com/${id}`, thumbUrl: null, host: "vimeo.com" };
  }
  return null;
}

type HastNode = {
  type: "element"; tagName: string; properties: Record<string, unknown>;
  children: HastNode[]; content?: { type: "root"; children: HastNode[] };
} | { type: "text"; value: string };

const el = (tagName: string, properties: Record<string, unknown>, children: HastNode[] = []): HastNode =>
  ({ type: "element", tagName, properties, children });

/** The inert iframe a press brings in, as the HTML a <template> holds (React). */
export function liteEmbedFrameHtml(lite: LiteEmbed, label: string): string {
  const a = EMBED_IFRAME_ATTRS;
  return `<iframe src="${escapeHtml(lite.frameSrc)}" title="${escapeHtml(label)}" sandbox="${a.sandbox}" allow="${a.allow}" allowfullscreen loading="${a.loading}" referrerpolicy="${a.referrerPolicy}"></iframe>`;
}

/** The lite embed as hast, for the exports; the React drawer
 *  (MarkdownRenderer EmbedIframe) writes the same tree. */
export function liteEmbedHast(lite: LiteEmbed, label: string): HastNode {
  const frame = el("iframe", { src: lite.frameSrc, title: label, ...EMBED_IFRAME_ATTRS });
  return el("span", { className: ["md-embed", LITE_EMBED_CLASS] }, [
    el("a", { className: [LITE_EMBED_LINK_CLASS], href: lite.watchUrl, target: "_blank", rel: "noreferrer", ariaLabel: label }, [
      lite.thumbUrl
        ? el("img", { className: [LITE_EMBED_THUMB_CLASS], src: lite.thumbUrl, alt: "", loading: "lazy", decoding: "async", referrerPolicy: "no-referrer" })
        : el("span", { className: [LITE_EMBED_HOST_CLASS] }, [{ type: "text", value: lite.host }]),
      el("span", { className: [LITE_EMBED_PLAY_CLASS], ariaHidden: "true" }),
    ]),
    { ...el("template", {}), content: { type: "root", children: [frame] } } as HastNode,
  ]);
}
