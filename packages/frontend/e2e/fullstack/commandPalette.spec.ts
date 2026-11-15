import { test, expect, type Page } from "@playwright/test";
import { ready, H } from "./helpers";

// Behaviour-driven journeys over the ⌘K command palette — a high-frequency core
// surface barely covered before. Drive the real UI (keyboard + clicks) and
// assert the felt result. Per-test stamp keeps node titles unique against the
// shared onden_test DB so search matches exactly one row.

async function seed(page: Page, title: string) {
  return (await page.request.post("/api/nodes", { ...H, data: { title, markdown: `${title} body text` } })).json();
}

// 1 — ⌘K opens the palette + focuses the input; ⌘K again closes it.
test("Cmd/Ctrl+K toggles the palette and focuses the input", async ({ page }) => {
  await ready(page, "/?view=notes");

  // ⌘K is a window-level shortcut — fires even with the editor focused (verified:
  // opens in ~20ms, no CodeMirror interception, body untouched). The listener
  // attaches in a mount effect that can land after the shell is visible, so
  // poll the keypress until the palette actually opens.
  await expect(async () => {
    await page.keyboard.press("Control+k");
    await expect(page.locator(".palette-input-wrap input")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.locator(".palette-input-wrap input")).toBeFocused();

  await page.keyboard.press("Control+k");
  await expect(page.locator(".palette-modal")).toHaveCount(0); // toggled closed
});

// 2 — Searching a note and pressing Enter navigates to it.
test("searching a note and Enter opens it", async ({ page }) => {
  const stamp = Date.now();
  await seed(page, `Findme ${stamp}`);
  await ready(page, "/?view=notes");

  await page.locator(".palette-trigger").click(); // locator click auto-waits for the trigger
  await page.locator(".palette-input-wrap input").fill(`Findme ${stamp}`);
  const item = page.locator(".palette-item", { hasText: `Findme ${stamp}` });
  await expect(item).toBeVisible();             // live search returned the note
  await page.keyboard.press("Enter");           // highlighted (first) result

  await expect(page.locator(".palette-modal")).toHaveCount(0);                 // palette closed
  await expect(page.locator(".obsidian-title-input")).toHaveValue(`Findme ${stamp}`); // editor opened it
});

// 3 — Command mode (`>`) runs an action: "Go to Tasks" switches the lens.
test("command mode runs an action (Go to Tasks)", async ({ page }) => {
  await ready(page, "/?view=notes");

  await page.locator(".palette-trigger").click();
  await page.locator(".palette-input-wrap input").fill(">tasks");
  const action = page.locator(".palette-item", { hasText: "Go to Tasks" });
  await expect(action).toBeVisible();
  await action.click();

  await expect(page.locator(".palette-modal")).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("tasks"); // switched lens
});

// 4 — A query with no matching note offers to create that exact title.
test("a non-matching query can create a note and reopen it", async ({ page }) => {
  await ready(page, "/?view=notes");

  await page.locator(".palette-trigger").click();
  const title = `zzqqxnomatch${Date.now()}`;
  await page.locator(".palette-input-wrap input").fill(title);
  const create = page.locator(".palette-item", { hasText: `Create note: ${title}` });
  await expect(create).toBeVisible();
  await create.click();
  await expect(page.locator(".obsidian-title-input")).toHaveValue(title);
  await page.reload();
  await expect(page.locator(".obsidian-title-input")).toHaveValue(title);
});

// 5 — Arrow keys move the highlight through the results.
test("arrow keys move the active highlight", async ({ page }) => {
  const stamp = Date.now();
  await seed(page, `Alpha ${stamp}`);
  await seed(page, `Beta ${stamp}`);
  await seed(page, `Gamma ${stamp}`);
  await ready(page, "/?view=notes");

  await page.locator(".palette-trigger").click();
  await page.locator(".palette-input-wrap input").fill(stamp.toString()); // matches all three
  await expect(page.locator(".palette-item").first()).toBeVisible();

  const before = await page.locator(".palette-item.active").innerText();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".palette-item.active")).not.toHaveText(before); // highlight moved
});

// 6 — i18n: in the zh-TW locale the action labels + group headers translate
// (the labels recompute on the locale, not frozen in English).
test("palette labels and group headers localize to zh-TW", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("onden.locale", "zh-TW"));
  await ready(page, "/?view=notes");
  await page.waitForTimeout(800);

  await page.keyboard.press("Control+k");
  await page.locator(".palette-input-wrap input").fill(">");          // command mode: list actions
  // a translated action label and a translated group header are shown
  await expect(page.locator(".palette-item-label", { hasText: "前往任務" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".palette-group-header", { hasText: "導覽" })).toBeVisible();
  // filtering matches the translated label
  await page.locator(".palette-input-wrap input").fill(">前往任務");
  await expect(page.locator(".palette-item-label", { hasText: "前往任務" })).toBeVisible();
  // whole-note split / merge / send-to-Tasks are gone from the palette
  await page.locator(".palette-input-wrap input").fill(">依標題拆分");
  await expect(page.locator(".palette-item-label", { hasText: "依標題拆分筆記" })).toHaveCount(0);
});
