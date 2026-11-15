import { test, expect } from "@playwright/test";
import { INTRO_PAGES as PAGES, INTRO_SITE_CONFIG } from "../../src/data/introSite";
import { publishSite, siteDesign, H } from "./helpers";

// Dogfood OFFICIAL SITE — builds Onden's own intro website *out of Onden notes*
// and screenshots it, so the "value is invisible at first glance" problem is
// attacked by self-demonstration: the site IS the product. Six published notes
// + one site-config PATCH; viewed at /site/<slug> (Astro SSR). PNGs land in
// /tmp/pw-output/shots (mirrored to /tmp/pw-host-out/shots by run.sh) to Read.
//
// The page copy + site config now live in ONE place — src/data/introSite.ts —
// so this screenshot spec and the first-run "Explore the Onden intro" install
// share a single source of truth. Re-run against any stack to (re)create it.
const SHOTS = "/tmp/pw-output/shots";

// Page copy and site config (brand, SEO) come from src/data/introSite.ts — the
// single source of truth (also used by the first-run "Explore the Onden intro"
// install). Order = nav order; Colophon is a footer/linked page (nav:false).
// Wikilinks resolve by title (all published). The home page is the site design
// (home note as the cover); the pages are the article frame.

test("build + screenshot the official Onden site", async ({ page }) => {
  // 1) Author the six pages. POST /api/nodes derives the slug from the title
  //    (slugify), so "Home" → /site/home (the home-node fallback).
  const created: Record<string, { id: string; slug: string }> = {};
  for (const p of PAGES) {
    const res = await page.request.post("/api/nodes", { ...H, data: { title: p.title, markdown: p.markdown } });
    expect(res.ok(), `create ${p.title}`).toBeTruthy();
    const node = await res.json();
    created[p.title] = { id: node.id, slug: node.slug };
    // 2) Make it public (D9 opt-in).
    const pub = await page.request.put(`/api/nodes/${node.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
    expect(pub.ok(), `publish ${p.title}`).toBeTruthy();
  }

  // 3) One config PATCH sets the site settings (brand, nav in PAGES order, SEO) and
  //    the design (the Home note as the cover). nav items are { label, nodeId }.
  const nav = PAGES.filter((p) => p.nav).map((p) => ({ label: p.title === "Home" ? "Home" : p.title, nodeId: created[p.title].id }));
  const cfg = await page.request.patch("/api/workspace/config", {
    ...H,
    data: {
      config: { ...INTRO_SITE_CONFIG, nav },
      chrome: siteDesign({ homeNoteId: created["Home"].id }),
    },
  });
  expect(cfg.ok(), "config PATCH").toBeTruthy();
  // Snapshot model B: notes and site settings are served from the last publish,
  // so publish after the config PATCH, not before it.
  await publishSite(page.request);

  // 4) Screenshot every page (full-page) from the served SSR surface.
  for (const p of PAGES) {
    const slug = created[p.title].slug;
    await page.goto(`/site/${slug}`, { waitUntil: "load" });
    // The served HTML is authoritative; give fonts/CSS a beat.
    await page.waitForTimeout(600);
    const safe = slug.replace(/[^a-z0-9-]/gi, "-");
    await page.screenshot({ path: `${SHOTS}/site-${safe}.png`, fullPage: true });
  }

  // Sanity: the article page of Home serves the brand in raw HTML, and the site
  // home page (the design) draws the Home note as its cover.
  const homeHtml = await (await page.request.get(`/site/${created["Home"].slug}`)).text();
  expect(homeHtml).toContain("Onden");
  const indexHtml = await (await page.request.get("/site/")).text();
  expect(indexHtml).toContain("s-cover");
});
