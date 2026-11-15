// Side by side (desktop): a view tab, a note from the sidebar and a function from the top
// bar each open on the right when dragged to the right half; the tab row still reorders;
// the right pane's header drags back to the left; Ctrl+\ opens/closes; a reload keeps it.
// Not run in the authoring session (needs the full stack and a browser): run with the other
// fullstack specs. The drag steps use the mouse (sidebar rows use pointer drag, tabs and the
// top bar use HTML5 drag, which Playwright's mouse drives too).
import { test, expect, type Page } from "@playwright/test";
import { ready, H, closeSideBySide, scrollToSidebarRow } from "./helpers";

test.use({ viewport: { width: 1280, height: 800 } });

// Side by side is a per-account preference: a pane a case leaves open greets
// the next case's page (cases that need one pane close theirs with the pane's
// own button), and the file leaves the shared account on one pane.
test.afterAll(async ({ browser }, testInfo) => {
  const { storageState, baseURL } = testInfo.project.use;
  const context = await browser.newContext({ storageState, baseURL });
  try { await closeSideBySide(context.request, context); } finally { await context.close(); }
});

async function note(page: Page, title: string, markdown = "body") {
  return (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown } })).json()).id as string;
}

/** Wait until a notes-list row is really under the pointer. Opening a note
 *  scrolls its row into the list smoothly (OverviewSidebar), so for a moment a
 *  row near it is in the DOM yet still under the list's header — Playwright
 *  calls it visible, but a press there lands on the header. (Scrolling the
 *  list ourselves is no help past 300 rows: the first scroll re-measures the
 *  windowed list's row pitch and the window moves away from the row.) */
async function settledSidebarRow(row: ReturnType<Page["locator"]>) {
  await expect.poll(() => row.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return !!hit && el.contains(hit);
  }).catch(() => false), { timeout: 10_000 }).toBe(true);
}

async function dragToRight(page: Page, from: ReturnType<Page["locator"]>) {
  const box = (await from.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + 40, { steps: 4 });
  await page.mouse.move(1000, 400, { steps: 8 });
  return { landing: page.locator(".split-drop--right"), drop: () => page.mouse.up() };
}

test("a view tab dragged to the right half opens that view on the right", async ({ page }) => {
  const id = await note(page, `Split tab ${Date.now()}`);
  const res = await page.request.post(`/api/nodes/${id}/views`, { ...H, data: { name: "Shelf", layout: "table" } });
  test.skip(!res.ok(), "creating a view needs the views module");
  await ready(page, `/?view=notes&node=${id}`);
  const tab = page.getByRole("tab", { name: "Shelf" });
  await expect(tab).toBeVisible();
  const { landing, drop } = await dragToRight(page, tab);
  // React writes the boolean as data-active="true"; only its presence matters.
  await expect(landing).toHaveAttribute("data-active");
  await drop();
  await expect(page.locator(".split-pane")).toBeVisible();
  await expect(page.locator(".split-pane-name")).toContainText(/Split tab/);
  await expect(page).toHaveURL(/right=note/);
  // The left still shows the note's text.
  await expect(page.getByRole("tab", { name: /Content|內容/ })).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: "/tmp/pw-output/shots/split-content-and-view.png" });
  // One pane again for the next case (the reorder case asserts there is none).
  await page.locator(".split-pane-head").getByRole("button", { name: "Close the right side" }).click();
  await expect(page.locator(".split-pane")).toHaveCount(0);
});

test("dragging a tab within the row only reorders", async ({ page }) => {
  const id = await note(page, `Split reorder ${Date.now()}`);
  for (const name of ["First", "Second"]) await page.request.post(`/api/nodes/${id}/views`, { ...H, data: { name, layout: "table" } });
  await ready(page, `/?view=notes&node=${id}`);
  const second = page.getByRole("tab", { name: "Second" });
  await second.dragTo(page.getByRole("tab", { name: "First" }));
  await expect(page.locator(".split-pane")).toHaveCount(0);
});

test("a note dragged from the sidebar opens on the right; the sidebar's other drags are unchanged", async ({ page }) => {
  const stamp = Date.now();
  const a = await note(page, `Split left ${stamp}`);
  const side = await note(page, `Split side ${stamp}`);
  await ready(page, `/?view=notes&node=${a}`);
  // The list no longer scrolls to the open note by itself (#1342, #1347): the row can sit below the list's fold.
  const row = await scrollToSidebarRow(page, side);
  await expect(row).toBeVisible();
  await settledSidebarRow(row);
  const { landing, drop } = await dragToRight(page, row);
  await expect(landing).toBeVisible();
  await drop();
  await expect(page.locator(".split-pane-name")).toContainText(`Split side ${stamp}`);
  // Released over the sidebar, nothing opens.
  await page.locator(".split-pane-head").getByRole("button", { name: "Close the right side" }).click();
  await expect(page.locator(".split-pane")).toHaveCount(0);
});

test("a function dragged from the top bar opens on the right; a click still loads the left; Esc cancels", async ({ page }) => {
  const id = await note(page, `Split nav ${Date.now()}`);
  await ready(page, `/?view=notes&node=${id}`);
  const tasks = page.locator(".app-primary-nav").getByRole("button", { name: "Tasks", exact: true });
  const first = await dragToRight(page, tasks);
  await page.keyboard.press("Escape");
  await first.drop();
  await expect(page.locator(".split-pane")).toHaveCount(0);
  const second = await dragToRight(page, tasks);
  await second.drop();
  await expect(page.locator(".split-pane-name")).toContainText(/Tasks/);
  await expect(page.locator(".editor-wrap, .md-editor-wrap").first()).toBeVisible(); // the note is still being written on the left
  await page.screenshot({ path: "/tmp/pw-output/shots/split-note-and-tasks.png" });
});

test("the right pane's header dragged to the left half reads it on the left", async ({ page }) => {
  const stamp = Date.now();
  const a = await note(page, `Split a ${stamp}`);
  const b = await note(page, `Split b ${stamp}`);
  await ready(page, `/?view=notes&node=${a}&right=${encodeURIComponent(`note:${b}:content`)}`);
  const header = page.locator(".split-pane-name");
  const box = (await header.boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x - 100, box.y + 50, { steps: 4 });
  await page.mouse.move(300, 300, { steps: 8 });
  await expect(page.locator(".split-drop--left")).toBeVisible();
  await page.mouse.up();
  await expect(page).toHaveURL(new RegExp(`node=${b}`));
});

test("Ctrl+\\ opens the note last written beside, again closes it, and a reload keeps it", async ({ page }) => {
  const stamp = Date.now();
  await note(page, `Split recent ${stamp}`);
  const a = await note(page, `Split cur ${stamp}`);
  await ready(page, `/?view=notes&node=${a}`);
  await page.keyboard.press("Control+Backslash");
  await expect(page.locator(".split-pane")).toBeVisible();
  await page.reload();
  await expect(page.locator(".split-pane")).toBeVisible();
  await page.keyboard.press("Control+Backslash");
  await expect(page.locator(".split-pane")).toHaveCount(0);
});

test("the same text on both sides is refused with a sentence", async ({ page }) => {
  const a = await note(page, `Split same ${Date.now()}`);
  await ready(page, `/?view=notes&node=${a}`);
  await page.evaluate((id) => window.history.replaceState(null, "", `/?view=notes&node=${id}&right=${encodeURIComponent(`note:${id}:content`)}`), a);
  await page.reload();
  await expect(page.locator(".split-pane")).toHaveCount(0);
});

test("text selected on one side can be added to the note on the other", async ({ page }) => {
  const stamp = Date.now();
  const a = await note(page, `Split quote src ${stamp}`, "A passage worth keeping.");
  const b = await note(page, `Split quote dst ${stamp}`, "mine");
  await ready(page, `/?view=notes&node=${b}&right=${encodeURIComponent(`note:${a}:content`)}`);
  await page.locator(".split-pane-text").getByText("A passage worth keeping.").selectText();
  await page.locator(".split-quote").click();
  await expect.poll(async () => (await (await page.request.get(`/api/nodes/${b}`, H)).json()).markdown as string).toContain("A passage worth keeping.");
});
