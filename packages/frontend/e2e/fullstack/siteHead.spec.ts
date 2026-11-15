import { test, expect } from "@playwright/test";
import { requireAdmin, createPublishingSpace, publishSite, H } from "./helpers";

// SEO/chrome table-stakes: site description, favicon, the index toggle, and
// analytics opt-in flow from workspace config into the served /site <head>.

test("site head carries description, og, favicon, robots and analytics from config", async ({ page }) => {
  const stamp = Date.now();
  const node = await (await page.request.post("/api/nodes", {
    ...H, data: { space_id: await createPublishingSpace(page.request), title: `HeadProbe ${stamp}`, markdown: `# HeadProbe\n\nFirst paragraph becomes the page description ${stamp}.` },
  })).json();
  await page.request.put(`/api/nodes/${node.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });

  const cfg = await page.request.patch("/api/workspace/config", {
    ...H,
    data: {
      config: {
        brand: `Head ${stamp}`,
        description: `Site-wide description ${stamp}`,
        favicon: "https://example.com/fav.svg",
        allow_indexing: false,
        analytics_provider: "plausible",
        analytics_id: "notes.example.com",
      },
    },
  });
  requireAdmin(cfg.status() !== 403, "config needs the owner; run on a fresh stack");
  expect(cfg.ok(), await cfg.text()).toBeTruthy();
  // The settings and the note reach readers with a publish (snapshot model B).
  await publishSite(page.request, { title: `Head ${stamp}` });

  // Article page: page-specific description (first body paragraph) wins.
  const html = await (await page.request.get(`/site/${node.slug}`)).text();
  expect(html).toContain(`First paragraph becomes the page description ${stamp}.`);
  expect(html).toContain('rel="icon" href="https://example.com/fav.svg"');
  expect(html).toContain('name="robots" content="noindex, nofollow"');
  expect(html).toContain(`og:site_name" content="Head ${stamp}"`);
  expect(html).toContain('data-domain="notes.example.com"');
  expect(html).toContain("plausible.io/js/script.js");

  // Index page: falls back to the site-wide description.
  const indexHtml = await (await page.request.get("/site/")).text();
  expect(indexHtml).toContain(`Site-wide description ${stamp}`);

  // Re-enable indexing + drop analytics → both disappear from the head.
  await page.request.patch("/api/workspace/config", {
    ...H,
    data: { config: { allow_indexing: true, analytics_provider: "", analytics_id: "" } },
  });
  await publishSite(page.request, { title: `Head ${stamp}` });
  const htmlAfter = await (await page.request.get(`/site/${node.slug}`)).text();
  expect(htmlAfter).not.toContain('name="robots" content="noindex');
  expect(htmlAfter).not.toContain("plausible.io/js/script.js");
});

test("site chrome follows the locale setting", async ({ page }) => {
  const stamp = Date.now();
  const node = await (await page.request.post("/api/nodes", {
    ...H, data: { space_id: await createPublishingSpace(page.request), title: `LocaleProbe ${stamp}`, markdown: "# LocaleProbe\n\nbody" },
  })).json();
  await page.request.put(`/api/nodes/${node.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });

  const cfg = await page.request.patch("/api/workspace/config", { ...H, data: { config: { locale: "en" } } });
  requireAdmin(cfg.status() !== 403, "config needs the owner; run on a fresh stack");

  // The header (with its search box) is part of every page's frame; publish so
  // the note is served (snapshot model B).
  await publishSite(page.request, { title: `Locale ${stamp}` });

  let html = await (await page.request.get(`/site/${node.slug}`)).text();
  expect(html).toContain('lang="en"');
  expect(html).toContain('placeholder="Search…"');

  await page.request.patch("/api/workspace/config", { ...H, data: { config: { locale: "zh-TW" } } });
  await publishSite(page.request, { title: `Locale ${stamp}` }); // a changed setting waits for the next publish
  html = await (await page.request.get(`/site/${node.slug}`)).text();
  expect(html).toContain('lang="zh-TW"');
  expect(html).toContain('placeholder="搜尋…"');
});
