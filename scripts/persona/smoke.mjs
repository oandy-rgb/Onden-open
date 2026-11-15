// Smoke: owner signup -> new note -> type -> reload -> text persisted. Desktop + phone.
// Run on a FRESH DB (./reset.sh) or any DB: uses a unique email per run.
import { chromium } from "playwright";
import { newOwner } from "./pw.mjs";

const browser = await chromium.launch();
let failed = false;
for (const isPhone of [false, true]) {
  const label = isPhone ? "phone" : "desktop";
  const stamp = `${Date.now()}-${label}`;
  const text = `persona smoke ${stamp}`;
  try {
    const { context, page } = await newOwner(browser, { email: `smoke-${stamp}@example.com`, password: "smoke-pass-12345", name: `Smoke ${label}`, phone: isPhone });
    await page.getByRole("button", { name: "新筆記" }).first().click();
    // Phone: 新筆記 only adds an 未命名 row to the list; tapping it opens the editor.
    if (isPhone) await page.getByText("未命名", { exact: true }).first().click();
    const editor = page.locator(".cm-content").first();
    await editor.waitFor({ state: "visible", timeout: 20_000 });
    await editor.click();
    await page.keyboard.type(text);
    await page.waitForTimeout(3000);
    await page.reload({ waitUntil: "load" });
    // (phone reload restores the open note, no re-tap needed)
    await page.locator(".cm-content").first().waitFor({ state: "visible", timeout: 30_000 });
    await page.getByText(text, { exact: false }).first().waitFor({ timeout: 15_000 });
    console.log(`PASS ${label}`);
    await context.close();
  } catch (e) {
    failed = true;
    console.log(`FAIL ${label}: ${e.message.split("\n").slice(0,3).join(" | ")}`);
    try { await browser.contexts().at(-1)?.pages().at(-1)?.screenshot({ path: `/tmp/smoke-${label}-fail.png` }); } catch {}
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
