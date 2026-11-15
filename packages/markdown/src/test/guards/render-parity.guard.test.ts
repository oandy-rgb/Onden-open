// Guard for the published/export render parity batch (docs/research/dup-patterns-2026-10-30-render.md A2).
// The site draws embeds in React (MarkdownRenderer) and the exports in hast (htmlUtils embedFrame); the two
// share ONE set of constants (@onden/markdown embedFrame.ts, mediaEmbed.ts) and are held together by
// frontend/src/test/renderParity.test.tsx. Allowlist, deny by default: only these files frame a page or
// classify a media URL; any other file fails. An exception says why, and one that no longer matches fails too.
import { describe, expect, it } from "vitest";
import { FILES, staleAllowances, violations, type OwnerRule } from "./sources";

type Rule = OwnerRule & { sample: string };

const RENDERERS = ["frontend/src/components/MarkdownRenderer.tsx", "backend/src/modules/website/publishing/htmlUtils.ts"];

const RULES: Record<string, Rule> = {
  "an <iframe> is drawn by the two embed renderers": {
    what: "an <iframe> element (MarkdownRenderer EmbedIframe, htmlUtils embedFrame)",
    pattern: /<iframe\b|tagName:\s*"iframe"|el\("iframe"/,
    // liteEmbed.ts writes the inert iframe a click-to-load embed carries (one place for the React and hast drawers).
    owners: [...RENDERERS, "markdown/src/liteEmbed.ts"],
    exceptions: {
      "frontend/src/components/CardNode.tsx": "a whiteboard card's own web preview (a bar, a load button, any https page behind a click); its layout is not the 16:9 note embed, so it keeps its own iframes on the shared sandbox constant",
    },
    sample: '<iframe src={url} />',
  },
  "the embed iframe's sandbox / allow / referrer policy come from embedFrame.ts / mediaEmbed.ts": {
    what: "EMBED_IFRAME_ATTRS / EMBED_IFRAME_SANDBOX / EMBED_IFRAME_ALLOW / EMBED_IFRAME_REFERRER_POLICY (@onden/markdown mediaEmbed.ts)",
    pattern: /\bEMBED_IFRAME_(?:ATTRS|SANDBOX|ALLOW|REFERRER_POLICY)\b/,
    owners: [...RENDERERS, "markdown/src/mediaEmbed.ts", "markdown/src/embedFrame.ts", "markdown/src/liteEmbed.ts", "markdown/src/core.ts"],
    exceptions: {
      "frontend/src/components/CardNode.tsx": "same sandbox flags for the card's trusted-provider preview (see the <iframe> rule)",
    },
    sample: "<iframe {...EMBED_IFRAME_ATTRS} />",
  },
  "an embed's allow string is written once": {
    what: "the iframe `allow` string literal (@onden/markdown embedFrame.ts EMBED_IFRAME_ALLOW)",
    pattern: /accelerometer;\s*autoplay/,
    owners: ["markdown/src/embedFrame.ts"],
    sample: 'allow="accelerometer; autoplay; fullscreen"',
  },
  "which URL is an embed or a player is told by toEmbedUrl / classifyMedia": {
    what: "toEmbedUrl / classifyMedia calls (@onden/markdown mediaEmbed.ts)",
    pattern: /\b(?:toEmbedUrl|classifyMedia)\(/,
    owners: [...RENDERERS, "markdown/src/mediaEmbed.ts"],
    exceptions: {
      "backend/src/modules/rss/sanitize.ts": "RSS pre-processing: turns a feed's YouTube/Vimeo player into a link before sanitize would strip it",
      "frontend/src/components/CardNode.tsx": "the card's web preview asks whether a pasted URL is a trusted provider (then it frames the embed URL)",
    },
    sample: "const embed = toEmbedUrl(href);",
  },
  "a link to an uploaded SVG is drawn by rehypeMediaSvgLinks": {
    what: "the /media/*.svg pattern (@onden/markdown embedFrame.ts rehypeMediaSvgLinks)",
    pattern: /\\\/media\\\/\[\^\/\?#\]/,
    owners: ["markdown/src/embedFrame.ts"],
    sample: "/\\/media\\/[^/?#]+\\.svg/i",
  },
  "a feed body is rendered static, not cleaned up afterwards": {
    what: "a regex that cuts md-codeblock-copy out of rendered HTML (render with MarkdownRenderer `static`)",
    pattern: /replace\([^)]*md-codeblock-copy/,
    owners: [],
    sample: 'html.replace(/<button[^>]*\\bmd-codeblock-copy\\b/g, "")',
  },
};

describe.each(Object.entries(RULES))("%s", (_name, rule) => {
  it("only the owner does it", () => {
    expect(violations(FILES, rule), `${rule.what}: only ${rule.owners.join(", ") || "(nobody)"} may`).toEqual([]);
  });
  it("every owner and exception still matches (delete the ones that no longer do)", () => {
    expect(staleAllowances(FILES, rule)).toEqual([]);
  });
  it("the pattern catches a sample (a regex that matched nothing would pass for nothing)", () => {
    expect(rule.pattern.test(rule.sample)).toBe(true);
  });
});
