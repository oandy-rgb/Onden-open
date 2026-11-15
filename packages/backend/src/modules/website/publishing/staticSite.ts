// The static copy of the published site — the one output both the zip download
// (GET /api/export-static) and the GitHub Pages push (pagesPush.ts) save.
//
// Every page is the SAME server-rendered HTML the live /site/ serves: this
// module asks the frontend SSR server (SITE_SSR_URL) for each page, so there is
// no second renderer to drift. The SSR server reads the served site
// (servedSite.ts: the latest snapshot minus takedowns) itself, so the copy can
// never show more than the site does. What this module adds is the part a
// server does for a live page and a folder cannot:
//   - the CSS and fonts the pages link (/_astro/*), fetched from the same server;
//   - every /site/… and /_astro/… address rewritten to a path relative to the
//     page, so the folder works from a zip, any static host and a Pages subpath;
//   - images and files (/api/media/…) bundled by bundleSiteFiles, as before.
// The copy is made ONCE per served site and stored (siteBundle.ts); the zip and
// the Pages push read the stored files. The Pages address is applied to the
// stored files afterwards (retargetStaticSite), so it costs no second crawl.

import { compareText } from "@onden/markdown";
import { posix } from "node:path";
import { publishedCspMetaTag } from "./htmlUtils.js";
import { bundleSiteFiles } from "./mediaBundle.js";
import type { BundleFile } from "./githubPages.js";
import { config } from "../../../config.js";

/** The frontend SSR server could not give a page the copy needs. */
export class StaticSiteUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaticSiteUnavailable";
  }
}

export type StaticSiteOptions = {
  workspaceId: string;
  ssrUrl?: string;
  fetchImpl?: typeof fetch;
};

/** What retargetStaticSite needs to know about the copy it was made from. */
export type StaticSiteFacts = {
  /** The live site's origin, as written into canonical links, sitemap and feed. */
  liveOrigin: string;
  allowIndexing: boolean;
  analytics?: { provider?: string; id?: string };
};

export type StaticSite = { files: BundleFile[]; facts: StaticSiteFacts };

/** Where the search index sits in the copy and on the live site
 *  (`/site/search.idx/…`, served by the frontend from the stored copy). A slug
 *  never holds a dot, so no note can take the address. */
export const SEARCH_INDEX_DIR = "site/search.idx";

/** The frontend SSR server the pages are asked from. */
export function ssrBaseUrl(): string {
  return (config.str("SITE_SSR_URL")?.trim() || "http://localhost:4321").replace(/\/+$/, "");
}

// Not a slug a note can have (slugs are lowercase words and hyphens), so the
// frontend answers its 404 page in the site's own frame.
const NOT_FOUND_PROBE = "/site/_not-found_/";
const FETCH_CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 30_000;
// Old formats of a font family that lists a woff2 first: every browser that
// can open the copy picks the woff2, so the others stay out of the zip.
const SKIPPED_ASSET = /\.(?:woff|ttf|eot)$/i;
const ASSET_REF = /\/_astro\/[\w.@-]+/g;
// The app's own font files (public/fonts), which the site stylesheet names from the root.
const FONT_REF = /\/fonts\/[\w.@-]+\.woff2\b/g;
// Files a script or stylesheet may name (a lazy chunk, a font).
const ASSET_NAME = /[\w.@-]+\.(?:m?js|css|woff2)\b/g;

const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

/** Path of a page's file in the copy: `/site/` → `site/index.html`,
 *  `/site/a/` → `site/a/index.html`, `/site/feed.xml` → `site/feed.xml`. */
export function pageFile(pagePath: string): string {
  const path = pagePath.replace(/^\//, "");
  if (path.endsWith("/")) return `${path}index.html`;
  return path.includes(".", path.lastIndexOf("/") + 1) ? path : `${path}/index.html`;
}

/** The address a link written for the live site has in the copy: relative to
 *  the file it sits in (`from`), or under `absoluteBase` for the 404 page,
 *  which a host serves at any depth. Anything that is not a page or asset of
 *  the site (media, other hosts) stays as it is. */
export function localizeRef(ref: string, from: string, absoluteBase?: string | null): string {
  const cut = ref.search(/[?#]/);
  const path = cut < 0 ? ref : ref.slice(0, cut);
  const rest = cut < 0 ? "" : ref.slice(cut);
  let target: string;
  if (path.startsWith(`/${SEARCH_INDEX_DIR}/`)) {
    target = path.slice(1); // a folder of files, not a page
  } else if (path === "/site" || path.startsWith("/site/")) {
    let decoded = path;
    try { decoded = decodeURI(path); } catch { /* keep the raw path */ }
    target = pageFile(decoded);
  } else if (path.startsWith("/_astro/")) {
    target = path.slice(1);
  } else {
    return ref;
  }
  const where = absoluteBase
    ? `${absoluteBase.replace(/\/*$/, "/")}${encodePath(target)}`
    : encodePath(posix.relative(posix.dirname(from), target));
  return where + rest;
}

/** The page with its Content-Security-Policy as a meta tag (a static host sets
 *  no headers): scripts only from the copy itself, its own inline ones by hash,
 *  and the analytics host the owner opted into. The second belt behind the
 *  sanitizer, as every published page has had. */
export function withCsp(html: string, analytics: { provider?: string; id?: string } | undefined): string {
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");
  const inlineScripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  return html.replace("<head>", `<head>${publishedCspMetaTag({ variant: "spa", analytics, inlineScripts })}`);
}

const ATTR_REF = /(\s(?:href|src|poster)=)"(\/(?!\/)[^"]*)"/g;

/** A page's HTML with every site address made relative (see localizeRef). */
export function localizeHtml(html: string, from: string, absoluteBase?: string | null): string {
  return html
    .replace(ATTR_REF, (_all, attr: string, ref: string) => `${attr}"${localizeRef(ref, from, absoluteBase)}"`)
    // a script's lazy imports are relative already; only an inline module's
    // own /_astro/ strings need the page's depth
    .replace(/(<script type="module">)([\s\S]*?)(<\/script>)/g, (_all, open: string, body: string, close: string) =>
      `${open}${body.replace(ASSET_REF, (m) => localizeRef(m, from))}${close}`);
}

/** The site's addresses a copied file still holds in the form that only works
 *  on the live host (a leftover is a bug, and tests assert there are none). */
export function liveOnlyRefs(html: string): string[] {
  return [...html.matchAll(/(?:href|src|poster)="(\/(?:site|_astro)(?:\/[^"]*)?)"/g)].map((m) => m[1]);
}

/** Vite's preload helper names a chunk's dependencies from the live root
 *  (`"/"+dep`, dep = `_astro/x.js`) to warm them up. Beside the pages the root
 *  is wherever the folder is hosted, so the helper resolves them from its own
 *  place instead; the chunks themselves import each other relatively. */
function localizeScript(js: string): string {
  return js.replace(/function\((\w+)\)\{return"\/"\+\1\}/g, 'function($1){return new URL("../"+$1,import.meta.url).href}');
}

/** A stylesheet next to the pages' assets: its fonts are named from the live
 *  root; in the copy they sit beside it. */
function localizeCss(css: string): string {
  return css
    .replace(/url\(\s*(["']?)\/_astro\//g, "url($1./")
    .replace(/url\(\s*(["']?)\/fonts\//g, "url($1../fonts/");
}

async function pool<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await run(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, items.length) }, worker));
}

/** Crawl the frontend once: the copy as the live site would serve it, plus the
 *  facts retargetStaticSite needs. Does not know where it will be hosted. */
export async function buildStaticSite(opts: StaticSiteOptions): Promise<StaticSite> {
  const base = (opts.ssrUrl ?? ssrBaseUrl()).replace(/\/+$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const get = async (path: string, expect: number[] = [200]): Promise<Response> => {
    let res: Response;
    try {
      res = await doFetch(`${base}${encodePath(path)}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      throw new StaticSiteUnavailable(`cannot reach the site renderer at ${base} (${e instanceof Error ? e.message : String(e)})`);
    }
    if (!expect.includes(res.status)) {
      await res.body?.cancel().catch(() => {});
      throw new StaticSiteUnavailable(`the site renderer answered ${res.status} for ${path}`);
    }
    return res;
  };

  const listing = (await (await get("/site/static-pages.json")).json()) as {
    pages?: string[]; feeds?: string[]; redirects?: unknown; origin?: string; allowIndexing?: boolean; analytics?: { provider?: string; id?: string };
  };
  const pagePaths = listing.pages ?? [];
  const liveOrigin = listing.origin ?? "";

  const pages: BundleFile[] = [];
  await pool(pagePaths, async (path) => {
    pages.push({ path: pageFile(path), content: await (await get(path)).text() });
  });
  const notFound = await get(NOT_FOUND_PROBE, [404]);
  const notFoundHtml = await notFound.text();

  const feed = await (await get("/site/feed.xml")).text();
  // One feed per tag page (the 「只訂閱這個標籤」 link), saved at the same path under the copy.
  const tagFeeds: BundleFile[] = [];
  await pool(listing.feeds ?? [], async (path) => {
    tagFeeds.push({ path: path.replace(/^\//, ""), content: await (await get(path)).text() });
  });
  tagFeeds.sort((a, b) => compareText(a.path, b.path));
  const sitemap = await (await get("/site/sitemap.xml")).text();

  // The pages in a stable order (the walk above finished in any order).
  pages.sort((a, b) => compareText(a.path, b.path));
  const html: BundleFile[] = [
    ...pages.map((p) => ({ path: p.path, content: withCsp(localizeHtml(p.content as string, p.path), listing.analytics) })),
    // The 404 page is served at any depth: relative to the root here, and
    // made absolute when the copy has an address (retargetStaticSite).
    { path: "404.html", content: withCsp(localizeHtml(notFoundHtml, "404.html"), listing.analytics) },
  ];
  // A renamed page's old address: a small page that sends the reader on (a
  // static host has no server redirect). Never over a page the copy has.
  const pageFiles = new Set(html.map((f) => f.path));
  for (const { from, to } of redirectsOf(listing.redirects)) {
    const file = pageFile(from);
    if (pageFiles.has(file)) continue;
    pageFiles.add(file);
    html.push({ path: file, content: withCsp(redirectPage(localizeRef(to, file), `${liveOrigin}${encodePath(to)}`), listing.analytics) });
  }

  // Stylesheets, fonts and scripts the pages name, and what those name in turn.
  const assets = new Map<string, BundleFile>();
  const queue = new Set<string>();
  const enqueue = (text: string, pattern: RegExp, toPath: (m: string) => string) => {
    for (const m of text.match(pattern) ?? []) queue.add(toPath(m));
  };
  for (const page of [...pages, { path: "404.html", content: notFoundHtml }]) {
    enqueue(page.content as string, ASSET_REF, (m) => m);
  }
  while (queue.size > 0) {
    const batch = [...queue];
    queue.clear();
    await pool(batch, async (path) => {
      if (assets.has(path) || SKIPPED_ASSET.test(path)) return;
      const res = await get(path, [200, 404]);
      // A name a script merely mentions that is not a file: nothing to copy.
      if (res.status !== 200) { assets.set(path, { path: "", content: "" }); return; }
      const bytes = Buffer.from(await res.arrayBuffer());
      const name = path.slice(1);
      if (/\.css$/i.test(path)) {
        const css = bytes.toString("utf8");
        enqueue(css, ASSET_REF, (m) => m);
        enqueue(css, FONT_REF, (m) => m);
        assets.set(path, { path: name, content: Buffer.from(localizeCss(css)) });
      } else if (/\.m?js$/i.test(path)) {
        const js = bytes.toString("utf8");
        enqueue(js, ASSET_NAME, (m) => `/_astro/${m}`);
        assets.set(path, { path: name, content: Buffer.from(localizeScript(js)) });
      } else {
        assets.set(path, { path: name, content: bytes });
      }
    });
  }

  // Only content goes through the media pass (its references are data).
  const withMedia = await bundleSiteFiles(html, opts.workspaceId);

  const facts: StaticSiteFacts = { liveOrigin, allowIndexing: listing.allowIndexing !== false, analytics: listing.analytics };
  return {
    facts,
    files: [
      ...withMedia,
      { path: "site/feed.xml", content: feed },
      ...tagFeeds,
      { path: "site/sitemap.xml", content: sitemap },
      ...[...assets.values()].filter((f) => f.path !== ""),
      // The address of a bare host or Pages root opens the home page. Relative,
      // so it works under a Pages project subpath.
      { path: "index.html", content: redirectToSite() },
      { path: "robots.txt", content: robotsTxt(facts.allowIndexing, null) },
      // Pages must not run Jekyll over the copy (it drops `_astro`).
      { path: ".nojekyll", content: "" },
    ],
  };
}

// A shared-link picture that lives on the site: bundleSiteFiles already made it
// the copy's own `media/<id>` (relative to the page), which a crawler cannot
// resolve; once the copy has an address it names it in full.
const OG_IMAGE_IN_COPY = /(<meta property="og:image" content=")(?:\.\.\/)*media\//g;

const RELATIVE_ATTR = /(\s(?:href|src|poster)=)"(?![a-z][a-z0-9+.-]*:|\/|#)([^"]*)"/gi;

/** The copy as it is hosted at `publicBase` (the Pages URL, with a trailing
 *  slash), made from the stored files without another crawl: the live origin
 *  in canonical links, sitemap and feed becomes the copy's own, the 404 page —
 *  which a host answers at any depth — points at absolute addresses, and
 *  robots.txt names the sitemap. Html files get their meta CSP recomputed, as a
 *  changed address can sit in an inline script. With no `publicBase` the files
 *  are returned as they are. */
export function retargetStaticSite({ files, facts }: StaticSite, publicBase: string | null): BundleFile[] {
  if (!publicBase) return files;
  const base = publicBase.replace(/\/*$/, "/");
  const reorigin = (text: string): string =>
    facts.liveOrigin
      ? text.replaceAll(`${facts.liveOrigin}/site/`, `${base}site/`).replaceAll(`${facts.liveOrigin}/api/media/`, `${base}media/`)
      : text;
  return files.map((file) => {
    if (typeof file.content !== "string") return file;
    if (file.path === "robots.txt") return { ...file, content: robotsTxt(facts.allowIndexing, base) };
    if (file.path.endsWith(".xml")) return { ...file, content: reorigin(file.content) };
    if (!file.path.endsWith(".html") || file.path === "index.html") return file; // the root redirect has no head to guard
    let html = reorigin(file.content).replace(OG_IMAGE_IN_COPY, (_all, open: string) => `${open}${base}media/`);
    if (file.path === "404.html") {
      html = html.replace(RELATIVE_ATTR, (_all, attr: string, ref: string) => `${attr}"${base}${ref}"`);
    }
    return { ...file, content: withCsp(html, facts.analytics) };
  });
}

/** The listing's `redirects` (`{ from, to }`, both `/site/…/` addresses), the rest left out. */
function redirectsOf(value: unknown): Array<{ from: string; to: string }> {
  if (!Array.isArray(value)) return [];
  return value.filter((r): r is { from: string; to: string } => !!r && typeof r === "object"
    && typeof r.from === "string" && typeof r.to === "string" && r.from.startsWith("/site/") && r.to.startsWith("/site/")
    && !r.from.includes("..") && !r.to.includes(".."));
}

const attr = (value: string): string => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The page at a renamed page's old address in the copy (GAP-240): goes on to
 *  `target` (relative to it), names `canonical` as the page, and is neither
 *  indexed by search engines nor by the site search. */
export function redirectPage(target: string, canonical: string): string {
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="refresh" content="0;url=${attr(target)}">`
    + `<link rel="canonical" href="${attr(canonical)}"><meta name="robots" content="noindex"><title>Moved</title></head>`
    + `<body data-pagefind-ignore="all"><a href="${attr(target)}">${attr(target)}</a></body></html>`;
}

function redirectToSite(): string {
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="refresh" content="0;url=site/index.html"><title>Redirecting…</title></head><body><a href="site/index.html">site/</a></body></html>`;
}

/** robots.txt: disallow-all when the site's "allow indexing" setting is off
 *  (the pages carry the same rule as a robots meta), else allow and name the sitemap. */
function robotsTxt(allowIndexing: boolean, publicBase: string | null): string {
  if (!allowIndexing) return "User-agent: *\nDisallow: /\n";
  return `User-agent: *\nAllow: /\n${publicBase ? `\nSitemap: ${publicBase}site/sitemap.xml\n` : ""}`;
}
