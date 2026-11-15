import { test, expect, type Page } from "@playwright/test";
import { openQuickCapture, openSidebarSearch, pollBootstrap, ready, seedLayout, titleTagAdd, titleTags, H } from "./helpers";
import { keysSeen, startIme, type Ime } from "./imeHelpers";

// IME composition in the app's single-line fields and sheets, driven in real Chromium:
// note title, sidebar search, ⌘K palette, "+ Tag", sidebar rename, quick capture,
// whiteboard card title, a note property. Every field must: keep the composition alive
// (no save or re-render replaces the field), let Enter pick the candidate without
// submitting, and submit on the Enter after that with exactly the final text.
// The ones that submit on Enter are the point; the title has no submit key.

test.use({ locale: "zh-TW" });

const STEPS = ["ㄋ", "ㄋㄧ", "你"];
const stamp = Date.now();

async function seedNote(page: Page, title: string, markdown = "x"): Promise<string> {
  const res = await page.request.post("/api/nodes", { ...H, data: { title, markdown } });
  expect(res.ok(), await res.text()).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}
const savedNode = async (page: Page, id: string) =>
  (await (await page.request.get(`/api/nodes/${id}`)).json()) as { title: string; markdown: string };
const openedNodeId = (page: Page) => new URL(page.url()).searchParams.get("node");

/** Compose 你 in the focused field and let Enter pick it: the field must still be open, holding 你. */
async function composeAndPick(ime: Ime, page: Page, field: ReturnType<Page["locator"]>): Promise<void> {
  await ime.composeSteps(STEPS);
  expect(await ime.composing()).toBe(true);
  await ime.pickWithEnter("你");
  await expect.poll(() => ime.composing()).toBe(false);
  expect(await keysSeen(page)).toContain("keydown:Enter:true");
  await expect(field).toHaveValue(/你$/);
}

test("title: a composition survives an autosave round trip and the final title is saved", async ({ page }) => {
  const id = await seedNote(page, `標題前${stamp}`);
  await ready(page, `/?view=notes&node=${id}`);
  const title = page.locator(".obsidian-title-input");
  const ime = await startIme(page);
  await title.click();
  await page.keyboard.press("End");
  await page.keyboard.type("A"); // a real edit, so a title save is due
  await ime.composeSteps(["ㄋ", "ㄋㄧ"]);
  // The save may carry the pending ㄋㄧ (the field's value) or not; either way the field must
  // keep composing and keep its text once the round trip is over.
  await expect.poll(async () => (await savedNode(page, id)).title, { timeout: 20_000 }).toContain(`標題前${stamp}A`);
  await page.waitForTimeout(1_500);
  expect(await ime.composing()).toBe(true);
  await expect(title).toHaveValue(`標題前${stamp}Aㄋㄧ`);
  await ime.composeSteps(["你"]);
  await ime.pickWithEnter("你");
  await expect(title).toBeFocused(); // Enter picked the candidate, it did not jump to the body
  await page.keyboard.type("Z");
  await expect.poll(async () => (await savedNode(page, id)).title, { timeout: 20_000 }).toBe(`標題前${stamp}A你Z`);
  await page.reload();
  await expect(page.locator(".obsidian-title-input")).toHaveValue(`標題前${stamp}A你Z`);
});

test("sidebar search: Enter mid-composition does not open a result; the next Enter does", async ({ page }) => {
  const id = await seedNote(page, `你好搜尋${stamp}`);
  await seedNote(page, `別的筆記${stamp}`);
  await ready(page);
  const search = await openSidebarSearch(page);
  const ime = await startIme(page);
  await search.click();
  await ime.composeSteps(["ㄋ", "ㄋㄧ", "你"]);
  await ime.pickWithEnter("你");
  await page.keyboard.type(`好搜尋${stamp}`);
  await expect(search).toHaveValue(`你好搜尋${stamp}`);
  expect(openedNodeId(page)).not.toBe(id); // the picking Enter opened nothing
  await expect(page.locator(".obsidian-search-result, .obsidian-page-button", { hasText: `你好搜尋${stamp}` }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect.poll(() => openedNodeId(page)).toBe(id);
});

test("⌘K palette: Enter mid-composition does not run the top result; the next Enter does", async ({ page }) => {
  const id = await seedNote(page, `你好面板${stamp}`);
  await ready(page);
  await expect(async () => {
    await page.keyboard.press("Control+k");
    await expect(page.locator(".palette-input-wrap input")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  const input = page.locator(".palette-input-wrap input");
  const ime = await startIme(page);
  await ime.composeSteps(["ㄋ", "ㄋㄧ", "你"]);
  await ime.pickWithEnter("你");
  await page.keyboard.type(`好面板${stamp}`);
  await expect(input).toHaveValue(`你好面板${stamp}`);
  await expect(page.locator(".palette-modal")).toBeVisible();
  expect(openedNodeId(page)).not.toBe(id);
  await expect(page.locator(".palette-item", { hasText: `你好面板${stamp}` }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect.poll(() => openedNodeId(page)).toBe(id);
});

test("+ Tag under the title: Enter mid-composition adds nothing; the next Enter creates the tag", async ({ page }) => {
  const id = await seedNote(page, `加標籤${stamp}`);
  await ready(page, `/?view=notes&node=${id}`);
  const row = titleTags(page);
  await (await titleTagAdd(page)).click(); // a note without tags shows ＋ only while the title area is pointed at
  const input = row.locator(".title-tag-input");
  const ime = await startIme(page);
  await expect(input).toBeFocused();
  await composeAndPick(ime, page, input);
  await expect(input).toBeVisible(); // still open
  await expect(row.locator(".prop-tag", { hasText: "你" })).toHaveCount(0);
  await page.keyboard.type(`標${stamp}`);
  await page.keyboard.press("Enter");
  await expect(row.locator(".prop-tag", { hasText: `#你標${stamp}` })).toBeVisible();
});

test("sidebar rename: Enter mid-composition keeps the field open; the next Enter saves the final title", async ({ page }) => {
  const id = await seedNote(page, `舊名${stamp}`);
  // A big shared workspace windows the tree (past 300 rows only a scroll window is in the
  // DOM) and keeps growing while other specs seed notes, so the row at the far end slides
  // out of the window under the pointer. Newest-first (this device's 排序 › 建立時間) puts
  // the fresh note at the top, where it stays rendered.
  await page.addInitScript(() => { try { localStorage.setItem("onden.sidebar.sort", "created"); } catch { /* storage unavailable */ } });
  await ready(page, `/?view=notes&node=${id}`);
  const rowOf = page.locator(".obsidian-sidebar .obsidian-page-button", { hasText: `舊名${stamp}` }).first();
  await expect(rowOf).toBeVisible();
  await rowOf.click({ button: "right" });
  await page.locator(".ctx-menu").getByRole("menuitem", { name: "重新命名", exact: true }).click();
  const input = page.locator(".sb-rename-input");
  await expect(input).toBeFocused();
  await input.fill("");
  const ime = await startIme(page);
  await composeAndPick(ime, page, input);
  await expect(input).toBeVisible(); // the picking Enter did not commit
  await page.keyboard.type(`新名${stamp}`);
  await page.keyboard.press("Enter");
  await expect(input).toHaveCount(0);
  await expect.poll(async () => (await savedNode(page, id)).title).toBe(`你新名${stamp}`);
});

test("quick capture: Enter mid-composition adds no line; Ctrl+Enter mid-composition does not save", async ({ page }) => {
  // The box clears after a send and stays open for the next one (QuickCapture.tsx).
  await ready(page);
  await openQuickCapture(page);
  const text = page.locator(".quick-capture-textarea");
  await text.click();
  const ime = await startIme(page);
  await ime.composeSteps(STEPS);
  await ime.pickWithEnter("你");
  await expect(text).toHaveValue("你"); // no newline
  await ime.composeSteps(["ㄏ", "ㄏㄠ", "好"]);
  await page.keyboard.press("Control+Enter"); // reaches the page with isComposing
  await expect(page.locator(".quick-capture-overlay")).toBeVisible();
  await ime.commit("好");
  await expect(text).toHaveValue(`你好`);
  await page.keyboard.type(String(stamp));
  await page.keyboard.press("Control+Enter");
  await expect(text).toHaveValue(""); // sent: the box is empty again, still open
  await expect(page.locator(".quick-capture-overlay")).toBeVisible();
  const captured = await pollBootstrap(page, (b) =>
    (b.nodes as Array<{ id: string; title: string }>).find((n) => n.title.includes(`你好${stamp}`)), { timeout: 20_000 });
  expect((await savedNode(page, captured.id)).markdown).toContain(`你好${stamp}`);
  expect((await savedNode(page, captured.id)).markdown).not.toContain("ㄏ");
});

test("whiteboard card title: Enter mid-composition keeps editing; the next Enter saves", async ({ page }) => {
  const nodeId = await seedNote(page, `卡片${stamp}`);
  const board = await (await page.request.post("/api/canvases", { ...H, data: { title: `IME 白板 ${stamp}` } })).json() as { id: string };
  const layout = await seedLayout(page.request, board.id, { ...H, data: { data: { nodes: [{ nodeId, x: 60, y: 60, width: 240 }], edges: [] } } });
  expect(layout.ok(), await layout.text()).toBeTruthy();
  await ready(page, `/?view=notes&node=${board.id}`);
  // A canvas is a lens of its note now: open it from the tab strip.
  await page.locator(".view-tabs, [role=tablist]").getByRole("tab", { name: /白板|Canvas/ }).or(page.getByRole("button", { name: /^(白板|Canvas)$/ })).first().click();
  await page.locator(".react-flow__node").first().waitFor({ timeout: 30_000 });
  await page.locator(".react-flow__node").first().click();
  const input = page.locator(".card-node-title-input").first();
  await input.click();
  await input.fill("");
  const ime = await startIme(page);
  await composeAndPick(ime, page, input);
  await expect(input).toBeFocused(); // Enter would have blurred (saved) it
  await page.keyboard.type(`卡${stamp}`);
  await page.keyboard.press("Enter");
  await expect(input).not.toBeFocused();
  await expect.poll(async () => (await savedNode(page, nodeId)).title, { timeout: 20_000 }).toBe(`你卡${stamp}`);
});

test("note property: Enter mid-composition keeps the cell open; the next Enter saves the value", async ({ page }) => {
  const key = `city_${stamp}`;
  const tag = await (await page.request.post("/api/tags/import", {
    ...H, data: { name: `地點${stamp}`, fields: [{ name: key, type: "text", label: `城市 ${stamp}` }] },
  })).json() as { id: string };
  const id = await seedNote(page, `屬性${stamp}`);
  await page.request.put(`/api/nodes/${id}/tags/${tag.id}`, { ...H, data: {} });
  await ready(page, `/?view=notes&node=${id}`);
  const cell = page.locator(".ff-cell", { hasText: `城市 ${stamp}` });
  await cell.click();
  const input = page.locator(".ff-cell--editing input");
  await expect(input).toBeFocused(); // pressing the cell puts the caret in its field (FeaturedFields)
  const ime = await startIme(page);
  await composeAndPick(ime, page, input);
  await expect(page.locator(".ff-cell--editing")).toBeVisible(); // not committed yet
  await page.keyboard.type("市");
  await page.keyboard.press("Enter");
  await expect.poll(async () => {
    const attrs = (await (await page.request.get(`/api/nodes/${id}/attributes`)).json()) as Array<{ key: string; value: string }>;
    return attrs.find((a) => a.key === key)?.value;
  }, { timeout: 20_000 }).toBe("你市");
});

test("view tab rename: Enter mid-composition keeps the field open; Escape mid-composition does not cancel the rename", async ({ page }) => {
  const parent = await seedNote(page, `視圖${stamp}`, "");
  await page.request.post("/api/nodes", { ...H, data: { title: `子筆記${stamp}`, markdown: "", parent_id: parent } });
  await ready(page, `/?view=notes&node=${parent}`);
  const tabs = page.getByRole("tablist", { name: new RegExp(`視圖${stamp}`) });
  await page.locator(".view-tabs .view-tab--add").click();
  await page.getByRole("dialog").getByRole("button", { name: /表格|Table/ }).first().click();
  const tab = tabs.getByRole("tab").nth(1);
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await tab.click({ button: "right" });
  await page.getByRole("menuitem", { name: /重新命名|Rename/ }).click();
  const field = page.locator(".view-tab-rename");
  await field.fill("");
  const ime = await startIme(page);
  await ime.composeSteps(STEPS);
  await ime.escapeWhileComposing(); // closes the candidate list only
  await expect(field).toBeVisible();
  await ime.pickWithEnter("你");
  await expect(field).toBeVisible(); // the picking Enter did not finish the rename
  await expect(field).toHaveValue("你");
  await page.keyboard.type("表");
  await page.keyboard.press("Enter");
  await expect(tabs.getByRole("tab", { name: "你表" })).toBeVisible();
});

test("AI conversation box: Enter mid-composition sends nothing; the next Enter sends the final text", async ({ page }) => {
  // The AI service is a stand-in (this stack has no AI role): the box and its Enter rule are what is under test.
  const id = await seedNote(page, `問AI${stamp}`);
  await ready(page);
  const imported = await page.request.patch("/api/workspace/modules", {
    headers: { origin: new URL(page.url()).origin, "content-type": "application/json" }, data: { module: "ai", imported: true },
  });
  expect(imported.ok(), "turning AI on needs the owner").toBe(true);
  const asked: string[] = [];
  await page.route(`**/api/ai/panel-chat/${id}/roles`, (route) => route.fulfill({ json: { roles: [{
    actor_id: "r1", handle: "ai", name: "小助手", default_runtime: "mcp", reason: null, model_name: null,
    runtimes: [{ kind: "mcp", available: true, unavailable_reason: null }],
  }] } }));
  await page.route(`**/api/ai/panel-chat/${id}`, (route) => route.fulfill({ json: { turns: [] } }));
  await page.route("**/api/ai/panel-chat", (route) => {
    asked.push((route.request().postDataJSON() as { text: string }).text);
    return route.fulfill({ json: { session_id: "s1", created: true } });
  });
  await ready(page, `/?view=notes&node=${id}`);
  await page.getByRole("tab", { name: "AI" }).first().click();
  const box = page.getByRole("textbox", { name: "問 AI" });
  await box.click();
  const ime = await startIme(page);
  await ime.composeSteps(STEPS);
  await ime.pickWithEnter("你"); // the picking Enter reaches the page with isComposing
  await expect(box).toHaveValue("你");
  expect(asked).toEqual([]);
  await page.keyboard.press("Enter");
  await expect.poll(() => asked).toEqual(["你"]);
});
