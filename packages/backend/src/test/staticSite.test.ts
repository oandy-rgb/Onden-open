// The static copy (modules/website/publishing/staticSite.ts): every page of the site
// as the SSR HTML the frontend serves, with the CSS and fonts it links, every
// address relative. The renderer is a stand-in server that answers the
// frontend's contract (static-pages.json, the pages, /_astro/*); the media
// pass and the access settings are the database's, mocked here and covered in
// pagesPush.integration.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

vi.mock("../modules/website/publishing/mediaBundle.js", () => ({ bundleSiteFiles: async (files: unknown[]) => files }));

import {
  buildStaticSite, localizeHtml, localizeRef, liveOnlyRefs, pageFile, redirectPage, retargetStaticSite, StaticSiteUnavailable,
} from "../modules/website/publishing/staticSite.js";

type Reply = { status?: number; type?: string; body: string | Buffer };

/** A renderer answering for `routes`; anything else is the 404 page. */
function renderer(routes: Record<string, Reply>): { fetchImpl: typeof fetch; asked: string[] } {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    asked.push(`${url.pathname}${url.search}`);
    const hit = routes[decodeURIComponent(url.pathname)];
    const r = hit ?? { status: 404, body: "<html><body>nothing</body></html>" };
    return new Response(r.body as BodyInit, { status: r.status ?? 200, headers: { "content-type": r.type ?? "text/html" } });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

const page = (title: string, body = "") =>
  `<!DOCTYPE html><html class="onden-site"><head><meta charset="UTF-8" /><title>${title}</title>` +
  `<link rel="canonical" href="https://live.example/site/x/" />` +
  `<link rel="alternate" type="application/rss+xml" href="/site/feed.xml" />` +
  `<link rel="stylesheet" href="/_astro/site.AAA.css"></head><body>` +
  `<a href="/site/">home</a> <a href="/site/%E6%96%87%E7%AB%A0-%E4%B8%80#top">post</a> <a href="/site/tag/%E8%8A%B1/">tag</a>` +
  `<img src="/api/media/pic.png" alt="">${body}` +
  `<script type="module">document.documentElement.classList.add("s-js");</script></body></html>`;

const site = (extra: Record<string, Reply> = {}, pages = ["/site/", "/site/文章-一/", "/site/tag/花/"]) => renderer({
  "/site/static-pages.json": { type: "application/json", body: JSON.stringify({ pages, origin: "https://live.example", allowIndexing: true }) },
  "/site/": { body: page("Home") },
  "/site/文章-一/": { body: page("Post") },
  "/site/tag/花/": { body: page("Tag") },
  "/site/_not-found_/": { status: 404, body: page("Not found") },
  "/site/feed.xml": { type: "application/rss+xml", body: `<rss><link>https://live.example/site/</link><img src="https://live.example/api/media/pic.png"/></rss>` },
  "/site/sitemap.xml": { type: "application/xml", body: `<urlset><loc>https://live.example/site/文章-一/</loc></urlset>` },
  "/_astro/site.AAA.css": {
    type: "text/css",
    body: "@font-face{src:url(/_astro/f.BBB.woff2) format('woff2'),url(/_astro/f.CCC.woff) format('woff')}body{color:red}",
  },
  "/_astro/f.BBB.woff2": { type: "font/woff2", body: Buffer.from([1, 2, 3]) },
  ...extra,
});

/** The copy as a zip holds it, or — with a `publicBase` — as the Pages push does. */
const run = async (r: ReturnType<typeof renderer>, publicBase?: string | null) =>
  retargetStaticSite(await buildStaticSite({ workspaceId: "ws", ssrUrl: "http://frontend", fetchImpl: r.fetchImpl }), publicBase ?? null);
const text = (files: Array<{ path: string; content: string | Buffer }>, path: string) =>
  String(files.find((f) => f.path === path)?.content);

afterEach(() => vi.restoreAllMocks());

describe("the page set", () => {
  it("holds every page the renderer lists, its 404, the feed and the sitemap — and nothing else", async () => {
    const files = await run(site());
    expect(files.map((f) => f.path).sort()).toEqual([
      ".nojekyll", "404.html", "_astro/f.BBB.woff2", "_astro/site.AAA.css", "index.html", "robots.txt",
      "site/feed.xml", "site/index.html", "site/sitemap.xml", "site/tag/花/index.html", "site/文章-一/index.html",
    ]);
  });

  it("saves each tag's own feed next to the site feed, with the copy's address like the rest", async () => {
    const feeds = ["/site/tag/花/feed.xml"];
    const r = site({
      "/site/static-pages.json": { type: "application/json", body: JSON.stringify({ pages: ["/site/", "/site/tag/花/"], feeds, origin: "https://live.example", allowIndexing: true }) },
      "/site/tag/花/feed.xml": { type: "application/rss+xml", body: `<rss><link>https://live.example/site/tag/花/</link></rss>` },
    });
    const files = await run(r);
    expect(files.map((f) => f.path)).toContain("site/tag/花/feed.xml");
    expect(text(files, "site/tag/花/feed.xml")).toContain("<rss>");
    expect(text(await run(r, "https://me.github.io/garden/"), "site/tag/花/feed.xml")).toContain("https://me.github.io/garden/site/tag/花/");
  });

  it("a note the renderer does not list (taken down) has no page, whatever the snapshot held", async () => {
    const files = await run(site({ "/site/gone/": { body: page("Gone") } }));
    expect(files.some((f) => f.path.includes("gone"))).toBe(false);
  });

  it("asks for the pages exactly as the live site serves them", async () => {
    const r = site();
    await run(r);
    expect(r.asked.length).toBeGreaterThan(0);
    for (const a of r.asked) expect(a).not.toContain("static=1");
  });

  it("fails clearly when the renderer is down or a listed page is missing", async () => {
    const down = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
    await expect(buildStaticSite({ workspaceId: "ws", ssrUrl: "http://frontend", fetchImpl: down })).rejects.toBeInstanceOf(StaticSiteUnavailable);
    const r = site({}, ["/site/", "/site/missing/"]);
    await expect(run(r)).rejects.toThrow(/404 for \/site\/missing\//);
  });

  it("refuses to save a 404 page that answers 200", async () => {
    await expect(run(site({ "/site/_not-found_/": { body: page("A real note") } }))).rejects.toThrow(/answered 200/);
  });
});

describe("addresses", () => {
  it("every /site/ and /_astro/ address is relative to its page, at every depth", async () => {
    const files = await run(site());
    for (const f of files.filter((x) => x.path.endsWith(".html"))) {
      expect(liveOnlyRefs(String(f.content)), f.path).toEqual([]);
    }
    const home = text(files, "site/index.html");
    expect(home).toContain('href="index.html"');
    expect(home).toContain('href="%E6%96%87%E7%AB%A0-%E4%B8%80/index.html#top"');
    expect(home).toContain('href="tag/%E8%8A%B1/index.html"');
    expect(home).toContain('href="feed.xml"');
    expect(home).toContain('href="../_astro/site.AAA.css"');
    const deep = text(files, "site/tag/花/index.html");
    expect(deep).toContain('href="../../index.html"');
    expect(deep).toContain('href="../../../_astro/site.AAA.css"');
    expect(deep).toContain('href="../../%E6%96%87%E7%AB%A0-%E4%B8%80/index.html#top"');
  });

  it("media addresses are left for the media pass, other hosts untouched", () => {
    const html = `<img src="/api/media/a.png"><a href="https://x.test/site/">x</a><a href="//cdn.test/site/">y</a>`;
    expect(localizeHtml(html, "site/a/index.html")).toBe(html);
  });

  it("pageFile and localizeRef follow the files a host serves", () => {
    expect(pageFile("/site/")).toBe("site/index.html");
    expect(pageFile("/site/a/")).toBe("site/a/index.html");
    expect(pageFile("/site/a")).toBe("site/a/index.html");
    expect(pageFile("/site/feed.xml")).toBe("site/feed.xml");
    expect(localizeRef("/site/a?x=1#h", "site/b/index.html")).toBe("../a/index.html?x=1#h");
    expect(localizeRef("/_astro/x.css", "404.html")).toBe("_astro/x.css");
    // the search index is a folder, not a page: no index.html appended
    expect(localizeRef("/site/search.idx/", "site/a/index.html")).toBe("../search.idx");
    expect(localizeRef("/site/search.idx/", "site/index.html")).toBe("search.idx");
    expect(localizeRef("/site/search.idx/", "site/tag/x/index.html")).toBe("../../search.idx");
  });

  it("the 404 page, served at any depth, points at the copy's own address when it has one", async () => {
    const files = await run(site(), "https://me.github.io/garden/");
    const nf = text(files, "404.html");
    expect(nf).toContain('href="https://me.github.io/garden/site/index.html"');
    expect(nf).toContain('href="https://me.github.io/garden/_astro/site.AAA.css"');
    expect(liveOnlyRefs(nf)).toEqual([]);
  });
});

describe("assets", () => {
  it("copies the stylesheet with its fonts beside it, and leaves out the old font formats", async () => {
    const files = await run(site());
    const css = text(files, "_astro/site.AAA.css");
    expect(css).toContain("url(./f.BBB.woff2)");
    expect(css).not.toContain("url(/_astro/");
    expect(files.some((f) => f.path.endsWith(".woff"))).toBe(false);
    expect(files.find((f) => f.path === "_astro/f.BBB.woff2")!.content).toEqual(Buffer.from([1, 2, 3]));
  });

  it("copies the app's own fonts (public/fonts, named from the root) and points the stylesheet at them", async () => {
    const files = await run(site({
      "/_astro/site.AAA.css": { type: "text/css", body: "@font-face{src:url(/fonts/plex-sans-400.woff2) format('woff2')}body{color:red}" },
      "/fonts/plex-sans-400.woff2": { type: "font/woff2", body: Buffer.from([4, 5, 6]) },
    }));
    const css = text(files, "_astro/site.AAA.css");
    expect(css).toContain("url(../fonts/plex-sans-400.woff2)");
    expect(css).not.toContain("url(/fonts/");
    expect(files.find((f) => f.path === "fonts/plex-sans-400.woff2")!.content).toEqual(Buffer.from([4, 5, 6]));
  });

  it("follows a script's lazy chunks, and skips a name that is not a file", async () => {
    const withDiagrams = page("Home", `<script type="module" src="/_astro/d.js"></script>`);
    const files = await run(site({
      "/site/": { body: withDiagrams },
      "/_astro/d.js": { type: "text/javascript", body: `import("./chunk-1.js");const x="not-a-file.js";` },
      "/_astro/chunk-1.js": { type: "text/javascript", body: `import("./chunk-2.js")` },
      "/_astro/chunk-2.js": { type: "text/javascript", body: `export default 1` },
    }));
    const paths = files.map((f) => f.path);
    for (const p of ["_astro/d.js", "_astro/chunk-1.js", "_astro/chunk-2.js"]) expect(paths).toContain(p);
    expect(paths).not.toContain("_astro/not-a-file.js");
    expect(text(files, "site/index.html")).toContain('src="../_astro/d.js"');
  });

  it("a script's preload helper resolves its chunks from its own place, not the host root", async () => {
    const files = await run(site({
      "/site/": { body: page("Home", `<script type="module" src="/_astro/p.js"></script>`) },
      "/_astro/p.js": { type: "text/javascript", body: `const v=function(l){return"/"+l},y=1;` },
    }));
    expect(text(files, "_astro/p.js")).toBe(`const v=function(l){return new URL("../"+l,import.meta.url).href},y=1;`);
  });

  it("a site without diagrams ships no script file", async () => {
    const files = await run(site());
    expect(files.filter((f) => f.path.endsWith(".js"))).toEqual([]);
  });
});

// An article page as the renderer serves it with link previews and a shared-link picture.
const PREVIEW_SCRIPT = `const e=document.getElementById("s-previews");if(e&&1<2){const n=JSON.parse(e.textContent||"{}");document.body.dataset.p=Object.keys(n.notes||{}).join("，")}`;
const PREVIEW_DATA = JSON.stringify({ labels: { open: "打開這篇" }, notes: { a: { title: "甲 \u003c b", summary: "摘要" } } });
const articleWithPreview = (ogImage: string) =>
  page("Post").replace("</head>", `<meta property="og:image" content="${ogImage}" /><meta name="twitter:card" content="summary_large_image" /></head>`)
    .replace("</body>", `<a href="/site/a" data-note="a">甲</a><script type="application/json" id="s-previews">${PREVIEW_DATA}</script><script type="module">${PREVIEW_SCRIPT}</script></body>`);
const sha = (inline: string) => `'sha256-${createHash("sha256").update(inline).digest("base64")}'`;

describe("link previews and the shared-link picture in the copy", () => {
  it("the CSP allows the preview script by hash, and the copy keeps its data and attributes", async () => {
    const files = await run(site({ "/site/文章-一/": { body: articleWithPreview("https://live.example/api/media/cover.png") } }));
    const post = text(files, "site/文章-一/index.html");
    expect(post).toContain(sha(PREVIEW_SCRIPT));
    expect(post).toContain(`<script type="application/json" id="s-previews">${PREVIEW_DATA}</script>`);
    expect(post).toContain('data-note="a"');
    expect(post.match(/Content-Security-Policy/g)).toHaveLength(1);
    // the preview data holds no address of the live site, so nothing in it needs rewriting
    expect(PREVIEW_DATA).not.toMatch(/\/(?:site|api)\//);
  });

  it("with an address of its own the CSP is recomputed over the same script and the data is untouched", async () => {
    const files = await run(site({ "/site/文章-一/": { body: articleWithPreview("https://live.example/api/media/cover.png") } }), "https://me.github.io/garden/");
    const post = text(files, "site/文章-一/index.html");
    expect(post.match(/Content-Security-Policy/g)).toHaveLength(1);
    expect(post).toContain(sha(PREVIEW_SCRIPT));
    expect(post).toContain(PREVIEW_DATA);
  });

  it("og:image follows the copy to its new host (media/ on the Pages address)", async () => {
    const files = await run(site({ "/site/文章-一/": { body: articleWithPreview("https://live.example/api/media/cover.png") } }), "https://me.github.io/garden/");
    const post = text(files, "site/文章-一/index.html");
    expect(post).toContain('<meta property="og:image" content="https://me.github.io/garden/media/cover.png" />');
    expect(post).not.toContain("live.example");
  });

  it("og:image already made the copy's own media/ path by the media pass gets the host in full", async () => {
    const files = await run(site({ "/site/文章-一/": { body: articleWithPreview("../../media/cover.png") } }), "https://me.github.io/garden/");
    const post = text(files, "site/文章-一/index.html");
    expect(post).toContain('<meta property="og:image" content="https://me.github.io/garden/media/cover.png" />');
    // the page's own images stay relative
    expect(text(files, "site/index.html")).toContain('src="/api/media/pic.png"');
  });

  it("an image on another host is left alone, and a zip keeps what it was given", async () => {
    const post = (files: Awaited<ReturnType<typeof run>>) => text(files, "site/文章-一/index.html");
    const other = await run(site({ "/site/文章-一/": { body: articleWithPreview("https://cdn.example/a.jpg") } }), "https://me.github.io/garden/");
    expect(post(other)).toContain('content="https://cdn.example/a.jpg"');
    const zip = await run(site({ "/site/文章-一/": { body: articleWithPreview("../../media/cover.png") } }));
    expect(post(zip)).toContain('content="../../media/cover.png"');
  });
});

describe("what the copy says about itself", () => {
  it("every page carries a CSP that allows its own inline script by hash", async () => {
    const files = await run(site());
    const home = text(files, "site/index.html");
    const inline = home.match(/<script type="module">([^<]*)<\/script>/)![1];
    expect(home).toContain(`'sha256-${createHash("sha256").update(inline).digest("base64")}'`);
    expect(home.indexOf("Content-Security-Policy")).toBeLessThan(home.indexOf("<script"));
  });

  it("the CSP lets the search compile its WebAssembly and nothing more", async () => {
    const home = text(await run(site()), "site/index.html");
    const csp = home.match(/Content-Security-Policy" content="([^"]*)"/)![1];
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("'unsafe-inline' https");
    expect(csp.split("; ").find((d) => d.startsWith("script-src"))).not.toMatch(/'unsafe-inline'/);
  });

  it("an address of its own recomputes the CSP once: one policy per page, inline script still allowed", async () => {
    const files = await run(site(), "https://me.github.io/garden/");
    const home = text(files, "site/index.html");
    expect(home.match(/Content-Security-Policy/g)).toHaveLength(1);
    const inline = home.match(/<script type="module">([^<]*)<\/script>/)![1];
    expect(home).toContain(`'sha256-${createHash("sha256").update(inline).digest("base64")}'`);
  });

  it("a copy with its own address points canonical links, the sitemap and the feed there", async () => {
    const files = await run(site(), "https://me.github.io/garden/");
    expect(text(files, "site/index.html")).toContain('href="https://me.github.io/garden/site/x/"');
    expect(text(files, "site/sitemap.xml")).toContain("https://me.github.io/garden/site/文章-一/");
    expect(text(files, "site/feed.xml")).toContain("https://me.github.io/garden/media/pic.png");
    expect(text(files, "robots.txt")).toContain("Sitemap: https://me.github.io/garden/site/sitemap.xml");
  });

  it("a zip (no address of its own) keeps the live address in them", async () => {
    const files = await run(site());
    expect(text(files, "site/index.html")).toContain('href="https://live.example/site/x/"');
  });

  it("robots.txt follows the site's indexing setting", async () => {
    const r = site({ "/site/static-pages.json": { type: "application/json", body: JSON.stringify({ pages: ["/site/"], origin: "https://live.example", allowIndexing: false }) } });
    expect(text(await run(r), "robots.txt")).toContain("Disallow: /");
  });
});

describe("a renamed page's old address (GAP-240)", () => {
  const listing = (redirects: unknown) => ({
    "/site/static-pages.json": { type: "application/json", body: JSON.stringify({
      pages: ["/site/", "/site/文章-一/", "/site/tag/花/"], origin: "https://live.example", allowIndexing: true, redirects,
    }) },
  });

  it("gets a page that sends the reader on, relative, with the live page as canonical", async () => {
    const files = await run(site(listing([
      { from: "/site/舊文章/", to: "/site/文章-一/" }, { from: "/site/tag/old/", to: "/site/tag/花/" },
    ])));
    const moved = text(files, "site/舊文章/index.html");
    const to = `../${encodeURIComponent("文章-一")}/index.html`;
    expect(moved).toContain(`<meta http-equiv="refresh" content="0;url=${to}">`);
    expect(moved).toContain(`<a href="${to}">`);
    expect(moved).toContain(`<link rel="canonical" href="https://live.example/site/${encodeURIComponent("文章-一")}/">`);
    expect(moved).toContain('<meta name="robots" content="noindex">');
    expect(moved).toContain('data-pagefind-ignore="all"');
    expect(moved).toContain('http-equiv="Content-Security-Policy"');
    expect(text(files, "site/tag/old/index.html")).toContain(`url=../${encodeURIComponent("花")}/index.html`);
    // the sitemap is the renderer's (current pages only): no old address is added to it
    expect(text(files, "site/sitemap.xml")).not.toContain("舊文章");
  });

  it("names the copy's own address once it has one (Pages)", async () => {
    const files = await run(site(listing([{ from: "/site/舊文章/", to: "/site/文章-一/" }])), "https://me.github.io/garden/");
    const moved = text(files, "site/舊文章/index.html");
    expect(moved).toContain(`<link rel="canonical" href="https://me.github.io/garden/site/${encodeURIComponent("文章-一")}/">`);
    expect(moved).toContain(`url=../${encodeURIComponent("文章-一")}/index.html`);
  });

  it("never replaces a page the copy has, and leaves out what is not a site address", async () => {
    const files = await run(site(listing([
      { from: "/site/文章-一/", to: "/site/" },
      { from: "/site/../../etc/", to: "/site/" },
      { from: "/site/x/", to: "https://evil.example/" },
      "junk",
    ])));
    expect(text(files, "site/文章-一/index.html")).not.toContain("http-equiv=\"refresh\"");
    expect(files.some((f) => f.path.includes("etc") || f.path === "site/x/index.html")).toBe(false);
  });

  it("escapes what it writes into an attribute", () => {
    expect(redirectPage('a"b<c', "https://x/\"")).not.toMatch(/a"b|<c|x\/"/);
  });
});

