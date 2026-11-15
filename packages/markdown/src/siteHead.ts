// The published site's <head>, built in ONE place (D29a).
//
// Two hosts render the same site and both ship this head: the server-rendered
// /site pages (SiteHead.astro) and the GitHub Pages SPA deploy (the backend's
// seoFiles.ts rewrites the bundle's index.html). Each used to keep its own
// copy, and the copies drifted (<html lang>, og:type, og:url, the description
// fallback). Both now call siteHead() and serialise the result with
// renderHeadTags(), so a tag added here lands on both.
//
// Pure data in, data out: no DOM, no Node APIs — the Astro server, the backend
// and the tests all import it. What is particular to one host stays with that
// host (the Pages deploy's meta-CSP, which needs node:crypto for the ga4 hash;
// the SSR pages' response headers).

import { escapeHtml } from "./html.js";

/** The manifest.site settings the head reads (Design tab → workspace config). */
export type SiteHeadSite = {
  brand?: string;
  tagline?: string;
  description?: string;
  favicon?: string;
  /** false → noindex, nofollow. Absent counts as allowed. */
  allow_indexing?: boolean;
  analytics_provider?: string;
  analytics_id?: string;
  /** The site chrome locale the Design tab stores: "zh-TW" | "en" | "ja". */
  locale?: string;
};

/** "index": the site root or a listing (a collection's page) → og:type website.
 *  "article": one note or collection item → og:type article. */
export type SiteHeadVariant = "index" | "article";

export type SiteHeadOptions = {
  pageTitle: string;
  /** Page-specific description; falls back to the site description, then the tagline. */
  description?: string;
  /** Absolute URL of this page; emits rel=canonical and og:url. */
  canonical?: string;
  variant: SiteHeadVariant;
  /** Where this host serves the RSS feed / sitemap, when it serves them. */
  feed?: string;
  sitemap?: string;
  /** The picture a link to this page shows when shared: an absolute URL, and
   *  what it shows in words. Without one the card is the small summary kind. */
  image?: { url: string; alt?: string };
};

/** One head element as plain data — serialisable, comparable in tests. */
export type HeadTag = {
  tag: "meta" | "link" | "title" | "script";
  /** Attribute order is kept; `true` renders a bare boolean attribute. */
  attrs: Record<string, string | true>;
  /** Text content (title, inline script). */
  text?: string;
};

/** The languages a published site can be in, with the label Settings › Website
 *  shows (each in its own language). The one list: the settings dropdown, the
 *  site chrome dictionary's type and every `<html lang>` read it. */
export const SITE_LOCALES = [
  { value: "zh-TW", label: "繁體中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
] as const;
export type SiteLocale = (typeof SITE_LOCALES)[number]["value"];
const DEFAULT_SITE_LANG: SiteLocale = "zh-TW";

/** `<html lang>` for a site locale. The stored value is already a valid BCP 47
 *  tag (zh-TW = Chinese as written in Taiwan, which is what the 繁體中文 option
 *  means), so it is used as is; a missing or unknown value falls back to the
 *  Design tab's own default, zh-TW. */
export function siteLang(locale?: string): string {
  return SITE_LOCALES.find((l) => l.value === locale)?.value ?? DEFAULT_SITE_LANG;
}


/** A GA4 measurement id. Only such an id is put into the inline bootstrap
 *  (and the CSP hash of it): anything else — a stray backslash, a quote, a
 *  newline — would be code inside the script, so no GA4 tags are emitted. */
export function isGa4Id(id: string): boolean {
  return /^G-[A-Z0-9]{4,20}$/.test(id);
}

/** The ga4 inline bootstrap for a valid id (isGa4Id). The Pages deploy's CSP
 *  allows it by sha256 hash, computed over THIS string, so the emitted text
 *  and the hash stay one. */
export function ga4InlineScript(id: string): string {
  return `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("js",new Date());gtag("config",${JSON.stringify(id)});`;
}

function analyticsTags(site: SiteHeadSite): HeadTag[] {
  const provider = site.analytics_provider ?? "";
  const id = site.analytics_id ?? "";
  if (!id) return [];
  if (provider === "plausible") {
    return [{ tag: "script", attrs: { defer: true, "data-domain": id, src: "https://plausible.io/js/script.js" } }];
  }
  if (provider === "umami") {
    return [{ tag: "script", attrs: { defer: true, src: "https://cloud.umami.is/script.js", "data-website-id": id } }];
  }
  if (provider === "ga4" && isGa4Id(id)) {
    return [
      { tag: "script", attrs: { async: true, src: `https://www.googletagmanager.com/gtag/js?id=${id}` } },
      { tag: "script", attrs: {}, text: ga4InlineScript(id) },
    ];
  }
  return [];
}

/** The published site's head tags for one page, in document order. */
export function siteHead(site: SiteHeadSite, opts: SiteHeadOptions): HeadTag[] {
  const { pageTitle, variant, feed, sitemap } = opts;
  const { canonical } = opts;
  const desc = opts.description || site.description || site.tagline || "";
  const brand = site.brand ?? "";
  const meta = (attrs: HeadTag["attrs"]): HeadTag => ({ tag: "meta", attrs });
  const link = (attrs: HeadTag["attrs"]): HeadTag => ({ tag: "link", attrs });
  const tags: HeadTag[] = [
    meta({ charset: "UTF-8" }),
    meta({ name: "viewport", content: "width=device-width, initial-scale=1" }),
    { tag: "title", attrs: {}, text: pageTitle },
  ];
  if (desc) tags.push(meta({ name: "description", content: desc }));
  if (canonical) tags.push(link({ rel: "canonical", href: canonical }));
  if (feed) tags.push(link({ rel: "alternate", type: "application/rss+xml", title: brand || "RSS", href: feed }));
  if (sitemap) tags.push(link({ rel: "sitemap", href: sitemap }));
  if (site.favicon) tags.push(link({ rel: "icon", href: site.favicon }));
  if (site.allow_indexing === false) tags.push(meta({ name: "robots", content: "noindex, nofollow" }));
  tags.push(meta({ property: "og:title", content: pageTitle }));
  if (desc) tags.push(meta({ property: "og:description", content: desc }));
  tags.push(meta({ property: "og:type", content: variant === "index" ? "website" : "article" }));
  if (canonical) tags.push(meta({ property: "og:url", content: canonical }));
  if (brand) tags.push(meta({ property: "og:site_name", content: brand }));
  const { image } = opts;
  if (image?.url) {
    tags.push(meta({ property: "og:image", content: image.url }));
    if (image.alt) tags.push(meta({ property: "og:image:alt", content: image.alt }));
  }
  tags.push(meta({ name: "twitter:card", content: image?.url ? "summary_large_image" : "summary" }));
  tags.push(...analyticsTags(site));
  return tags;
}

function renderHeadTag({ tag, attrs, text }: HeadTag): string {
  const a = Object.entries(attrs)
    .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${escapeHtml(v)}"`))
    .join("");
  if (tag === "meta" || tag === "link") return `<${tag}${a} />`;
  // A script's text is raw (escaping would change the code and its CSP hash);
  // only a closing-tag sequence is neutralised. A title's text is escaped.
  const body = tag === "script" ? (text ?? "").replace(/<\/(script)/gi, "<\\/$1") : escapeHtml(text ?? "");
  return `<${tag}${a}>${body}</${tag}>`;
}

/** Serialise head tags as HTML, one per line (joined with `sep`). */
export function renderHeadTags(tags: HeadTag[], sep = "\n"): string {
  return tags.map(renderHeadTag).join(sep);
}
