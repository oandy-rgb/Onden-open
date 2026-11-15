// What every embedded-media iframe and /media SVG link is drawn with, by the
// site's React renderer and the exports' hast renderer alike (they are held
// together by frontend/src/test/renderParity.test.tsx). Its own file, not
// mediaEmbed.ts: that one is in the app's boot JS (the host gate), these strings
// are only needed where a note is drawn, which loads later.

import type { Root, Element, Parents } from "hast";
import { visit } from "unist-util-visit";
import { EMBED_IFRAME_SANDBOX } from "./mediaEmbed.js";

/** The `allow` (permissions policy) of every embedded iframe: what a video
 *  player needs and nothing else. One string for the app and the exports. */
export const EMBED_IFRAME_ALLOW =
  "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen";

/** What an embedded iframe tells the framed host about the page it sits on. */
export const EMBED_IFRAME_REFERRER_POLICY = "strict-origin-when-cross-origin";

/** The `title` of an embed that has no label of its own (screen readers).
 *  The app translates this key (i18n); the exports translate it themselves
 *  (backend htmlUtils, by the site's locale). */
export const EMBED_DEFAULT_TITLE = "Embedded media";

const isMediaSvgHref = (href: string) => /\/media\/[^/?#]+\.svg(?:[?#]|$)/i.test(href);

/** The published profile shows a link to an uploaded SVG (/media/x.svg) as a
 *  picture, on the site (MarkdownRenderer) and in the exports (md2html) alike
 *  — both add this plugin after ondenMarkdown's own (not inside it: the app's
 *  boot JS carries that pipeline, and only these two renderers need this): opened as a top-level document it would run the SVG's script where
 *  a static host sends no CSP sandbox, and an <img> never does. Runs after
 *  sanitize; the href already passed its scheme check. */
export function rehypeMediaSvgLinks() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element, index: number | undefined, parent: Parents | undefined) => {
      const href = node.properties.href;
      if (node.tagName !== "a" || typeof href !== "string" || !isMediaSvgHref(href) || !parent || index === undefined) return;
      parent.children[index] = {
        type: "element", tagName: "img", children: [],
        properties: { src: href, alt: node.children.map((c) => (c.type === "text" ? c.value : "")).join(""), className: ["md-image"], loading: "lazy" },
      };
    });
  };
}

/** The attributes every embed iframe carries besides `src` and `title`, under
 *  the property names React and hast share. */
export const EMBED_IFRAME_ATTRS = {
  sandbox: EMBED_IFRAME_SANDBOX,
  allow: EMBED_IFRAME_ALLOW,
  allowFullScreen: true,
  loading: "lazy",
  referrerPolicy: EMBED_IFRAME_REFERRER_POLICY,
} as const;
