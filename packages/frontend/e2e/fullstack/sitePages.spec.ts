import { test, expect, type APIRequestContext } from "@playwright/test";
import { hostDefaultDesign } from "./hostContract";
import { createPublishingSpace, defaultSpaceId, keepOffSite, markPublished, publishSite, requireAdmin, saveSiteDesign, siteDesign, tagNote, H } from "./helpers";

// The published site's pages (docs/architecture/proposals/publish-redesign-2026-10-24.md
// §3, §4, §6): the home page is the owner's design rendered on the server, every
// published note has an article page, every tag the site shows has a tag page,
// and the header search is the only client JavaScript. Assertions read the
// SERVED HTML (what a reader or crawler receives before any script runs), and the
// browser only where layout or the search island is the point.

// A note is made in a space that publishes (it is on the site at the next publish), or with
// `privateNote` in the default space, which keeps its notes off the site (publish by space, 2026-11-10).
async function mk(request: APIRequestContext, title: string, markdown: string, { privateNote = false } = {}) {
  const space_id = privateNote ? await defaultSpaceId(request) : await createPublishingSpace(request);
  const res = await request.post("/api/nodes", { ...H, data: { space_id, title, markdown } });
  expect(res.ok(), `create ${title}`).toBeTruthy();
  return (await res.json()) as { id: string; slug: string };
}

/** The tag page the served site has for a tag name, from the design `/api/site` carries. */
async function tagPageOf(request: APIRequestContext, name: string): Promise<{ slug: string; rows: Array<{ slug: string; title: string }> } | undefined> {
  const site = await (await request.get("/api/site")).json();
  const pages = Object.values(site.payload?.presentation?.design?.tag_pages ?? {}) as Array<{ name: string; slug: string; rows: Array<{ slug: string; title: string }> }>;
  return pages.find((p) => p.name === name);
}

const html = async (request: APIRequestContext, path: string) => (await request.get(path)).text();

test("the home page draws the saved design on the server, with the tagline under the site name", async ({ page }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  const tag = `home${stamp}`;
  const marker = `HOMEMARK${stamp}`;
  const home = await mk(page.request, `Home ${stamp}`, `# Home ${stamp}\n\n${marker} welcome.`);
  const first = await mk(page.request, `First ${stamp}`, "# First\n\nbody");
  const second = await mk(page.request, `Second ${stamp}`, "# Second\n\nbody");
  const tagId = await tagNote(page.request, first.id, tag);
  await tagNote(page.request, second.id, tag);
  for (const n of [home, first, second]) await markPublished(page.request, n.id);

  const cfg = await page.request.patch("/api/workspace/config", { ...H, data: { config: { brand: `Garden ${stamp}`, tagline: `Slowly ${stamp}`, locale: "en" } } });
  requireAdmin(cfg.status() !== 403, "config needs the owner; run on a fresh stack");
  await saveSiteDesign(page.request, siteDesign({ homeNoteId: home.id, tagId }));
  await publishSite(page.request, { home_node_id: home.id });

  const res = await page.request.get("/site/");
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toContain('class="site-scope"');
  expect(body).toContain("s-cover");
  expect(body).toContain(marker); // the cover's note, first paragraph
  // the tag view lists both notes as real links
  expect(body).toContain(`href="/site/${first.slug}"`);
  expect(body).toContain(`href="/site/${second.slug}"`);
  // frame header: the site name is a link home, the tagline sits under it
  expect(body).toMatch(/<a class="s-frame-brand" href="\/site\/">/);
  expect(body).toContain(`Garden ${stamp}`);
  expect(body).toContain(`<p class="s-frame-tagline">Slowly ${stamp}</p>`);
  // nothing here navigates through a button
  expect(body).not.toContain("<button");

  await page.goto("/site/", { waitUntil: "load" });
  await expect(page.locator(".s-frame-brand")).toBeVisible();
  await expect(page.locator(".s-view--list a", { hasText: `First ${stamp}` })).toHaveAttribute("href", new RegExp(`/site/${first.slug}$`));
  await page.screenshot({ path: "/tmp/pw-output/shots/site-home.png", fullPage: true });
});

test("with no saved design the home page is the default design", async ({ page }) => {
  const stamp = Date.now();
  const marker = `DEFAULTHOME${stamp}`;
  const home = await mk(page.request, `Default home ${stamp}`, `# Default home\n\n${marker} is the first paragraph.\n\nSecond paragraph.`);
  await markPublished(page.request, home.id);
  const cleared = await page.request.patch("/api/workspace/config", { ...H, data: { chrome: null } });
  requireAdmin(cleared.status() !== 403, "config needs the owner; run on a fresh stack");
  await publishSite(page.request, { home_node_id: home.id });

  // The default design (the box model, 2026-11-01): an intro from the home note, then the article lists.
  const body = await html(page.request, "/site/");
  expect(body).toContain("site-scope");
  expect(body).toMatch(/data-box="home\.hero"[^>]*data-widget="intro"|data-widget="intro"[^>]*data-box="home\.hero"/);
  expect(body).toContain('data-box="home.list"');
  expect(body).toContain(marker);
});

test("a published note has an article page: title, date for date tags, tag links, body, reading time", async ({ page }) => {
  const stamp = Date.now();
  const tag = `topic${stamp}`;
  const marker = `ARTICLE${stamp}`;
  const target = await mk(page.request, `Linked ${stamp}`, "# Linked\n\nthe wikilink target.");
  const article = await mk(page.request, `Article ${stamp}`, `# Article ${stamp}\n\n${marker} text with [[Linked ${stamp}]].\n\n## Section ${stamp}\n\nmore\n\n## Second\n\nmore\n\n## Third\n\nmore`);
  await tagNote(page.request, article.id, "文章"); // the default date tag
  await tagNote(page.request, article.id, tag);
  for (const n of [target, article]) await markPublished(page.request, n.id);
  // The default note page shows date and reading time only; tag chips are a choice of the 資訊行 box.
  const design = hostDefaultDesign();
  await saveSiteDesign(page.request, { ...design, boxes: { ...design.boxes, "note.meta": { widget: "meta", variant: "all" } } });
  await publishSite(page.request);

  const res = await page.request.get(`/site/${article.slug}`);
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toContain(`<h1 class="s-article__title">Article ${stamp}</h1>`);
  expect(body).toContain(marker);
  expect(body).toMatch(/<time class="s-date" datetime="\d{4}-\d{2}-\d{2}"/i); // 文章 is a date tag
  const topic = await tagPageOf(page.request, tag);
  expect(topic, "the topic tag has a page").toBeTruthy();
  expect(body).toContain(`href="/site/tag/${topic!.slug}/"`); // the tag chip is a link to its page
  expect(body).toContain(`href="/site/${target.slug}"`); // [[wikilink]] is a real anchor
  expect(body).toContain('class="s-toc"'); // table of contents (wide screens; three headings or more)
  // The canonical is the address readers use (APP_URL), port included (GAP-200).
  expect(body).toContain(`<link rel="canonical" href="${new URL(res.url()).origin}/site/`);
  expect(body).toMatch(/分鐘讀完|min read/); // reading time (frames.article.readingTime, on by default)
  // Nothing navigates through a button; the one button is the reader's own light/dark switch (foot box).
  expect(body.replace(/<button[^>]*class="[^"]*\bs-scheme\b[^"]*"/g, "")).not.toContain("<button");

  // The dated note shows its date itself; a note without a date tag shows no date of its own,
  // only when it was last updated (the 資訊行's 「Updated …」, siteWidgetData.metaPieces).
  const dateOnly = /<time class="s-date" dateTime="(\d{4}-\d{2}-\d{2})">\1<\/time>/;
  expect(body).toMatch(dateOnly);
  const plain = await mk(page.request, `Plain ${stamp}`, "# Plain\n\nundated");
  await markPublished(page.request, plain.id);
  await publishSite(page.request);
  const plainBody = await html(page.request, `/site/${plain.slug}`);
  expect(plainBody).not.toMatch(dateOnly);
  expect(plainBody).toMatch(/<time class="s-date" dateTime="\d{4}-\d{2}-\d{2}">(Updated|更新)/);
});

test("an unknown or unpublished page is a 404 in the site frame, never a redirect", async ({ page }) => {
  const stamp = Date.now();
  const secret = `NOTPUBLIC${stamp}`;
  const hidden = await mk(page.request, `Hidden ${stamp}`, `# Hidden\n\n${secret}`, { privateNote: true });
  await publishSite(page.request);
  for (const path of [`/site/${hidden.slug}`, `/site/no-such-page-${stamp}`, `/site/tag/no-such-tag-${stamp}`]) {
    const res = await page.request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(404);
    const body = await res.text();
    expect(body, path).toMatch(/找不到這一頁|Page not found/); // the site language an earlier test chose
    expect(body, path).toContain("s-frame-header"); // still in the site's frame
    expect(body, path).not.toContain(secret);
  }
});

test("a tag page lists the tag's published notes; a takedown removes a note everywhere without a republish", async ({ page }) => {
  test.setTimeout(90_000);
  const stamp = Date.now();
  const tag = `shelf${stamp}`;
  const home = await mk(page.request, `Shelf home ${stamp}`, "# Shelf home\n\nintro");
  const keep = await mk(page.request, `Keep ${stamp}`, "# Keep\n\nstays");
  const drop = await mk(page.request, `Drop ${stamp}`, "# Drop\n\ngoes");
  const tagId = await tagNote(page.request, keep.id, tag);
  await tagNote(page.request, drop.id, tag);
  for (const n of [home, keep, drop]) await markPublished(page.request, n.id);
  await saveSiteDesign(page.request, siteDesign({ homeNoteId: home.id, tagId }));
  await publishSite(page.request, { home_node_id: home.id });

  const tagPage = await tagPageOf(page.request, tag);
  expect(tagPage, "the tag has a page").toBeTruthy();
  const tagUrl = `/site/tag/${tagPage!.slug}/`;
  const onTag = await page.request.get(tagUrl);
  expect(onTag.status()).toBe(200);
  const tagHtml = await onTag.text();
  expect(tagHtml).toContain(`<h1 class="s-tag__title">${tag}</h1>`);
  expect(tagHtml).toContain(`href="/site/${keep.slug}"`);
  expect(tagHtml).toContain(`href="/site/${drop.slug}"`);
  expect(await html(page.request, "/site/")).toContain(`href="/site/${drop.slug}"`);
  expect(await html(page.request, "/site/sitemap.xml")).toContain(tagUrl);

  // Take `drop` down: no publish in between.
  const off = await page.request.put(`/api/nodes/${drop.id}/attributes/_published`, { ...H, data: { value: "false", value_type: "bool" } });
  expect(off.ok()).toBeTruthy();
  await expect.poll(async () => (await html(page.request, "/site/")).includes(`href="/site/${drop.slug}"`), { timeout: 15_000 }).toBe(false);
  expect(await html(page.request, "/site/")).toContain(`href="/site/${keep.slug}"`);
  expect(await html(page.request, tagUrl)).not.toContain(`href="/site/${drop.slug}"`);
  expect((await page.request.get(`/site/${drop.slug}`, { maxRedirects: 0 })).status()).toBe(404);
});

test("the owner's CSS applies, scoped to the site, and cannot close its own style tag", async ({ page }) => {
  const stamp = Date.now();
  const mark = `css-${stamp}`;
  const node = await mk(page.request, `Css ${stamp}`, "# Css\n\nbody");
  await markPublished(page.request, node.id);
  // The two `:has(&)` rules try to reach outside the site scope (GAP-246); @scope must keep them in.
  const css = `/* ${mark} */ .s-frame-brand { color: rgb(7, 8, 9); } :root:has(&) body { background-color: rgb(9, 8, 7); } `
    + `html:has(&) { outline: 5px solid rgb(9, 8, 7); } a{}</style><script>window.__pwned=1</script>`;
  const saved = await page.request.patch("/api/workspace/config", { ...H, data: { chrome: siteDesign({ homeNoteId: node.id, css }) } });
  requireAdmin(saved.status() !== 403, "config needs the owner; run on a fresh stack");
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await publishSite(page.request, { home_node_id: node.id });

  const body = await html(page.request, "/site/");
  expect(body).toContain(mark);
  expect(body).toMatch(/@scope \(\.site-scope\) \{\s*:scope \{[^}]*\.s-frame-brand/s); // inside the site scope
  expect(body).not.toContain("</style><script>window.__pwned");

  await page.goto("/site/", { waitUntil: "load" });
  await expect(page.locator(".s-frame-brand")).toHaveCSS("color", "rgb(7, 8, 9)");
  await expect(page.locator("body")).not.toHaveCSS("background-color", "rgb(9, 8, 7)");
  await expect(page.locator("html")).not.toHaveCSS("outline-color", "rgb(9, 8, 7)");
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});

test("the header search finds published notes with real links and the only script is the search", async ({ page }) => {
  test.setTimeout(150_000);
  const stamp = Date.now();
  const word = `searchable${stamp}`;
  const note = await mk(page.request, `Search target ${stamp}`, `# Target\n\nthe word ${word} is inside.`);
  const priv = await mk(page.request, `Search private ${stamp}`, `# Private\n\n${word} but never published.`, { privateNote: true });
  await markPublished(page.request, note.id);
  await saveSiteDesign(page.request, siteDesign({ homeNoteId: note.id }));
  await publishSite(page.request, { home_node_id: note.id });
  expect(priv.id).toBeTruthy();

  // The box shows once the publish's search index is built (the site_bundle job, after the response).
  await expect(async () => {
    await page.goto("/site/", { waitUntil: "load" });
    await expect(page.locator(".s-search")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 90_000 });
  expect(await page.locator("astro-island").count()).toBe(0); // no framework island: the search is a small script over the Pagefind index
  const input = page.locator(".s-search__input");
  await input.fill(word);
  const hit = page.locator(".s-search__hit", { hasText: `Search target ${stamp}` });
  await expect(hit).toBeVisible({ timeout: 15_000 });
  await expect(hit).toHaveAttribute("href", new RegExp(`/site/${note.slug}/?$`)); // Pagefind's page address
  await expect(page.locator(".s-search__hit", { hasText: `Search private ${stamp}` })).toHaveCount(0);
  await hit.click();
  await expect(page).toHaveURL(new RegExp(`/site/${note.slug}/?$`));
});

test("a renamed note's old address goes to its new one; taken down, it is a 404 (GAP-240)", async ({ page }) => {
  const stamp = Date.now();
  const node = await mk(page.request, `Plan ${stamp}`, "# Plan\n\nbody");
  await markPublished(page.request, node.id);
  await publishSite(page.request);
  const oldPath = `/site/${node.slug}/`;
  expect((await page.request.get(oldPath)).status()).toBe(200);

  const renamed = await page.request.patch(`/api/nodes/${node.id}`, { ...H, data: { title: `Roadmap ${stamp}` } });
  expect(renamed.ok(), await renamed.text()).toBeTruthy();
  await publishSite(page.request);

  const moved = await page.request.get(oldPath, { maxRedirects: 0 });
  expect(moved.status()).toBe(301);
  expect(new URL(moved.headers()["location"]!, "http://x").pathname).toBe(`/site/roadmap-${stamp}/`);
  await page.goto(oldPath, { waitUntil: "load" });
  expect(new URL(page.url()).pathname).toBe(`/site/roadmap-${stamp}/`);
  const sitemap = await html(page.request, "/site/sitemap.xml");
  expect(sitemap).not.toContain(oldPath);

  // Taken down: neither address names it, and the old one no longer redirects.
  await keepOffSite(page.request, node.id); // 「不發布」: in a space that publishes, deleting the attribute would put it back
  const gone = await page.request.get(oldPath, { maxRedirects: 0 });
  expect(gone.status()).toBe(404);
  expect(await gone.text()).not.toContain(`roadmap-${stamp}`);
});
