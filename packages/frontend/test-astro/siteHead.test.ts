import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, it, expect } from "vitest";
import { siteHead, renderHeadTags, type SiteHeadSite } from "@onden/markdown";
import SiteHead from "../src/components/SiteHead.astro";

// The server-rendered /site pages and the GitHub Pages deploy (backend
// seoFiles.ts) must ship the same <head>. Both go through @onden/markdown
// siteHead(); this pins the SSR half — what SiteHead.astro renders IS
// renderHeadTags(siteHead(...)) — and the backend's seoFiles.test.ts pins the
// Pages half to the same call.

const SITE: SiteHeadSite = {
  brand: "My Blog",
  description: "Thoughts on things",
  favicon: "/favicon.png",
  allow_indexing: false,
  analytics_provider: "plausible",
  analytics_id: "myblog.com",
  locale: "zh-TW",
};
const SSR_LINKS = { feed: "/site/feed.xml", sitemap: "/site/sitemap.xml" };

async function render(props: Record<string, unknown>): Promise<string> {
  const container = await AstroContainer.create();
  return container.renderToString(SiteHead, { props });
}

describe("SiteHead.astro renders the one site head builder", () => {
  it("the index page head is siteHead(…, variant index), og:type website", async () => {
    const props = { site: SITE, pageTitle: "My Blog", canonical: "https://ex.com/site/", variant: "index" as const };
    const html = await render(props);
    // main rendered og:type "article" on every page, the Pages deploy "website".
    expect(html).toMatch(/<meta property="og:type" content="website"\s*\/?>/);
    expect(html).toMatch(/<meta name="robots" content="noindex, nofollow"\s*\/?>/);
    expect(html.trim()).toBe(renderHeadTags(siteHead(SITE, { ...props, ...SSR_LINKS })));
  });

  it("a note page head is siteHead(…, variant article), og:type article", async () => {
    const props = { site: SITE, pageTitle: "Post — My Blog", description: "Page", canonical: "https://ex.com/site/post", variant: "article" as const };
    const html = await render(props);
    expect(html).toMatch(/<meta property="og:type" content="article"\s*\/?>/);
    expect(html.trim()).toBe(renderHeadTags(siteHead(SITE, { ...props, ...SSR_LINKS })));
  });

  it("hostile values stay inert", async () => {
    const hostile: SiteHeadSite = {
      brand: '"><script>alert(1)</script>', description: '"><img src=x onerror=alert(1)>',
      analytics_provider: "ga4", analytics_id: 'G-1");alert(1);//',
    };
    const props = {
      site: hostile, pageTitle: "</title><script>alert(2)</script>",
      canonical: "https://ex.com/site/post", variant: "article" as const,
    };
    const html = await render(props);
    expect(html).not.toMatch(/<script>alert/);
    expect(html).not.toContain('"><img');
    expect(html).not.toContain("googletagmanager");   // not a GA4 id → no GA4 tags
    expect(html).toContain('<link rel="canonical" href="https://ex.com/site/post" />');
    expect(html.trim()).toBe(renderHeadTags(siteHead(hostile, { ...props, ...SSR_LINKS })));
  });
});
