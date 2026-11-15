// NOTE-08 follow-up (2026-10-08): which controls a 390px phone offers to reach
// today's note.
import { test } from "@playwright/test";
import { ready, BASE } from "../fullstack/helpers";
test("NOTE-08b: phone entries to today", async ({ browser }) => {
  const phone = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await phone.newPage();
  await ready(pp, "/?view=notes");
  await pp.waitForTimeout(1500);
  const out: Record<string, unknown> = {};
  out.visibleButtons = await pp.evaluate(() => Array.from(document.querySelectorAll("button, a")).filter((b) => { const r = (b as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0; }).map((b) => ((b as HTMLElement).getAttribute("aria-label") || (b as HTMLElement).innerText || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 40));
  const more = pp.getByRole("button", { name: "More", exact: true }).filter({ visible: true }).first();
  if (await more.count()) { await more.click(); await pp.waitForTimeout(600); out.moreItems = (await pp.locator("[role=menu], .shell-dialog, dialog").filter({ visible: true }).first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300); }
  const item = pp.getByRole("menuitem", { name: "Today's note" }).or(pp.getByRole("button", { name: "Today's note" })).filter({ visible: true }).first();
  const bb = await item.boundingBox().catch(() => null);
  out.itemBox = bb ? `${Math.round(bb.width)}x${Math.round(bb.height)}` : null;
  await item.click().catch((e) => { out.clickErr = String(e).slice(0, 120); });
  await pp.waitForTimeout(2500);
  const local = await pp.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
  out.opened = { expect: local, title: await pp.locator(".obsidian-title-input, [aria-label='Note title']").first().inputValue().catch(() => "?"), sw: await pp.evaluate(() => document.documentElement.scrollWidth) };
  out.sameDay = ((await (await pp.request.get("/api/bootstrap?slim=1")).json()).nodes as Array<{ title: string }>).filter((n) => n.title === local).length;
  console.log("NOTE08B " + JSON.stringify(out, null, 2));
  await phone.close();
});
