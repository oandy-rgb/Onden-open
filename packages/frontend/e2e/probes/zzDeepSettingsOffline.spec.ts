// Tick 45: opening Settings while offline crashes the app? Capture the error.
import { test } from "@playwright/test";
import { ready } from "../fullstack/helpers";
test("settings offline crash", async ({ page, context }) => {
  test.setTimeout(180_000); const out: Record<string, unknown> = {}; const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(String(e.stack ?? e).slice(0, 400)));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 300)); });
  await ready(page, "/?view=notes");
  await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(3000);
  for (const mode of ["offline"]) {
    if (mode === "offline") { await context.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event("offline"))); await page.waitForTimeout(800); }
    errs.length = 0;
    await page.locator("button[title*=Settings i], button[aria-label*=Settings i]").filter({ visible: true }).first().click();
    await page.waitForTimeout(1500);
    const crashed = await page.getByText("Something went wrong").isVisible().catch(() => false);
    let details: string | null = null;
    if (crashed) { await page.getByText("Error details").click().catch(() => {}); details = (await page.locator("details, pre").allInnerTexts().catch(() => [])).join(" | ").slice(0, 800); }
    out[mode] = { crashed, details, errs: errs.slice(0, 4) };
    if (crashed) break;
    await page.keyboard.press("Escape"); await page.waitForTimeout(500);
  }
  // Fresh page: another lazy view (Tasks) opened for the first time while offline.
  await context.setOffline(false);
  const p2 = await context.newPage(); const errs2: string[] = []; p2.on("console", (m) => { if (m.type() === "error") errs2.push(m.text().slice(0, 160)); });
  await ready(p2, "/?view=notes"); await p2.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await p2.waitForTimeout(3000);
  await context.setOffline(true); await p2.evaluate(() => window.dispatchEvent(new Event("offline"))); await p2.waitForTimeout(800);
  await p2.getByRole("button", { name: /^Tasks$/ }).filter({ visible: true }).first().click().catch(() => {});
  await p2.waitForTimeout(2000);
  out.tasksOffline = { crashed: await p2.getByText("Something went wrong").isVisible().catch(() => false), errs: errs2.filter((e) => /dynamically imported/.test(e)).slice(0, 2) };
  await context.setOffline(false);
  console.log("SETOFF " + JSON.stringify(out, null, 1));
});
