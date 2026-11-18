// Feature-audit deepening (2026-10-07): COL-07 — the saved-view Gallery:
// uploaded cover (only referenced from an attribute), broken and non-image
// cover values, no cover, long titles, an un-hinted image field, opening by
// mouse and keyboard, permission loss for a second human (reload and live),
// layout persistence across reload, phone viewport.
//
// 2026-11-18: every observation the probe printed is a check now (owner's order 「都改成檢查」). The rules: GalleryLayout.tsx (a bare media id is
// served from /api/media/<id>; no cover → the title's first letter), full-feature-audit.md COL-07 and GAP-158 / GAP-159, services/mediaAccess.ts
// (who may read an uploaded file). The three parts of GAP-159 that are still open are the FINDING tests at the end.
import { test, expect, type Page } from "@playwright/test";
import { ready, defaultSpaceId, addToDefaultSpace, hideFromOthers, openSavedViewTab, BASE, H } from "./helpers";
import { contextsClosedAfterEach, readyLive } from "./viewChecks";

// Every extra browser context a test opens is closed when the test ends, also when it stops at a failing line (see viewChecks.ts).
const newContext = contextsClosedAfterEach(test);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function setUp(page: Page) {
  const stamp = Date.now();
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `C07T${stamp}`, fields: [
    { name: "cover", type: "text" }, { name: "pic", type: "text" }, { name: "author", type: "text" },
  ] } })).json();
  const media = await (await page.request.post("/api/media", { headers: { origin: BASE }, multipart: { file: { name: `c${stamp}.png`, mimeType: "image/png", buffer: PNG } } })).json();
  // Default space: the second human below sees the gallery.
  const shared = await defaultSpaceId(page.request);
  const mk = async (title: string, a: Record<string, string> = {}) => {
    const n = await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: "plain body", space_id: shared } })).json();
    await page.request.put(`/api/nodes/${n.id}/tags/${tag.id}`, { ...H, data: {} });
    for (const [k, v] of Object.entries(a)) await page.request.put(`/api/nodes/${n.id}/attributes/${k}`, { ...H, data: { value: v, value_type: "text" } });
    return n.id as string;
  };
  // The first note that references the upload (here: Uploaded, in the shared space) is the one services/mediaAccess.ts asks about it.
  const idUp = await mk(`Uploaded ${stamp}`, { cover: media.url, author: "Ann" });
  await mk(`Bareid ${stamp}`, { cover: String(media.url).split("/").pop()! });
  await mk(`Broken ${stamp}`, { cover: "https://img.invalid/nope.png" });
  await mk(`Words ${stamp}`, { cover: "just some words" });
  await mk(`Pic ${stamp}`, { pic: media.url });
  const idNo = await mk(`None ${stamp}`, { author: "Bob" });
  const longTitle = `Long ${stamp} ` + "研究生讀書會長標題 averyveryverylongunbrokenwordwithoutanyspaces".repeat(5);
  await mk(longTitle);
  const idSecret = await mk(`Secret ${stamp}`, { cover: media.url, author: "Hidden" });
  const view = await (await page.request.post(`/api/tags/${tag.id}/views`, { ...H, data: { name: "G", layout: "gallery", visible_fields: ["title", "cover", "pic", "author"] } })).json();

  const openGallery = async (p: Page) => {
    await readyLive(p, `/?view=notes&node=${tag.id}`);
    await openSavedViewTab(p);
    await expect(p.locator(".cv-gallery")).toBeVisible({ timeout: 15_000 });
  };
  const cards = (p: Page) => p.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".cv-gallery-card")).map((c) => {
    const img = c.querySelector("img") as HTMLImageElement | null;
    return {
      t: (c.querySelector(".cv-gallery-title") as HTMLElement).innerText.split(" ")[0],
      img: img ? { loaded: img.complete && img.naturalWidth > 0, src: img.getAttribute("src") } : null,
      placeholder: (c.querySelector(".cv-gallery-cover-placeholder") as HTMLElement | null)?.innerText ?? null,
      badges: Array.from(c.querySelectorAll(".cv-gallery-badge")).map((b) => ({ key: (b.querySelector(".cv-gallery-badge-key") as HTMLElement).innerText, val: (b.querySelector(".cv-gallery-badge-val") as HTMLElement).innerText })),
    };
  }));
  // Images are lazy: ask for them all, then wait until each one has either loaded or failed.
  const settle = async (p: Page) => {
    await p.evaluate(() => { for (const i of Array.from(document.querySelectorAll("img"))) i.loading = "eager"; });
    await p.waitForFunction(() => Array.from(document.querySelectorAll<HTMLImageElement>(".cv-gallery-cover img")).every((i) => i.complete));
  };
  const titles = async (p: Page) => (await cards(p)).map((c) => c.t);
  return { stamp, tag, media, idUp, idNo, idSecret, view, openGallery, cards, settle, titles, shared };
}

test.describe("COL-07: saved-view gallery", () => {
  test.setTimeout(240_000);

  test("covers, no image, open, reload, permission loss, phone", async ({ page, browser }) => {
    const { stamp, tag, media, idUp, idNo, idSecret, view, openGallery, cards, settle, titles } = await setUp(page);
    // An upload is answered with its address under /api/media/ (mediaSrc: 「a bare media id is served from /api/media/<id>」), and serves.
    expect(media.url).toMatch(/^\/api\/media\/[0-9a-f]+\.\w+$/);
    expect((await page.request.get(media.url)).status()).toBe(200);
    await openGallery(page);
    await settle(page);
    const all = await cards(page);
    const card = (t: string) => all.find((c) => c.t === t)!;
    // The cards, in the view's order (title, then id).
    expect(all.map((c) => c.t)).toEqual(["Bareid", "Broken", "Long", "None", "Pic", "Secret", "Uploaded", "Words"]);
    // A cover given as the upload's address or as the bare id loads (COL-07: 「上傳圖以 /api/media/… 與裸 id 皆載入」); the cover field is
    // not repeated as a badge, other fields are (GalleryLayout.tsx badgeFields).
    for (const t of ["Uploaded", "Bareid", "Secret"]) {
      expect(card(t).img?.loaded, t).toBe(true);
      expect(card(t).img?.src, t).toBe(media.url);
    }
    expect(card("Bareid").badges).toEqual([]);
    expect(card("Uploaded").badges).toEqual([{ key: "author", val: "Ann" }]);
    expect(card("Secret").badges).toEqual([{ key: "author", val: "Hidden" }]);
    // The un-hinted `pic` field holding an image address is a cover too (GalleryLayout.tsx pickCover: 「the first field whose value looks like an image」).
    expect(card("Pic").img).toEqual({ loaded: true, src: media.url });
    // No cover: the title's first letter stands in (COL-07: 「無封面顯示首字佔位」), and the other fields still show.
    expect(card("None")).toMatchObject({ img: null, placeholder: "N", badges: [{ key: "author", val: "Bob" }] });
    expect(card("Long")).toMatchObject({ img: null, placeholder: "L" });
    // A long unbroken title does not make the page wider (the card clips it; whether it wraps is the FINDING below).
    const wide = await page.evaluate((s) => {
      const c = Array.from(document.querySelectorAll<HTMLElement>(".cv-gallery-card")).find((e) => e.innerText.includes(`Long ${s}`))!;
      return { doc: document.documentElement.scrollWidth, win: innerWidth, card: c.getBoundingClientRect().width, grid: (document.querySelector(".cv-gallery") as HTMLElement).getBoundingClientRect().width };
    }, String(stamp));
    expect(wide.doc).toBeLessThanOrEqual(wide.win);
    expect(wide.card).toBeLessThanOrEqual(wide.grid);
    // pinned: today's behaviour, no written rule — a title is cut to two lines.
    expect(await page.locator(".cv-gallery-title").first().evaluate((t) => getComputedStyle(t).webkitLineClamp)).toBe("2"); // pinned: today's behaviour, no written rule

    // Open by mouse, then by keyboard (COL-07: 「點卡片與 Tab 聚焦（:focus-visible 焦點環）後 Enter 開啟」).
    await page.locator(".cv-gallery-card", { hasText: `None ${stamp}` }).click();
    await expect(page).toHaveURL(new RegExp(`node=${idNo}`));
    await openGallery(page);
    const target = page.locator(".cv-gallery-card", { hasText: `Uploaded ${stamp}` });
    await page.locator(".cv-gallery-card", { hasText: `Secret ${stamp}` }).focus();
    await page.keyboard.press("Tab");
    const ring = await target.evaluate((e) => { const cs = getComputedStyle(e); return { active: document.activeElement === e, visible: e.matches(":focus-visible"), style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) }; });
    expect(ring.active).toBe(true);
    expect(ring.visible).toBe(true);
    expect(ring.style).not.toBe("none"); // the global focus ring shows on the focused card
    expect(ring.width).toBeGreaterThanOrEqual(2);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`node=${idUp}`));

    // Reload keeps the gallery (the tab is in the URL; COL-07: 「重載保持 gallery」). The probe also read a `.cv-layout-btn--active` that
    // the view no longer has (the layout is switched in the 「View options」 menu).
    await openGallery(page);
    await page.reload();
    await expect(page.locator(".cv-gallery")).toBeVisible();
    await expect(page.locator(".cv-gallery-card")).toHaveCount(8);

    // Second human (editor) sees the gallery, then loses read on Secret: the open gallery drops the card without a reload (GAP-158, fixed
    // 2026-10-18), and so do a reload and the view's own answer for that person (read policy bounds the rows).
    const human = await newContext(browser, { baseURL: BASE, storageState: { cookies: [], origins: [] } });
    const signup = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `C07 ${stamp}`, email: `c07-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
    const actor = await (await page.request.post("/api/actors", { ...H, data: { name: `C07 ${stamp}`, type: "human", external_id: signup.user.id } })).json();
    await addToDefaultSpace(page.request, actor.id); // a new member joins no space by itself (097)
    const hp = await human.newPage();
    await hp.addInitScript(() => localStorage.setItem("onden.welcomeDismissed", "1"));
    await openGallery(hp);
    expect(await titles(hp)).toEqual(["Bareid", "Broken", "Long", "None", "Pic", "Secret", "Uploaded", "Words"]);
    await hideFromOthers(page.request, idSecret);
    const without = ["Bareid", "Broken", "Long", "None", "Pic", "Uploaded", "Words"];
    await expect.poll(() => titles(hp), { timeout: 20_000 }).toEqual(without);
    await openGallery(hp);
    expect(await titles(hp)).toEqual(without);
    const rows = ((await (await hp.request.get(`/api/tags/${tag.id}/views/${view.id}/exec`)).json()).rows ?? []) as Array<{ title: string }>;
    expect(rows.map((r) => r.title.split(" ")[0])).toEqual(without);
    // The upload is still readable by that person: a file is readable when one of the notes that decide for it is (services/mediaAccess.ts:
    // here Uploaded, the first note that referenced it, which is still in the shared space), so hiding Secret takes nothing from them.
    expect((await hp.request.get(media.url)).status()).toBe(200);
    await human.close();

    // Phone: the page does not get wider and the cards fill the gallery's width (COL-07: 「390px 單欄…無溢出」).
    const phone = await newContext(browser, { storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE, hasTouch: true, isMobile: true });
    const pp = await phone.newPage();
    await openGallery(pp);
    const geo = await pp.evaluate(() => {
      const g = document.querySelector(".cv-gallery") as HTMLElement;
      const cs = Array.from(document.querySelectorAll<HTMLElement>(".cv-gallery-card")).map((c) => c.getBoundingClientRect());
      return { doc: document.documentElement.scrollWidth, gallery: g.getBoundingClientRect().width, scroll: g.scrollWidth, perRow: cs.filter((r) => Math.abs(r.top - cs[0].top) < 2).length, widest: Math.max(...cs.map((r) => r.width)) };
    });
    expect(geo.doc).toBeLessThanOrEqual(390);
    expect(geo.scroll).toBeLessThanOrEqual(geo.gallery + 1);
    expect(geo.widest).toBeLessThanOrEqual(geo.gallery + 1);
    expect(geo.perRow).toBe(1); // pinned: today's behaviour, no written rule — one card per row at 390px
    await phone.close();
  });

  // FINDING: full-feature-audit.md GAP-159 (「未修；`<img onError>` 退回佔位、只把像圖片的值當封面」): a cover that cannot be shown — an address that
  // does not load, or plain words — falls back to the title's first letter. What the app does instead: it draws a broken image (and for the
  // words an <img> with no address at all) and the placeholder is not there.
  test("FINDING: a cover that cannot be shown falls back to the first-letter placeholder", async ({ page }) => {
    test.fail();
    const { openGallery, cards, settle } = await setUp(page);
    await openGallery(page);
    await settle(page);
    const all = await cards(page);
    for (const t of ["Broken", "Words"]) expect(all.find((c) => c.t === t)?.placeholder, t).toBe(t[0]);
  });

  // FINDING: GAP-159 again (「封面欄不列徽章」): the field that gave the cover is not repeated as a badge. What the app does instead: a field
  // whose name does not hint at a cover (`pic`) is used as the cover and also listed, with the raw address, as a badge.
  test("FINDING: the field that supplied the cover is not repeated as a badge", async ({ page }) => {
    test.fail();
    const { openGallery, cards, settle } = await setUp(page);
    await openGallery(page);
    await settle(page);
    const pic = (await cards(page)).find((c) => c.t === "Pic")!;
    expect(pic.img?.loaded).toBe(true);
    expect(pic.badges.map((b) => b.key)).not.toContain("pic");
  });

  // FINDING: GAP-159 again (「標題 `overflow-wrap:anywhere`」): a long title with no spaces wraps inside its card. What the app does instead:
  // it is cut off sideways (the title's content is wider than its box).
  test("FINDING: a long unbroken title wraps inside its card", async ({ page }) => {
    test.fail();
    const { stamp, openGallery } = await setUp(page);
    await openGallery(page);
    const clipped = await page.evaluate((s) => {
      const c = Array.from(document.querySelectorAll<HTMLElement>(".cv-gallery-card")).find((e) => e.innerText.includes(`Long ${s}`))!;
      const t = c.querySelector(".cv-gallery-title") as HTMLElement;
      return t.scrollWidth > t.clientWidth + 1;
    }, String(stamp));
    expect(clipped).toBe(false);
  });
});
