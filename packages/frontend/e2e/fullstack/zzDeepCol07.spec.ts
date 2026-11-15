// Feature-audit deepening (2026-10-07): COL-07 — the saved-view Gallery:
// uploaded cover (only referenced from an attribute), broken and non-image
// cover values, no cover, long titles, an un-hinted image field, opening by
// mouse and keyboard, permission loss for a second human (reload and live),
// layout persistence across reload, phone viewport.
import { test, expect, type Page } from "@playwright/test";
import { ready, defaultSpaceId, addToDefaultSpace, hideFromOthers, openSavedViewTab, BASE, H } from "./helpers";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("COL-07: gallery covers, long/no image, open, permission loss, reload, phone", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, string> = {};
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `C07T${stamp}`, fields: [
    { name: "cover", type: "text" }, { name: "pic", type: "text" }, { name: "author", type: "text" },
  ] } })).json();
  const media = await (await page.request.post("/api/media", { headers: { origin: BASE }, multipart: { file: { name: `c${stamp}.png`, mimeType: "image/png", buffer: PNG } } })).json();
  out.media = JSON.stringify(media).slice(0, 120);
  // Default space: the second human below sees the gallery.
  const shared = await defaultSpaceId(page.request);
  const mk = async (title: string, a: Record<string, string> = {}) => {
    const n = await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: "plain body", space_id: shared } })).json();
    await page.request.put(`/api/nodes/${n.id}/tags/${tag.id}`, { ...H, data: {} });
    for (const [k, v] of Object.entries(a)) await page.request.put(`/api/nodes/${n.id}/attributes/${k}`, { ...H, data: { value: v, value_type: "text" } });
    return n.id as string;
  };
  const idUp = await mk(`Uploaded ${stamp}`, { cover: media.url, author: "Ann" });
  const idBare = await mk(`Bareid ${stamp}`, { cover: String(media.url).split("/").pop()! });
  await mk(`Broken ${stamp}`, { cover: "https://img.invalid/nope.png" });
  await mk(`Words ${stamp}`, { cover: "just some words" });
  await mk(`Pic ${stamp}`, { pic: media.url });
  const idNo = await mk(`None ${stamp}`, { author: "Bob" });
  const longTitle = `Long ${stamp} ` + "研究生讀書會長標題 averyveryverylongunbrokenwordwithoutanyspaces".repeat(5);
  await mk(longTitle);
  const idSecret = await mk(`Secret ${stamp}`, { cover: media.url, author: "Hidden" });
  const view = await (await page.request.post(`/api/tags/${tag.id}/views`, { ...H, data: { name: "G", layout: "gallery", visible_fields: ["title", "cover", "pic", "author"] } })).json();
  void view; void idBare;

  const openGallery = async (p: Page) => {
    await ready(p, `/?view=notes&node=${tag.id}`);
    await openSavedViewTab(p);
    await expect(p.locator(".cv-gallery")).toBeVisible({ timeout: 15_000 });
    await p.waitForTimeout(1500);
  };
  const cards = (p: Page) => p.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".cv-gallery-card")).map((c) => {
    const img = c.querySelector("img") as HTMLImageElement | null;
    const r = c.getBoundingClientRect();
    return {
      t: (c.querySelector(".cv-gallery-title") as HTMLElement).innerText.split(" ")[0],
      img: img ? `${img.complete && img.naturalWidth > 0 ? "loaded" : "broken"} ${img.getAttribute("src")?.slice(0, 40)}` : `placeholder:${(c.querySelector(".cv-gallery-cover-placeholder") as HTMLElement | null)?.innerText ?? "-"}`,
      badges: Array.from(c.querySelectorAll(".cv-gallery-badge")).map((b) => (b as HTMLElement).innerText.replace(/\s+/g, "=")),
      box: `${Math.round(r.width)}x${Math.round(r.height)}`,
    };
  }));

  try {
    await openGallery(page);
    // Let lazy images settle.
    await page.evaluate(async () => { for (const i of Array.from(document.querySelectorAll("img"))) { i.loading = "eager"; } await new Promise((r) => setTimeout(r, 1500)); });
    out.cards = JSON.stringify(await cards(page));
    out.mediaGet = String((await page.request.get(media.url)).status());
    out.longTitle = JSON.stringify(await page.evaluate((s) => {
      const c = Array.from(document.querySelectorAll<HTMLElement>(".cv-gallery-card")).find((e) => e.innerText.includes(`Long ${s}`))!;
      const t = c.querySelector(".cv-gallery-title") as HTMLElement; const cs = getComputedStyle(t);
      return { cardH: Math.round(c.getBoundingClientRect().height), titleH: Math.round(t.getBoundingClientRect().height), overflowX: t.scrollWidth > t.clientWidth + 1, clamp: cs.webkitLineClamp, doc: document.documentElement.scrollWidth, win: innerWidth };
    }, String(stamp)));

    // Open by mouse, then by keyboard.
    await page.locator(".cv-gallery-card", { hasText: `None ${stamp}` }).click();
    await page.waitForTimeout(800);
    out.clickOpens = String(page.url().includes(idNo));
    await openGallery(page);
    const card = page.locator(".cv-gallery-card", { hasText: `Uploaded ${stamp}` });
    await page.locator(".cv-gallery-card", { hasText: `Secret ${stamp}` }).focus();
    await page.keyboard.press("Tab");
    out.focusRing = await card.evaluate((e) => { const cs = getComputedStyle(e); return `${document.activeElement === e} ${e.matches(":focus-visible")} ${cs.outlineStyle} ${cs.outlineWidth} shadow=${cs.boxShadow !== "none"}`; });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    out.enterOpens = String(page.url().includes(idUp));

    // Reload keeps the gallery layout.
    await openGallery(page);
    await page.reload();
    await openSavedViewTab(page).catch(() => null);
    await page.waitForTimeout(1500);
    out.reloadLayout = `gallery=${await page.locator(".cv-gallery").count()} active=${await page.locator(".cv-layout-btn--active").innerText().catch(() => "?")}`;

    // Second human (editor) sees the gallery, then loses read on Secret.
    const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
    const signup = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `C07 ${stamp}`, email: `c07-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
    const actor = await (await page.request.post("/api/actors", { ...H, data: { name: `C07 ${stamp}`, type: "human", external_id: signup.user.id } })).json();
    await addToDefaultSpace(page.request, actor.id); // a new member joins no space by itself (097)
    const hp = await human.newPage();
    await hp.addInitScript(() => localStorage.setItem("onden.welcomeDismissed", "1"));
    await openGallery(hp);
    out.editorBefore = JSON.stringify((await cards(hp)).map((c) => c.t));
    await hideFromOthers(page.request, idSecret);
    await hp.waitForTimeout(6000);
    out.editorLiveAfterLock = JSON.stringify((await cards(hp)).map((c) => c.t));
    const stale = hp.locator(".cv-gallery-card", { hasText: `Secret ${stamp}` });
    if (await stale.count()) {
      await stale.click();
      await hp.waitForTimeout(1500);
      out.editorClickStale = `url=${hp.url().includes(idSecret)} toast=${JSON.stringify(await hp.locator("[role=status], [role=alert], .toast").allInnerTexts())} notFound=${JSON.stringify((await hp.locator("body").innerText()).match(/not found|no longer|can.t open|don.t have[^\n]*/i)?.[0] ?? null)} gallery=${await hp.locator(".cv-gallery").count()} secretTitleShown=${(await hp.locator("body").innerText()).includes(`Secret ${stamp}`)} hiddenAuthorShown=${(await hp.locator("body").innerText()).includes("Hidden")}`;
      await hp.screenshot({ path: "/tmp/pw-output/col07-stale.png" });
    }
    await openGallery(hp);
    out.editorAfterReload = JSON.stringify((await cards(hp)).map((c) => c.t));
    out.editorExec = JSON.stringify(((await (await hp.request.get(`/api/tags/${tag.id}/views/${view.id}/exec`)).json()).rows ?? []).map((r: { title: string }) => r.title.split(" ")[0]));
    out.editorMediaOfSecret = String((await hp.request.get(media.url)).status());
    await human.close();

    // Phone.
    const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE, hasTouch: true, isMobile: true });
    const pp = await phone.newPage();
    await openGallery(pp);
    out.phone = JSON.stringify(await pp.evaluate(() => {
      const g = document.querySelector(".cv-gallery") as HTMLElement;
      const cs = Array.from(document.querySelectorAll<HTMLElement>(".cv-gallery-card")).map((c) => c.getBoundingClientRect());
      const perRow = cs.filter((r) => Math.abs(r.top - cs[0].top) < 2).length;
      return { doc: document.documentElement.scrollWidth, win: innerWidth, galleryW: Math.round(g.getBoundingClientRect().width), galleryScrollW: g.scrollWidth, perRow, cardW: Math.round(cs[0].width), minCardH: Math.round(Math.min(...cs.map((r) => r.height))) };
    }));
    await pp.locator(".cv-gallery").screenshot({ path: "/tmp/pw-output/col07-phone.png" });
    await phone.close();
  } finally {
    console.log(`AUDIT COL-07 ${JSON.stringify(out, null, 1)}`);
  }
});
