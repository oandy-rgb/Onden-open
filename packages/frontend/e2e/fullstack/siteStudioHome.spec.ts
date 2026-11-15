// The home-page studio (desktop, docs/architecture/proposals/publish-redesign-2026-10-24.md §7):
// every component only points at notes and tags, the canvas is the site's own
// rendering, and the design is saved as the workspace chrome (v: 2).
// Written for the P1b backend (GET /api/site design, /api/publish/include).
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { defaultSpaceId, ready, H } from "./helpers";


test.use({ viewport: { width: 1400, height: 900 } });

const stamp = Date.now();
let counter = 0;
const unique = (name: string) => `${name} ${stamp}-${++counter}`;

async function note(request: APIRequestContext, title: string, body: string, published: boolean): Promise<{ id: string; slug: string }> {
  // In 共用: a new note lands in the creator's 只有我, whose notes the studio does not list (it never publishes).
  const space_id = await defaultSpaceId(request);
  const created = (await (await request.post("/api/nodes", { ...H, data: { title, markdown: `# ${title}\n\n${body}`, space_id } })).json()) as { id: string; slug: string };
  if (published) await request.put(`/api/nodes/${created.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
  return created;
}
async function tagWith(request: APIRequestContext, name: string, noteIds: string[]): Promise<string> {
  const imported = await request.post("/api/tags/import", { ...H, data: { name, fields: [] } });
  const id = ((await imported.json()) as { id: string }).id;
  for (const noteId of noteIds) await request.put(`/api/nodes/${noteId}/tags/${id}`, { ...H, data: {} });
  return id;
}
const chrome = async (request: APIRequestContext) => ((await (await request.get("/api/workspace/config")).json()) as { chrome?: any }).chrome;
const resetDesign = (request: APIRequestContext) => request.patch("/api/workspace/config", { ...H, data: { chrome: null } }).catch(() => null);

/** The Puck studio is the old free-form home page editor: since the box model (2026-10-31) the website
 *  page opens the setup screen, and the studio is under 進階 › 舊的首頁畫布 (modules/website/WebsiteScreen). */
async function openStudio(page: Page) {
  await ready(page, "/?view=website");
  await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  await page.locator(".ss-advanced > summary").click({ timeout: 30_000 });
  await page.getByRole("button", { name: /^(Old home page canvas|舊的首頁畫布)$/ }).click();
  await expect(page.getByRole("region", { name: "首頁工作室" })).toBeVisible({ timeout: 30_000 });
}
const assets = (page: Page) => page.getByRole("complementary", { name: "區塊" });
/** 區塊 has two tabs: 零件 (the default) and 版面配置 (頁面結構, 排版, 現成區塊). */
const openTab = (page: Page, name: "零件" | "版面配置") => assets(page).getByRole("tab", { name }).click();
const canvas = (page: Page) => page.locator(".hs-canvas__frame");
/** Choose which note the selected block shows (the picker on the right). */
const pickNote = (page: Page, title: string) => page.getByRole("tabpanel").getByRole("button", { name: new RegExp(title) }).click();
/** A drawer entry. Puck draws each twice (the item and its drag copy): the visible last one is the one that drags. */
// A string matches the entry's own name, at the start of its text: another entry's description can mention it (三欄入口: 「…各連到一篇筆記」).
const entry = (page: Page, label: string | RegExp) => assets(page).locator("[data-puck-drawer-item]")
  .filter({ hasText: typeof label === "string" ? new RegExp(`^\\s*${label}`) : label }).filter({ visible: true }).last();

async function dragTo(page: Page, from: ReturnType<typeof entry>, to: { x: number; y: number }) {
  await from.waitFor({ state: "visible" }); // the drawer may still be laying out: no box yet
  const box = (await from.boundingBox())!;
  await from.hover();
  await page.mouse.down();
  await page.waitForTimeout(300);
  for (let i = 1; i <= 40; i++) {
    await page.mouse.move(box.x + box.width / 2 + ((to.x - box.x - box.width / 2) * i) / 40, box.y + box.height / 2 + ((to.y - box.y - box.height / 2) * i) / 40);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await page.waitForTimeout(500);
}
/** The free-form home page the old studio saved: since the box model (v3) the design keeps it as
 *  `legacy_home` (the server migrates the studio's v2-shaped save, @onden/site migrateV2). */
const savedHome = (c: any): any[] => (c?.v === 3 ? c.legacy_home?.content : c?.home?.content) ?? [];
const flatten = (items: any[]): any[] => items.flatMap((c) => [c, ...Object.values(c.props ?? {}).filter(Array.isArray).flatMap((list) => flatten(list as any[]))]);

test.beforeEach(async ({ page }) => { await resetDesign(page.request); });
test.afterEach(async ({ page }) => { await resetDesign(page.request); });

test("drag 一篇筆記 from 區塊 onto the home page, choose the note on the right: it shows that note, and is saved", async ({ page }) => {
  const title = unique("Dragged");
  const words = `dragged words ${stamp}`;
  await note(page.request, title, words, true);
  await openStudio(page);
  // The last slot on the page, or the page itself when the design has no parts yet.
  const zone = page.locator('[data-puck-dropzone$=":items"], [data-puck-dropzone="root:default-zone"]').last();
  await zone.waitFor({ state: "visible" });
  const box = (await zone.boundingBox())!;
  await dragTo(page, entry(page, "一篇筆記"), { x: box.x + box.width / 2, y: box.y + Math.max(box.height / 2, 4) });
  await canvas(page).locator(".s-missing").last().click();
  await pickNote(page, title);

  await expect(canvas(page)).toContainText(words, { timeout: 15_000 });
  await expect.poll(async () => {
    const c = await chrome(page.request);
    return flatten(savedHome(c)).some((x) => x.type === "note" && x.props.noteId !== "" && x.props.noteId !== undefined);
  }, { timeout: 20_000 }).toBe(true);
  // What was saved passes the server's own validation: it reads back as the same design.
  const saved = await chrome(page.request);
  expect(saved.studio_draft).toBe(true);
  expect(flatten(savedHome(saved)).filter((x) => x.type === "note").map((x) => x.props.display)).toContain("full");
});

test("change a tag view: pick a tag, change how it is shown, and the canvas follows", async ({ page }) => {
  const a = await note(page.request, unique("Tagged A"), "first", true);
  const b = await note(page.request, unique("Tagged B"), "second", true);
  const tagName = unique("studiotag");
  const tagId = await tagWith(page.request, tagName, [a.id, b.id]);
  await openStudio(page);

  await entry(page, "標籤的筆記").click();
  await canvas(page).locator(".s-missing").last().click();
  await page.getByRole("tabpanel").getByRole("button", { name: new RegExp(tagName) }).click();
  const view = canvas(page).locator(".s-view").last();
  await expect(view).toBeVisible({ timeout: 15_000 });
  await expect(view.locator(".s-list li")).toHaveCount(2);

  await view.click();
  const panel = page.getByRole("tabpanel");
  await panel.getByText("卡片", { exact: true }).click();
  await expect(canvas(page).locator(".s-view--cards .s-card")).toHaveCount(2, { timeout: 10_000 });

  await expect.poll(async () => {
    const c = await chrome(page.request);
    // The default page already lists the top tag (this one), so look at every view of it.
    return flatten(savedHome(c)).filter((x) => x.type === "tag_view" && x.props.tagId === tagId).map((x) => x.props.viewKind);
  }, { timeout: 20_000 }).toContain("cards");
});

test("the three settings: 氣質 and 重點色 change the canvas and the saved design; 淺｜深 changes only the preview", async ({ page }) => {
  await openStudio(page);
  const scope = page.locator(".site-scope").first();
  const prop = (name: string) => scope.evaluate((el, n) => (el as HTMLElement).style.getPropertyValue(n), name);
  const fontBefore = await prop("--s-font-h");
  await page.getByRole("group", { name: "氣質" }).getByRole("button", { name: /紙本/ }).click();
  await expect.poll(() => prop("--s-font-h")).not.toBe(fontBefore);
  await expect.poll(async () => (await chrome(page.request))?.style?.preset, { timeout: 20_000 }).toBe("paper");

  const accentBefore = await prop("--s-accent");
  await page.getByRole("group", { name: "重點色" }).getByRole("button", { name: "紅" }).click();
  await expect.poll(() => prop("--s-accent")).not.toBe(accentBefore);
  await expect.poll(async () => (await chrome(page.request))?.style?.accent, { timeout: 20_000 }).toBe("#b23a2a");

  const bgBefore = await prop("--s-bg");
  const saved = await chrome(page.request);
  const modeBefore = await scope.getAttribute("data-scheme");
  await page.getByRole("group", { name: "預覽配色" }).getByRole("button", { name: modeBefore === "dark" ? "淺" : "深" }).click();
  await expect.poll(() => prop("--s-bg")).not.toBe(bgBefore);
  await page.waitForTimeout(1500);
  expect((await chrome(page.request))?.style?.scheme).toBe(saved?.style?.scheme); // the switch is not saved

  await page.getByRole("group", { name: "配色" }).getByRole("button", { name: "深色" }).click();
  await expect.poll(async () => (await chrome(page.request))?.style?.scheme, { timeout: 20_000 }).toBe("dark");
});

test("site CSS applies live, an unbalanced block is held back with a reason, and the CSS is saved", async ({ page }) => {
  await openStudio(page);
  await page.getByText("自己寫樣式").click();
  const box = page.getByLabel(/寫在這裡的樣式/);
  const firstPart = canvas(page).locator(".s-part").first();

  await box.fill(".s-part { border-top: 7px solid rgb(1, 2, 3); }");
  await expect(firstPart).toHaveCSS("border-top-color", "rgb(1, 2, 3)");
  await expect(page.getByText("大括號沒有配對，先不套用")).toHaveCount(0);

  await box.fill(".s-part { border-top: 7px solid rgb(9, 9, 9); ");
  await expect(page.getByRole("alert")).toHaveText("大括號沒有配對，先不套用");
  // The earlier, balanced rule is not replaced by half a rule.
  await expect(firstPart).not.toHaveCSS("border-top-color", "rgb(9, 9, 9)");

  await box.fill(".s-part { border-top: 7px solid rgb(1, 2, 3); }");
  await expect.poll(async () => (await chrome(page.request))?.css, { timeout: 20_000 }).toContain("rgb(1, 2, 3)");
});

test("publish with a note that is not published: the review lists it and 一起發布 publishes it together", async ({ page }) => {
  const draftTitle = unique("Draft on home");
  const draftWords = `draft words ${stamp}`;
  const draft = await note(page.request, draftTitle, draftWords, false);
  await note(page.request, unique("Live note"), "live", true);
  await openStudio(page);

  // Put the unpublished note on the page (click: after the selection), and choose it on the right.
  await entry(page, "一篇筆記").click();
  await canvas(page).locator(".s-missing").last().click();
  await pickNote(page, draftTitle);
  // The canvas shows exactly what would be published: its title and 未發布, never the note's words.
  await expect(canvas(page).getByText("未發布")).toBeVisible({ timeout: 15_000 });
  await expect(canvas(page)).toContainText(draftTitle);
  await expect(canvas(page)).not.toContainText(draftWords);

  await page.locator(".pub-publish-button").click();
  const dialog = page.locator(".publish-preview-dialog");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  const refs = dialog.locator("section", { hasText: draftTitle }).filter({ has: page.getByRole("button", { name: /Publish together|一起發布/ }) });
  await expect(refs).toBeVisible();
  await refs.getByRole("button", { name: /Publish together|一起發布/ }).click();
  await expect(refs).toHaveCount(0, { timeout: 15_000 });

  await dialog.locator(".publish-preview-confirm").click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(async () => {
    const site = (await (await page.request.get("/api/site")).json()) as { payload?: { nodes?: Array<{ id: string }> } };
    return (site.payload?.nodes ?? []).some((n) => n.id === draft.id);
  }, { timeout: 20_000 }).toBe(true);
  // 「一起發布」 marked the note; it is not deleted or hidden.
  const marked = (await (await page.request.get("/api/bootstrap")).json()).nodes.find((n: { id: string }) => n.id === draft.id);
  expect(marked.attrs?._published).toBe("true");
});

test("the toolbar stays on one row at 1280 and 1440 px, and every field has a label", async ({ page }) => {
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await openStudio(page);
    const toolbar = (await page.locator(".hs-toolbar").boundingBox())!;
    expect(toolbar.height, `toolbar height at ${width}px`).toBeLessThan(64);
    for (const button of await page.locator(".hs-toolbar button, .hs-toolbar a").all()) {
      const b = await button.boundingBox();
      if (b) expect(b.height, "no button wraps into vertical text").toBeLessThan(48);
    }
  }
  const unlabeled = await page.getByRole("tabpanel").locator("input, select, textarea").evaluateAll((controls) =>
    controls.filter((c) => !(c.id && document.querySelector(`label[for="${c.id}"]`)) && !c.closest("label") && !c.closest("fieldset")).length);
  expect(unlabeled).toBe(0);
});

test("scrolling 區塊 leaves the canvas and the toolbar in place", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  await openStudio(page);
  const canvasTop = async () => (await canvas(page).boundingBox())!.y;
  const before = await canvasTop();
  await openTab(page, "版面配置"); // the long tab: 頁面結構 plus 排版 and 現成區塊
  await assets(page).hover();
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 600);
  await expect.poll(() => assets(page).evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
  expect(await canvasTop()).toBe(before);
  await expect(page.locator(".hs-toolbar")).toBeInViewport();
  expect(await page.evaluate(() => scrollY)).toBe(0);
});
