// P0-3 stage 2 — slim bootstrap + lazy body hydration. The app must stay
// CORRECT when running on the slim payload alone: opening a note whose body
// was stripped (?bodies=none) hydrates it through GET /api/nodes/:id before
// the editor seeds — never showing (or saving!) the empty placeholder.
// The full bootstrap is BLOCKED for the whole test, so any body that appears
// can only have come through the lazy door.
import { test, expect, type Page } from "@playwright/test";
import { openSidebarSearch, H } from "./helpers";


async function makeNode(page: Page, title: string, markdown: string) {
  return (await page.request.post("/api/nodes", { ...H, data: { title, markdown } })).json();
}

test("slim-only session: opening a note lazily hydrates its body (no wipe)", async ({ page }) => {
  const stamp = Date.now();
  const body = `lazy body content ${stamp} — survives the slim window`;
  const node = await makeNode(page, `LazyNote ${stamp}`, body);

  // Allow ONLY the slim bootstrap; the full fetch never lands.
  await page.route("**/api/bootstrap*", (route) => {
    if (route.request().url().includes("bodies=none")) return route.continue();
    return route.abort();
  });

  await page.goto("/?view=notes", { waitUntil: "load" });
  const shell = page.locator(".view-tabs, .app-topbar").first();
  const opfs = page.getByText("Use browser storage", { exact: false }).first();
  await shell.or(opfs).waitFor({ timeout: 30_000 });
  if (await opfs.isVisible().catch(() => false)) await opfs.click();
  await page.waitForSelector(".view-tabs, .app-topbar", { timeout: 20_000 });

  // Reach the slim row the way a person does in a big workspace — the sidebar
  // search. The tree is virtualized past 300 rows (and mid-suite the global
  // tree churns under parallel workers), so scroll-revealing a SPECIFIC
  // [data-sb-id] is hopeless; search is windowing-immune and clicking a
  // result runs the SAME onSelectNode lazy-hydrate path (titles ride the slim
  // payload, so the search matches without the body).
  async function openByTitle(title: string) {
    const box = await openSidebarSearch(page);
    await box.fill("");
    await box.click();
    await box.pressSequentially(title);
    await expect(box).toHaveValue(title);
    const hit = page.locator(".obsidian-search-row .obsidian-page-button", { hasText: title }).first();
    await hit.click({ timeout: 15_000 });
  }
  await openByTitle(`LazyNote ${stamp}`);

  // the editor shows the REAL body — proof it came through GET /api/nodes/:id
  await expect(page.locator(".cm-content")).toContainText(`lazy body content ${stamp}`, { timeout: 15_000 });

  // and the store row was hydrated IN PLACE, not wiped: clear the search,
  // re-find the row and re-open it. The body reappears from the hydrated store
  // row (markdown persisted, not re-stripped to the placeholder), proving the
  // round-trip never PATCHed an empty body back over it.
  await (await openSidebarSearch(page)).fill("");
  await openByTitle(`LazyNote ${stamp}`);
  await expect(page.locator(".cm-content")).toContainText("survives the slim window", { timeout: 15_000 });
});
