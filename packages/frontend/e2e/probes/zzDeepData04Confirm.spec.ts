// Tick 45: is the backup-restore confirmation clickable (online), or hidden under Settings?
import { test } from "@playwright/test";
import { ready, showAdvancedSettings } from "../fullstack/helpers";
test("restore confirm clickable", async ({ page }) => {
  test.setTimeout(180_000); const out: Record<string, unknown> = {};
  await ready(page, "/?view=notes"); await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(3000);
  await page.locator("button[title*=Settings i], button[aria-label*=Settings i]").filter({ visible: true }).first().click(); await page.waitForTimeout(600);
  await page.getByRole("button", { name: /^Your Data$/ }).first().click(); await page.waitForTimeout(600);
  await showAdvancedSettings(page);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("group", { name: "Download this device's copy" }).getByRole("button").click()]);
  const path = test.info().outputPath("b.sqlite3"); await dl.saveAs(path);
  await page.locator("input[accept='.sqlite3,.sqlite,.db']").setInputFiles(path); await page.waitForTimeout(1200);
  await page.screenshot({ path: test.info().outputPath("confirm.png") });
  const btn = page.getByRole("button", { name: /Overwrite & import/ });
  out.count = await btn.count(); out.visible = await btn.isVisible().catch(() => false);
  out.topElement = await btn.evaluate((b) => { const r = b.getBoundingClientRect(); const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return el ? `${el.tagName}.${String((el as HTMLElement).className).slice(0, 60)}` : null; }).catch((e) => String(e).slice(0, 80));
  out.zIndex = await page.evaluate(() => ({ settings: getComputedStyle(document.querySelector(".settings-overlay")!).zIndex, confirm: (() => { const b = Array.from(document.querySelectorAll("button")).find((x) => /Overwrite & import/.test(x.textContent ?? "")); let e: Element | null = b ?? null; while (e && getComputedStyle(e).position === "static") e = e.parentElement; return e ? `${e.className} z=${getComputedStyle(e).zIndex}` : null; })() }));
  out.click = await btn.click({ timeout: 5000 }).then(() => "clicked").catch((e) => String(e).split("\n").filter((l) => /intercepts|not visible|outside/.test(l)).slice(0, 2).join(" ") || String(e).slice(0, 80));
  await page.waitForTimeout(3000);
  out.reloaded = page.url();
  console.log("CONFIRM " + JSON.stringify(out, null, 1));
});
