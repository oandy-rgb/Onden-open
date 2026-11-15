// The one rehype-sanitize schema for Onden Markdown (see index.ts): what HTML
// survives in a rendered note, on every surface. Before W38c the app and the
// backend exports each had a copy kept equal by a drift test.
//
// Extends the default (GitHub) schema with: the media-embed tags, data:
// media on src, the wikilink class, allowlisted classes on span/div/code
// (callouts, math, code language), the callout title paragraph, data-block-id / data-block-tags on the blocks an `^id` / `{tag}`
// anchors (the `[[#^id]]` scroll target, blocks.ts blockAnchors) and the task checkbox's `checked`.

import { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import { MEDIA_TAG_NAMES, mediaSanitizeAttributes } from "./mediaSanitize.js";
import { IMAGE_SCHEMES, LINK_SCHEMES } from "./urlSchemes.js";

// A definition of `className` earlier in a tag's list wins, so the default
// schema's own (code: language-*, a: data-footnote-backref) must be replaced,
// not appended to.
type AttrList = NonNullable<SanitizeSchema["attributes"]>[string];
const withoutClassName = (list: AttrList | undefined): AttrList =>
  (list ?? []).filter((def) => (Array.isArray(def) ? def[0] : def) !== "className");
// The elements remarkBlockId tags: what a paragraph, heading, list item,
// quote (or callout), list or table renders as.
const ANCHORED_TAGS = ["li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "table"] as const;
const withBlockId = Object.fromEntries(ANCHORED_TAGS.map((tag) => [tag, [...(defaultSchema.attributes?.[tag] ?? []), "dataBlockId", "dataBlockTags"]]));

/** What the sanitizer puts before every id a note's HTML carries (the
 *  default schema's clobberPrefix), so a note can't clobber the page's own
 *  DOM ids: a heading anchored `goals` is `<h2 id="user-content-goals">`, and
 *  a link to it must say so (headingAnchors.ts headingFragment). */
export const DOM_ID_PREFIX = defaultSchema.clobberPrefix ?? "user-content-";

export const sanitizeSchema: SanitizeSchema = {
  clobberPrefix: DOM_ID_PREFIX,
  ...defaultSchema,
  // Media-embed tags (video/audio/source/iframe). iframe is allowed at the
  // SCHEMA level but its host is gated to trusted https providers at render
  // time — see mediaSanitize.ts / mediaEmbed.ts.
  // u / mark: the editor's underline and highlight shortcuts write them.
  // figure / figcaption: an article's image caption stays an element of its own (no attributes), so it can be
  // styled as a caption instead of running into the text as a bare line.
  tagNames: [...(defaultSchema.tagNames ?? []), ...MEDIA_TAG_NAMES, "u", "mark", "figure", "figcaption"],
  // `data:` joins http/https on src so INLINE media plays: published Onden
  // sites (and so their RSS feeds) carry audio/images as data URIs, and the
  // reader/notes must render them. Safety: schema protocols can only express
  // the SCHEME, so the per-tag teeth live at render time — <iframe> requires
  // an https trusted host on every render path (a data: iframe is dropped),
  // and react-markdown's urlTransform only lets data:image|audio|video
  // through on src. An <img>/<audio>/<video> data: payload is inert content.
  protocols: {
    ...defaultSchema.protocols,
    href: [...LINK_SCHEMES],
    src: [...IMAGE_SCHEMES, "data"],
    // <video poster> is a URL too; it gets the same allowlist as src.
    poster: [...IMAGE_SCHEMES, "data"],
  },
  attributes: {
    ...defaultSchema.attributes,
    ...mediaSanitizeAttributes(defaultSchema.attributes),
    ...withBlockId,
    a: [...withoutClassName(defaultSchema.attributes?.a), ["className", "internal", "wikilink-token", "data-footnote-backref"]],
    // Classes only from an allowlist: the pipeline's own (callouts, math,
    // code language). Any class would let a note — or an RSS article — dress
    // itself in the app's CSS (`fixed inset-0 z-50`, a fake dialog).
    span: [...(defaultSchema.attributes?.span ?? []), ["className", /^math-/]],
    div: [...(defaultSchema.attributes?.div ?? []), "dataBlockId", "dataBlockTags", ["className", "callout", /^callout-[a-z]+$/, /^math-/]],
    code: [...withoutClassName(defaultSchema.attributes?.code), ["className", /^language-./, /^math-/]],
    p: [...(defaultSchema.attributes?.p ?? []), "dataBlockId", "dataBlockTags", ["className", "callout-title"]],
    // A folded callout (`[!tip]-`, `[!tip]+`) is a <details> with a <summary> title.
    details: [...(defaultSchema.attributes?.details ?? []), "open", "dataBlockId", "dataBlockTags", ["className", "callout", /^callout-[a-z]+$/]],
    summary: [...(defaultSchema.attributes?.summary ?? []), ["className", "callout-title"]],
    // GFM task-list checkbox: the default schema allows `disabled` + `type` but
    // strips `checked`, so a `- [x]` rendered through the raw pipeline lost its
    // checked state. Allow `checked` so MarkdownRenderer's `input` component
    // receives it (and the interactive checkbox shows the right state).
    input: [...(defaultSchema.attributes?.input ?? []), "checked"],
  },
};
