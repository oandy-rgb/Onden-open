import { test, expect } from "@playwright/test";
import { ready, requireAdmin, createPublishingSpace, publishSite, H } from "./helpers";

// FIRST-RUN VALUE LANDING — "the site IS the product" flow, end to end.
//
// SCOPE NOTE (verified against the shipped UI): there is currently NO
// "Build your first website" button in WelcomeBanner.tsx (its three actions are
// "Write your first note", "Open today's note", and "Add a starter tag"); there
// is no first-run UI that authors+publishes an intro site in one click. So this
// spec verifies the REAL shipped value-landing pipeline the same way
// officialSite.spec.ts dogfoods it: author the intro notes through the wired
// stack, publish them (D9 opt-in `_published` attribute), set the site config,
// and assert the served SSR page renders the intro content. When/if a one-click
// first-run "build your site" action ships, drive THAT here and keep these SSR
// assertions as the acceptance check.
//
// Fresh-stack gated: building the official site config + publishing is an
// owner-gated workspace operation, so requireAdmin guards it (skips on a stale
// local stack, FAILS under E2E_REQUIRE_ADMIN=1).

// A minimal two-page intro site: a Home that links to "The idea", and the idea
// page itself. Both contain the words we assert render on /site/home.
const PAGES: Array<{ title: string; markdown: string }> = [
  {
    title: "Home",
    markdown: `# Onden

A quiet place to keep what you know, connect it, and share the boundary with an agent you trust.

This whole website is built from Onden notes. Start with [[The idea]].`,
  },
  {
    title: "The idea",
    markdown: `# The idea

**A node is a connection.** **A tag is a capability.** **The inbox and outbox are the boundary.**`,
  },
];

test("first-run value landing: intro notes publish and /site/home renders the intro", { tag: "@critical" }, async ({ page }) => {
  // Land authenticated + past the gate; this also surfaces requireAdmin's
  // precondition via the config PATCH below.
  await ready(page, "/?view=notes");

  // 1) Author + publish the intro pages through the wired stack. POST /api/nodes
  //    derives the slug from the title (slugify), so "Home" → /site/home.
  //    Publishing is by space (2026-11-10): the default space keeps its notes private, so the intro
  //    notes are made in a space whose 「發布到網站」 switch is on.
  const created: Record<string, { id: string; slug: string }> = {};
  const publishingSpace = await createPublishingSpace(page.request);
  for (const p of PAGES) {
    const res = await page.request.post("/api/nodes", { ...H, data: { space_id: publishingSpace, title: p.title, markdown: p.markdown } });
    expect(res.ok(), `create ${p.title}`).toBeTruthy();
    const node = await res.json();
    created[p.title] = { id: node.id, slug: node.slug };
    const pub = await page.request.put(`/api/nodes/${node.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
    expect(pub.ok(), `publish ${p.title}`).toBeTruthy();
  }

  // 2) One config PATCH sets the chrome + nav (in PAGES order). Owner-gated — a
  //    403 here means a stale stack (not the first human), so gate the rest.
  const nav = PAGES.map((p) => ({ label: p.title, nodeId: created[p.title].id }));
  const cfg = await page.request.patch("/api/workspace/config", {
    ...H,
    data: {
      config: {
        brand: "Onden",
        tagline: "Keep what you know. Share the boundary.",
        nav,
        locale: "en",
        description: "Onden — an open-source notebook.",
      },
    },
  });
  requireAdmin(cfg.ok(), `config PATCH ${cfg.status()} — needs the first-human/admin e2e user (fresh stack)`);
  // Snapshot model B: notes and site settings are served from the last publish,
  // so publish after the config PATCH, not before it.
  await publishSite(page.request);

  // 3) The served SSR home page renders the intro: the brand "Onden" (Home body
  //    + nav) and "The idea" (the wikilink resolves to the linked page's title).
  //    The home slug is the slugified title.
  const homeSlug = created["Home"].slug;
  const homeHtml = await (await page.request.get(`/site/${homeSlug}`)).text();
  expect(homeHtml).toContain("Onden");
  expect(homeHtml).toContain("The idea");

  // And the "The idea" page itself serves its own intro content.
  const ideaSlug = created["The idea"].slug;
  const ideaHtml = await (await page.request.get(`/site/${ideaSlug}`)).text();
  expect(ideaHtml).toContain("A node is a connection");
  // The Home page's [[The idea]] is a real link to that page (not a button).
  expect(homeHtml).toContain(`href="/site/${ideaSlug}"`);

  // 4) Render it in the browser too (CSS), so the value lands the way a visitor
  //    sees it — not just in the raw HTML.
  await page.goto(`/site/${homeSlug}`, { waitUntil: "load" });
  await expect(page.getByText("Onden", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("The idea", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
});
