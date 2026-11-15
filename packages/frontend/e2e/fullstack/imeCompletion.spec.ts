import { test, expect, type Page } from "@playwright/test";
import { ready, H } from "./helpers";
import { keysSeen, startIme } from "./imeHelpers";

// The editor's completion menus (`/` commands, `[[` links, `#` tags, `@` mentions) while the
// query is being composed in Chinese. While composing, Enter belongs to the input method:
// it picks a candidate, it must not pick a menu item. Once the text is final, the menu
// filters by it and Enter chooses as usual. Chinese labels need the zh-TW interface.

test.use({ locale: "zh-TW" });

const menu = (page: Page) => page.locator(".slash-menu-item");
const menuTexts = async (page: Page) => (await menu(page).allInnerTexts()).map((s) => s.replace(/\s+/g, " ").trim());

async function openEmptyNote(page: Page, markdown = ""): Promise<string> {
  const note = await (await page.request.post("/api/nodes", {
    ...H, data: { title: `IME menu ${Date.now()}`, markdown },
  })).json() as { id: string };
  await ready(page, `/?view=notes&node=${note.id}`);
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  return note.id;
}
const savedMarkdown = async (page: Page, id: string): Promise<string> =>
  ((await (await page.request.get(`/api/nodes/${id}`)).json()) as { markdown: string }).markdown;

async function seedNote(page: Page, title: string): Promise<void> {
  const res = await page.request.post("/api/nodes", { ...H, data: { title, markdown: "x" } });
  expect(res.ok(), await res.text()).toBeTruthy();
}

const ZHUYIN = ["ㄋ", "ㄋㄧ", "你"];
const stamp = Date.now();

test.beforeAll(async ({ request }) => {
  for (const title of [`你好世界${stamp}`, `再見${stamp}`]) {
    const res = await request.post("/api/nodes", { ...H, data: { title, markdown: "x" } });
    expect(res.ok(), await res.text()).toBeTruthy();
  }
  for (const name of [`你好標籤${stamp}`, `再見標籤${stamp}`]) {
    const res = await request.post("/api/tags/import", { ...H, data: { name, fields: [] } });
    expect(res.ok(), await res.text()).toBeTruthy();
  }
});

/** The text the person sees in the line the menu hangs from. */
const lineText = (page: Page) => page.locator(".cm-content").innerText();

test("menu: / command — Enter mid-composition picks the candidate, not a command", async ({ page }) => {
  const id = await openEmptyNote(page);
  const ime = await startIme(page);
  await page.keyboard.type("/");
  await ime.composeSteps(["ㄅ", "ㄅㄧ", "標"]);
  await expect(menu(page).first()).toBeVisible();
  await ime.pickWithEnter("標");
  expect(await keysSeen(page)).toContain("keydown:Enter:true");
  expect(await lineText(page)).toContain("/標");
  expect(await menuTexts(page)).toEqual(["標題 1", "標題 2", "標題 3"]); // filtered by the final text
  await page.waitForTimeout(1_500);
  await page.keyboard.press("Enter"); // now Enter chooses the first command
  await expect.poll(() => savedMarkdown(page, id), { timeout: 20_000 }).toBe("# ");
});

test("menu: [[ link — composed query filters by the final text, Enter then links the note", async ({ page }) => {
  const id = await openEmptyNote(page);
  const ime = await startIme(page);
  await page.keyboard.type("[[");
  await ime.composeSteps(ZHUYIN);
  await ime.pickWithEnter("你");
  expect(await lineText(page)).toContain("[[你");
  const items = (await menuTexts(page)).join("\n");
  expect(items).toContain("你好世界");
  expect(items).not.toContain("再見");
  await page.waitForTimeout(1_500);
  await page.keyboard.press("Enter");
  // Enter links the first match of 你: other specs on the same stack leave their own 你… notes (你好搜尋…), which may rank first.
  await expect.poll(() => savedMarkdown(page, id), { timeout: 20_000 }).toMatch(/^\[\[你[^\]\n]+\]\]$/);
});

test("menu: { block tag — composed query filters by the final text, Enter then writes the tag", async ({ page }) => {
  const id = await openEmptyNote(page);
  const ime = await startIme(page);
  await page.keyboard.type("{");
  await ime.composeSteps(ZHUYIN);
  await ime.pickWithEnter("你");
  expect(await lineText(page)).toContain("{你");
  const items = (await menuTexts(page)).join("\n");
  expect(items).toContain("你好標籤");
  expect(items).not.toContain("再見");
  await page.waitForTimeout(1_500);
  await page.keyboard.press("Enter");
  await expect.poll(() => savedMarkdown(page, id), { timeout: 20_000 }).toMatch(/^\{你好標籤\d+\}$/); // a body # is Markdown: no list, only { tags a paragraph
});

// Without an AI set up the @ menu holds only a hint row: Enter on it must still never turn
// the composed word into a mention. (Rows for a configured AI are not covered here.)
test("menu: @ mention — a composed word stays text", async ({ page }) => {
  const id = await openEmptyNote(page);
  const ime = await startIme(page);
  await page.keyboard.type("@");
  await ime.composeSteps(ZHUYIN);
  await ime.pickWithEnter("你");
  expect(await lineText(page)).toContain("@你");
  await expect.poll(() => savedMarkdown(page, id), { timeout: 20_000 }).toBe("@你");
});

test("menu: / command — Escape and a cancelled composition leave the menu usable", async ({ page }) => {
  const id = await openEmptyNote(page);
  const ime = await startIme(page);
  await page.keyboard.type("/");
  await ime.composeSteps(["ㄅ", "ㄅㄧ"]);
  await ime.escapeWhileComposing();
  await ime.cancel();
  await expect.poll(() => ime.composing()).toBe(false);
  expect(await lineText(page)).not.toContain("ㄅ");
  await page.keyboard.type("h");
  await expect(menu(page).first()).toBeVisible(); // still a "/" menu
  await expect.poll(() => savedMarkdown(page, id), { timeout: 20_000 }).toBe("/h");
});
