import { describe, it, expect } from "vitest";
import { siteHead, siteLang, renderHeadTags, ga4InlineScript, isGa4Id, type HeadTag, type SiteHeadSite } from "./siteHead.js";

const SITE: SiteHeadSite = {
  brand: "My Blog",
  tagline: "Notes",
  description: "Thoughts on things",
  favicon: "/favicon.png",
  allow_indexing: true,
  locale: "zh-TW",
};

const metaContent = (tags: HeadTag[], key: string): string | undefined => {
  const t = tags.find((x) => x.tag === "meta" && (x.attrs.name === key || x.attrs.property === key));
  return t?.attrs.content as string | undefined;
};

describe("siteLang", () => {
  it("keeps the locale the Design tab stores — zh-TW is a valid BCP 47 tag", () => {
    expect(siteLang("zh-TW")).toBe("zh-TW");
    expect(siteLang("en")).toBe("en");
    expect(siteLang("ja")).toBe("ja");
  });

  it("falls back to the Design tab default (zh-TW) for a missing or unknown locale", () => {
    expect(siteLang(undefined)).toBe("zh-TW");
    expect(siteLang("")).toBe("zh-TW");
    expect(siteLang('x" onload="alert(1)')).toBe("zh-TW");
  });
});

describe("siteHead", () => {
  it("emits the full head in document order", () => {
    const tags = siteHead(SITE, { pageTitle: "Post — My Blog", canonical: "https://ex.com/site/post", variant: "article" });
    expect(renderHeadTags(tags)).toBe([
      '<meta charset="UTF-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      "<title>Post — My Blog</title>",
      '<meta name="description" content="Thoughts on things" />',
      '<link rel="canonical" href="https://ex.com/site/post" />',
      '<link rel="icon" href="/favicon.png" />',
      '<meta property="og:title" content="Post — My Blog" />',
      '<meta property="og:description" content="Thoughts on things" />',
      '<meta property="og:type" content="article" />',
      '<meta property="og:url" content="https://ex.com/site/post" />',
      '<meta property="og:site_name" content="My Blog" />',
      '<meta name="twitter:card" content="summary" />',
    ].join("\n"));
  });

  it("og:type is website for an index page and article for a note", () => {
    expect(metaContent(siteHead(SITE, { pageTitle: "x", variant: "index" }), "og:type")).toBe("website");
    expect(metaContent(siteHead(SITE, { pageTitle: "x", variant: "article" }), "og:type")).toBe("article");
  });

  it("description: page, then site description, then tagline; empty → no tags", () => {
    expect(metaContent(siteHead(SITE, { pageTitle: "x", description: "Page", variant: "article" }), "description")).toBe("Page");
    expect(metaContent(siteHead({ ...SITE, description: "" }, { pageTitle: "x", variant: "index" }), "description")).toBe("Notes");
    const none = siteHead({}, { pageTitle: "x", variant: "index" });
    expect(metaContent(none, "description")).toBeUndefined();
    expect(metaContent(none, "og:description")).toBeUndefined();
  });

  it("noindex, nofollow only when indexing is turned off", () => {
    expect(metaContent(siteHead({ ...SITE, allow_indexing: false }, { pageTitle: "x", variant: "index" }), "robots")).toBe("noindex, nofollow");
    expect(metaContent(siteHead(SITE, { pageTitle: "x", variant: "index" }), "robots")).toBeUndefined();
    expect(metaContent(siteHead({}, { pageTitle: "x", variant: "index" }), "robots")).toBeUndefined();
  });

  it("no canonical → no rel=canonical and no og:url", () => {
    const out = renderHeadTags(siteHead(SITE, { pageTitle: "x", variant: "index" }));
    expect(out).not.toContain("canonical");
    expect(out).not.toContain("og:url");
  });

  it("feed and sitemap links only where the host serves them", () => {
    const out = renderHeadTags(siteHead(SITE, { pageTitle: "x", variant: "index", feed: "/site/feed.xml", sitemap: "/site/sitemap.xml" }));
    expect(out).toContain('<link rel="alternate" type="application/rss+xml" title="My Blog" href="/site/feed.xml" />');
    expect(out).toContain('<link rel="sitemap" href="/site/sitemap.xml" />');
    expect(renderHeadTags(siteHead(SITE, { pageTitle: "x", variant: "index" }))).not.toContain("rel=\"alternate\"");
  });

  it("analytics: plausible, umami, ga4 (inline text = ga4InlineScript), none without an id", () => {
    const head = (provider: string, id = "abc") =>
      renderHeadTags(siteHead({ analytics_provider: provider, analytics_id: id }, { pageTitle: "x", variant: "index" }));
    expect(head("plausible", "ex.com")).toContain('<script defer data-domain="ex.com" src="https://plausible.io/js/script.js"></script>');
    expect(head("umami")).toContain('<script defer src="https://cloud.umami.is/script.js" data-website-id="abc"></script>');
    const ga = head("ga4", "G-ABC123");
    expect(ga).toContain('<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>');
    expect(ga).toContain(`<script>${ga4InlineScript("G-ABC123")}</script>`);
    expect(head("plausible", "")).not.toContain("<script");
    expect(head("other")).not.toContain("<script");
  });

  it("ga4 only for a measurement id: a backslash, quote or newline in it emits no script", () => {
    const head = (id: string) =>
      renderHeadTags(siteHead({ analytics_provider: "ga4", analytics_id: id }, { pageTitle: "x", variant: "index" }));
    for (const bad of ["G-1\\", 'G-1");alert(1);//', "G-ABC\nalert(1)", "UA-12345", "g-abc123", "G-1"]) {
      expect(isGa4Id(bad)).toBe(false);
      expect(head(bad)).not.toContain("<script");
    }
    expect(isGa4Id("G-ABC123")).toBe(true);
    expect(ga4InlineScript("G-ABC123")).toContain('gtag("config","G-ABC123")');
  });

  it("escapes every user-controlled value", () => {
    const out = renderHeadTags(siteHead(
      { brand: '"><x>', description: '"><img src=x onerror=alert(1)>', favicon: 'a"b', analytics_provider: "ga4", analytics_id: '"</script><script>alert(1)//' },
      { pageTitle: "</title><script>alert(1)</script>", variant: "index" },
    ));
    expect(out).not.toContain("<script>alert(1)");
    expect(out).not.toContain('"><img');
    expect(out).not.toContain('"><x>');
    expect(out).toContain("<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>");
    expect(out).toContain('href="a&quot;b"');
  });
});

describe("siteHead share image", () => {
  const base = { pageTitle: "Post — My Blog", canonical: "https://ex.com/site/post", variant: "article" as const };

  it("has no image tags and the small card without a picture", () => {
    const tags = siteHead(SITE, base);
    expect(metaContent(tags, "og:image")).toBeUndefined();
    expect(metaContent(tags, "og:image:alt")).toBeUndefined();
    expect(metaContent(tags, "twitter:card")).toBe("summary");
  });

  it("adds og:image, its alt text and the large card for a picture", () => {
    const tags = siteHead(SITE, { ...base, image: { url: "https://ex.com/api/media/a.png", alt: "Post" } });
    expect(metaContent(tags, "og:image")).toBe("https://ex.com/api/media/a.png");
    expect(metaContent(tags, "og:image:alt")).toBe("Post");
    expect(metaContent(tags, "twitter:card")).toBe("summary_large_image");
  });

  it("leaves out the alt when there is none, and escapes the address", () => {
    const tags = siteHead(SITE, { ...base, image: { url: 'https://ex.com/a"b.png' } });
    expect(metaContent(tags, "og:image:alt")).toBeUndefined();
    expect(renderHeadTags(tags)).toContain('content="https://ex.com/a&quot;b.png"');
  });

  it("ignores an empty address", () => {
    expect(metaContent(siteHead(SITE, { ...base, image: { url: "" } }), "twitter:card")).toBe("summary");
  });
});

describe("renderHeadTags", () => {
  it("renders boolean attributes bare and neutralises a closing script tag in script text", () => {
    expect(renderHeadTags([{ tag: "script", attrs: { defer: true, src: "s.js" } }])).toBe('<script defer src="s.js"></script>');
    expect(renderHeadTags([{ tag: "script", attrs: {}, text: "a</script>b" }])).toBe("<script>a<\\/script>b</script>");
  });

  it("joins with the given separator", () => {
    const tags: HeadTag[] = [{ tag: "meta", attrs: { charset: "UTF-8" } }, { tag: "title", attrs: {}, text: "T" }];
    expect(renderHeadTags(tags, "\n    ")).toBe('<meta charset="UTF-8" />\n    <title>T</title>');
  });
});

describe("a site with no icon of its own", () => {
  it("gets its name's first letter on its accent colour, so the browser has no 404 to ask for", () => {
    const tags = siteHead({ brand: "我的筆記", accent: "#7b2d26" }, { pageTitle: "t", variant: "index" });
    const href = tags.find((t) => t.tag === "link" && t.attrs.rel === "icon")!.attrs.href as string;
    const svg = decodeURIComponent(href.replace("data:image/svg+xml,", ""));
    expect(svg).toContain('fill="#7b2d26"');
    expect(svg).toContain(">我<");
  });

  it("keeps a chosen icon, falls back to the default accent for a bad colour, and has none without a name", () => {
    expect(renderHeadTags(siteHead(SITE, { pageTitle: "t", variant: "index" }))).toContain('<link rel="icon" href="/favicon.png" />');
    const icon = (site: Parameters<typeof siteHead>[0]) => siteHead(site, { pageTitle: "t", variant: "index" }).find((t) => t.tag === "link" && t.attrs.rel === "icon")?.attrs.href as string | undefined;
    expect(decodeURIComponent(icon({ brand: "a", accent: 'red" onload="x' })!)).toContain('fill="#317563"');
    expect(icon({ brand: "  " })).toBeUndefined();
    expect(decodeURIComponent(icon({ brand: "<b", accent: "#000000" })!)).toContain("&lt;");
  });
});
