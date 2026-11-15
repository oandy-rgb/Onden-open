import { test, expect } from "@playwright/test";
import { requireAdmin, createPublishingSpace, publishSite, H } from "./helpers";

// Machine-readable endpoints of the published site: /site/feed.xml (RSS 2.0)
// and /site/sitemap.xml. One probe title carries `<&>` to pin XML escaping —
// the chaos suite publishes <script> titles, so escaping is load-bearing.

test("feed.xml and sitemap.xml list published notes with XML escaping", async ({ page }) => {
  const stamp = Date.now();

  // Same owner probe as siteHead.spec.ts: skip when config is locked down.
  const cfg = await page.request.patch("/api/workspace/config", {
    ...H,
    data: { config: { brand: `Feeds ${stamp}` } },
  });
  requireAdmin(cfg.status() !== 403, "config needs the owner; run on a fresh stack");

  const plain = await (await page.request.post("/api/nodes", {
    ...H, data: { space_id: await createPublishingSpace(page.request), title: `FeedProbe ${stamp}`, markdown: `# FeedProbe\n\nFirst paragraph for the feed ${stamp}.` },
  })).json();
  const spicy = await (await page.request.post("/api/nodes", {
    ...H, data: { space_id: await createPublishingSpace(page.request), title: `Feed <&> Probe ${stamp}`, markdown: `# Spicy\n\nEscaping pinned ${stamp}.` },
  })).json();
  for (const n of [plain, spicy]) {
    await page.request.put(`/api/nodes/${n.id}/attributes/_published`, {
      ...H, data: { value: "true", value_type: "bool" },
    });
  }
  await publishSite(page.request); // snapshot model B: feeds list the last snapshot

  const feedRes = await page.request.get("/site/feed.xml");
  expect(feedRes.status()).toBe(200);
  expect(feedRes.headers()["content-type"] ?? "").toContain("xml");
  const feed = await feedRes.text();
  expect(feed).toContain("<rss");
  expect(feed).toContain(`FeedProbe ${stamp}`);
  expect(feed).toContain(`Feed &lt;&amp;&gt; Probe ${stamp}`); // escaped, never raw
  expect(feed).not.toContain(`Feed <&> Probe`);
  expect(feed).toContain(`<guid isPermaLink="false">${plain.id}</guid>`);

  const mapRes = await page.request.get("/site/sitemap.xml");
  expect(mapRes.status()).toBe(200);
  expect(mapRes.headers()["content-type"] ?? "").toContain("xml");
  const sitemap = await mapRes.text();
  expect(sitemap).toContain("<urlset");
  expect(sitemap).toContain(`/site/${plain.slug}`);
  expect(sitemap).toContain(`/site/${spicy.slug}`);
});
