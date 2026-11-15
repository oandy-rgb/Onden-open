// Feature-audit deepening (2026-10-08): SITE-09 — the public site as an
// anonymous reader: home, article, unknown slug (status), feed.xml and
// sitemap.xml contents (published only; unpublished and notes in a space
// without publish excluded), meta tags (title, description, og, canonical, lang), image in a
// published article, and the phone layout.
import { test } from "@playwright/test";
import { defaultSpaceId, hideFromOthers, BASE, H, publishRequest } from "../fullstack/helpers";


test("SITE-09: public pages, feed, sitemap, 404, meta, scope, phone", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const space_id = await defaultSpaceId(page.request); // a personal space never publishes
  const mk = async (title: string, markdown: string, pub: boolean) => { const n = await (await page.request.post("/api/nodes", { ...H, data: { title, markdown, space_id } })).json(); if (pub) await page.request.put(`/api/nodes/${n.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } }); return n as { id: string; slug: string }; };
  const pubA = await mk(`S09 Public ${stamp}`, `---\ndescription: Custom description ${stamp}\n---\n\nFirst paragraph of the public article ${stamp}.`, true);
  const priv = await mk(`S09 Private ${stamp}`, "private body", false);
  const locked = await mk(`S09 Locked ${stamp}`, "locked body", true);
  await hideFromOthers(page.request, locked.id); // owner-only space, publishing off
  out.publish = (await publishRequest(page.request, {})).status();
  const anon = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const a = await anon.newPage();
  const get = async (p: string) => { const r = await a.request.get(p); return { status: r.status(), text: await r.text() }; };
  const home = await get("/site"); out.home = { status: home.status, hasPublic: home.text.includes(`S09 Public ${stamp}`), hasPrivate: home.text.includes(`S09 Private ${stamp}`), hasLocked: home.text.includes(`S09 Locked ${stamp}`) };
  const art = await get(`/site/${pubA.slug}`);
  const meta = (re: RegExp) => (art.text.match(re)?.[1] ?? null);
  out.article = { status: art.status, title: meta(/<title>([^<]*)<\/title>/), description: meta(/<meta name="description" content="([^"]*)"/), ogTitle: meta(/<meta property="og:title" content="([^"]*)"/), canonical: meta(/<link rel="canonical" href="([^"]*)"/), lang: meta(/<html lang="([^"]*)"/), robots: meta(/<meta name="robots" content="([^"]*)"/) };
  out.privateDirect = (await get(`/site/${priv.slug}`)).status;
  const lockedPage = await get(`/site/${locked.slug}`); out.lockedDirect = { status: lockedPage.status, leaks: lockedPage.text.includes("locked body") };
  const unknown = await get(`/site/does-not-exist-${stamp}`); out.unknownSlug = { status: unknown.status, says404: /not found|404|找不到/i.test(unknown.text) };
  const feed = await get("/site/feed.xml"); out.feed = { status: feed.status, type: (await a.request.get("/site/feed.xml")).headers()["content-type"], hasPublic: feed.text.includes(`S09 Public ${stamp}`), hasPrivate: feed.text.includes(`S09 Private ${stamp}`), hasLocked: feed.text.includes(`S09 Locked ${stamp}`), validStart: feed.text.trimStart().startsWith("<?xml") };
  const sm = await get("/site/sitemap.xml"); out.sitemap = { status: sm.status, hasPublic: sm.text.includes(pubA.slug), hasPrivate: sm.text.includes(priv.slug), hasLocked: sm.text.includes(locked.slug), absoluteUrls: /<loc>https?:\/\//.test(sm.text) };
  // Phone render.
  const ph = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, viewport: { width: 390, height: 844 }, isMobile: true });
  const pp = await ph.newPage();
  await pp.goto(`${BASE}/site/${pubA.slug}`, { waitUntil: "load" });
  out.phone = await pp.evaluate(() => ({ sw: document.documentElement.scrollWidth, bodyFont: getComputedStyle(document.body).fontSize, h1: (document.querySelector("h1") as HTMLElement | null)?.innerText?.slice(0, 40) ?? null }));
  await anon.close(); await ph.close();
  console.log("SITE09 " + JSON.stringify(out, null, 2));
});
