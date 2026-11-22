// 簡報編輯（只有一份文字）: the note's text on the left and its 簡報 view on the right (並排).
// The slides follow the caret; a thumbnail scrolls the text; moving a slide changes the note's text and survives a reload.
// Not run in the authoring session (needs the full stack and a browser): run with the other fullstack specs.
import { test, expect, type Page } from "@playwright/test";
import { ready, H, closeSideBySide } from "./helpers";

test.use({ viewport: { width: 1280, height: 800 } });

test.afterAll(async ({ browser }, testInfo) => {
  const { storageState, baseURL } = testInfo.project.use;
  const context = await browser.newContext({ storageState, baseURL });
  try { await closeSideBySide(context.request, context); } finally { await context.close(); }
});

const MD = "## Alpha\n- a1\n\n---\n\n## Beta\n- b1\n\n---\n\n## Gamma\n- g1\n";

async function deck(page: Page) {
  const id = (await (await page.request.post("/api/nodes", { ...H, data: { title: `Deck ${Date.now()}`, markdown: MD } })).json()).id as string;
  const view = await page.request.post(`/api/nodes/${id}/views`, { ...H, data: { name: "Slides", layout: "slides" } });
  test.skip(!view.ok(), "the slides view needs the slides module");
  const viewId = (await view.json()).id as string;
  return { id, viewId };
}
const thumbs = (page: Page) => page.locator(".split-pane .sp-thumbs .sp-hit");
const selected = (page: Page) => page.locator(".split-pane .sp-thumbs .sp-hit[aria-current='true']");
const editorText = (page: Page) => page.locator(".cm-content").innerText();

test("the slides beside the text follow the caret, and a thumbnail scrolls the text", async ({ page }) => {
  const { id, viewId } = await deck(page);
  await ready(page, `/?view=notes&node=${id}&right=${encodeURIComponent(`note:${id}:${viewId}`)}`);
  await expect(thumbs(page)).toHaveCount(3);
  await page.locator(".cm-content").getByText("b1").click();
  await expect(selected(page)).toHaveAccessibleName(/2/);
  await page.locator(".cm-content").getByText("g1").click();
  await expect(selected(page)).toHaveAccessibleName(/3/);
  await expect(page.locator(".split-pane .sp-follow")).toContainText(/3.*3/); // 第 3／共 3 頁
  // Switched off, the slides stay where they are.
  await page.locator(".split-pane").getByRole("switch", { name: /Follow|跟著游標/ }).click();
  await page.locator(".cm-content").getByText("a1").click();
  await expect(selected(page)).toHaveAccessibleName(/3/);
  await page.screenshot({ path: "/tmp/pw-output/shots/slides-follow-caret.png" });
});

test("moving a slide changes the note's text, can be undone, and is still there after a reload", async ({ page }) => {
  const { id, viewId } = await deck(page);
  await ready(page, `/?view=notes&node=${id}&right=${encodeURIComponent(`note:${id}:${viewId}`)}`);
  await thumbs(page).nth(1).click();
  await page.locator(".split-pane").getByRole("button", { name: /Move up|上移/ }).click();
  await expect.poll(() => editorText(page)).toMatch(/Beta[\s\S]*Alpha[\s\S]*Gamma/);
  await expect(page.getByRole("button", { name: /Undo|復原/ })).toBeVisible();
  await page.screenshot({ path: "/tmp/pw-output/shots/slides-move-undo.png" });
  await page.getByRole("button", { name: /Undo|復原/ }).click();
  await expect.poll(() => editorText(page)).toMatch(/Alpha[\s\S]*Beta[\s\S]*Gamma/);
  await thumbs(page).nth(2).click();
  await page.locator(".split-pane").getByRole("button", { name: /Move up|上移/ }).click();
  await expect.poll(() => editorText(page)).toMatch(/Alpha[\s\S]*Gamma[\s\S]*Beta/);
  // The text is saved: it reads the same from the server after a reload.
  await expect.poll(async () => (await (await page.request.get(`/api/nodes/${id}`)).json()).markdown, { timeout: 10_000 }).toBe("## Alpha\n- a1\n\n---\n\n## Gamma\n- g1\n\n---\n\n## Beta\n- b1\n");
  await page.reload();
  await expect.poll(() => editorText(page)).toMatch(/Alpha[\s\S]*Gamma[\s\S]*Beta/);
});

test("copy, delete and add a slide", async ({ page }) => {
  const { id, viewId } = await deck(page);
  await ready(page, `/?view=notes&node=${id}&right=${encodeURIComponent(`note:${id}:${viewId}`)}`);
  const tools = page.locator(".split-pane");
  await thumbs(page).nth(0).click();
  await tools.getByRole("button", { name: /Copy this slide|複製這一頁/ }).click();
  await expect(thumbs(page)).toHaveCount(4);
  await tools.getByRole("button", { name: /Delete this slide|刪除這一頁/ }).click();
  await expect(thumbs(page)).toHaveCount(3);
  await tools.getByRole("button", { name: /Add a slide$|新增一頁$/ }).click();
  await expect(thumbs(page)).toHaveCount(4);
  await expect.poll(() => editorText(page)).toMatch(/Gamma[\s\S]*(New slide|新的一頁)/);
});
