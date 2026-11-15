// SCREENSHOT-ONLY UX/UI audit corpus. Drives the wired stack and captures the
// main surfaces in BOTH themes (+ a couple mobile viewports) so an external
// review pass has real visual artifacts to critique. Not an assertion spec —
// every surface is best-effort (try/catch) so one flaky surface never aborts
// the whole capture run. Shots → /tmp/pw-output/shots (host: /tmp/pw-host-out/shots).
//
// Theme: applyPersistedSettings re-applies data-theme on mount from localStorage,
// which races/overrides an addInitScript. So we FORCE data-theme via evaluate
// AFTER ready() (app already mounted) — the CSS tokens flip immediately.
import { test, type Page } from "@playwright/test";
import { ready, renderSettled, seedNodes, openSidebarSearch } from "./helpers";

const SHOTS = "/tmp/pw-output/shots";
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

let CURRENT_THEME: "light" | "dark" = "light";

async function applyTheme(page: Page) {
  await page.evaluate((t) => {
    localStorage.setItem("theme", t);
    document.documentElement.setAttribute("data-theme", t);
  }, CURRENT_THEME);
}

async function R(page: Page, url: string, theme: "light" | "dark") {
  CURRENT_THEME = theme;
  await ready(page, url);
  await applyTheme(page);
  await page.waitForTimeout(150);
}

async function shot(page: Page, name: string, full = false) {
  try {
    await renderSettled(page);
    // Re-assert the theme as the LAST thing before capture: renderSettled awaits
    // fonts.ready + rAF, which yields to the page event loop and was observed to
    // revert data-theme. A screenshot is a CDP command (no page-JS yield), so a
    // final synchronous-ish set sticks for the capture.
    await applyTheme(page);
    await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full });
    console.error(`[UXSHOT] ok ${name}`);
  } catch (e) {
    console.error(`[UXSHOT] FAIL ${name}: ${(e as Error).message}`);
  }
}

async function step(name: string, fn: () => Promise<void>) {
  try { await fn(); } catch (e) { console.error(`[UXSTEP] FAIL ${name}: ${(e as Error).message}`); }
}

test("ux audit capture (both themes)", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize(DESKTOP);

  await ready(page, "/?view=notes");
  let projectPlanId = "";
  await step("seed", async () => {
    const parents = await seedNodes(page, 1, { title: () => "Reading Notes", token: "uxseed-parent" });
    await seedNodes(page, 4, {
      parentId: parents[0],
      title: (i) => ["Designing Data-Intensive Apps", "Trace-Based JIT Paper", "近況預估表", "聲調笑話"][i] ?? `child ${i}`,
      markdown: () => `# Heading\n\nSome body text with a [[wikilink]] and a #tag.\n\n- a list item\n- another item`,
      token: "uxseed-child",
    });
    const topIds = await seedNodes(page, 6, {
      title: (i) => ["2026-06-20", "Project plan", "Meeting notes", "Untitled", "Quick capture idea", "Source-flag regression check"][i] ?? `note ${i}`,
      markdown: () => "Body content for an everyday note.\n\nMore text to fill the editor.",
      token: "uxseed-top",
    });
    projectPlanId = topIds[1];
  });

  for (const theme of ["light", "dark"] as const) {
    await step(`${theme}-notes`, async () => {
      await page.setViewportSize(DESKTOP);
      await R(page, "/?view=notes", theme);
      await shot(page, `${theme}-01-notes-overview`);
    });

    await step(`${theme}-editor`, async () => {
      await page.locator(".obsidian-page-button", { hasText: "Project plan" }).first().click({ timeout: 8000 });
      await page.waitForTimeout(600);
      await shot(page, `${theme}-02-editor-open`);
    });

    await step(`${theme}-sort`, async () => {
      await R(page, "/?view=notes", theme);
      await page.getByRole("button", { name: /Sort|排序/ }).first().click({ timeout: 6000 });
      await page.waitForTimeout(300);
      await shot(page, `${theme}-03-sort-dropdown`);
    });

    await step(`${theme}-search`, async () => {
      await R(page, "/?view=notes", theme);
      await (await openSidebarSearch(page)).fill("note");
      await page.waitForTimeout(400);
      await shot(page, `${theme}-04-search`);
    });

    await step(`${theme}-palette`, async () => {
      await R(page, "/?view=notes", theme);
      await page.keyboard.press("Control+k");
      await page.waitForTimeout(400);
      await shot(page, `${theme}-05-command-palette`);
    });

    await step(`${theme}-inbox`, async () => {
      await R(page, "/?view=notes", theme);
      await page.getByText(/收件匣|Inbox/).first().click({ timeout: 6000 });
      await page.waitForTimeout(500);
      await shot(page, `${theme}-06-inbox`);
    });

    await step(`${theme}-settings`, async () => {
      await R(page, "/?view=notes", theme);
      await page.locator("button[aria-label*='ettings'], button[title*='ettings'], .topbar-settings-btn").first().click({ timeout: 6000 });
      await page.waitForTimeout(500);
      await shot(page, `${theme}-07-settings-1-general`);
      // The real settings tabs (registry.tsx): General · Your Data · Server
      // · Appearance — there is NO Storage/Import tab (those folded into Your
      // Data). General is captured above; iterate the rest in order.
      const tabs: Array<[string, string]> = [["你的資料", "Your Data"], ["伺服器", "Server"], ["外觀", "Appearance"]];
      for (const [i, [zh, en]] of tabs.entries()) {
        await step(`${theme}-settings-${en}`, async () => {
          const tab = page.getByText(new RegExp(`^\\s*(${zh}|${en})\\s*$`)).first();
          await tab.click({ timeout: 4000 });
          await page.waitForTimeout(300);
          await shot(page, `${theme}-07-settings-${i + 2}-${en}`);
        });
      }
      await page.keyboard.press("Escape");
    });

    await step(`${theme}-tags`, async () => {
      await R(page, "/?view=tags", theme);
      await page.waitForTimeout(600);
      await shot(page, `${theme}-08-tags`);
    });

    await step(`${theme}-canvas`, async () => {
      await R(page, "/?view=notes", theme);
      await page.locator(".obsidian-page-button", { hasText: "Reading Notes" }).first().click({ timeout: 6000 });
      await page.waitForTimeout(400);
      // Lens strip: try a Canvas lens button by several selectors.
      const canvas = page.locator(".view-tabs").getByText(/Canvas|畫布/).first();
      await canvas.click({ timeout: 5000 });
      await page.waitForTimeout(900);
      await shot(page, `${theme}-09-canvas`);
    });

    await step(`${theme}-mobile`, async () => {
      await page.setViewportSize(MOBILE);
      await R(page, "/?view=notes", theme);
      await shot(page, `${theme}-10-mobile-notes`);
      await step(`${theme}-mobile-editor`, async () => {
        await R(page, `/?view=notes&node=${projectPlanId}`, theme);
        await page.locator(".obsidian-title-input").waitFor({ state: "visible", timeout: 6000 });
        await page.waitForTimeout(500);
        await shot(page, `${theme}-11-mobile-editor`);
      });
      await page.setViewportSize(DESKTOP);
    });
  }
});
