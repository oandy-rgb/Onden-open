// Feature-audit deepening (2026-10-08): NOTE-01 — every desktop "new note"
// entry, success vs refused (403): topbar "Create new note" (quick capture),
// ⌘⇧N, sidebar "+ → Note" then a Chinese rename, and the command palette's
// "Create note: …" row.
import { test, type Page } from "@playwright/test";
import { ready } from "../fullstack/helpers";


test("NOTE-01: new-note entries, success vs 403", async ({ page }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const byTitle = async (t: string) => ((await (await page.request.get("/api/bootstrap?slim=1")).json()).nodes as Array<{ id: string; title: string }>).filter((n) => n.title === t);
  const count = async () => ((await (await page.request.get("/api/bootstrap?slim=1")).json()).nodes as unknown[]).length;
  const title = () => page.locator(".obsidian-title-input, [aria-label='Note title']").first().inputValue().catch(() => "?");
  const toasts = async () => (await page.locator(".toast").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").slice(0, 140);
  const refuse = () => page.route("**/api/nodes", (r) => r.request().method() === "POST" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  const allow = () => page.unroute("**/api/nodes");
  const viaCapture = async (open: (p: Page) => Promise<void>, text: string) => {
    await open(page);
    const ta = page.locator(".quick-capture-textarea");
    await ta.waitFor({ timeout: 10_000 });
    await ta.fill(text); await ta.press("Control+Enter");
    await page.waitForTimeout(2500);
    return { open: await ta.isVisible().catch(() => false), kept: await ta.inputValue().catch(() => null) };
  };
  const shortcut = async (p: Page) => { await p.locator("body").click({ position: { x: 640, y: 400 } }).catch(() => {}); await p.keyboard.press("Control+Shift+N"); };
  try {
  await ready(page, "/?view=notes");
  // B) ⌘⇧N
  await ready(page, "/?view=notes");
  const tB = `快捷鍵新筆記 ${stamp}`;
  out.shortcut = { ui: await viaCapture(shortcut, tB).catch((e) => ({ err: String(e).slice(0, 80) })), server: (await byTitle(tB)).length };
  await page.keyboard.press("Escape");
  await refuse();
  const tB2 = `快捷鍵被拒 ${stamp}`;
  out.shortcut403 = { ui: await viaCapture(shortcut, tB2), server: (await byTitle(tB2)).length, toast: await toasts() };
  await allow();
  await page.keyboard.press("Escape");
  // C) sidebar + → Note, then rename in the title field
  await ready(page, "/?view=notes");
  let n0 = await count();
  await page.getByRole("button", { name: "Create new node" }).click();
  await page.getByRole("menuitem", { name: "Note" }).click();
  await page.waitForTimeout(2000);
  out.sidebarNote = { delta: (await count()) - n0, title: await title() };
  const tC = `側欄改名 中文 ${stamp}`;
  const ti = page.locator(".obsidian-title-input, [aria-label='Note title']").first();
  await ti.fill(tC); await ti.press("Enter");
  await page.waitForTimeout(2000);
  out.sidebarRename = { server: (await byTitle(tC)).length };
  await refuse();
  n0 = await count();
  await page.getByRole("button", { name: "Create new node" }).click();
  await page.getByRole("menuitem", { name: "Note" }).click();
  await page.waitForTimeout(2000);
  out.sidebarNote403 = { delta: (await count()) - n0, title: await title(), toast: await toasts() };
  await allow();
  // D) command palette create-on-miss
  await ready(page, "/?view=notes");
  const tD = `指令面板新筆記 ${stamp}`;
  await page.keyboard.press("Control+k");
  const q = page.locator(".palette-input-wrap input");
  await q.fill(tD);
  await page.waitForTimeout(800);
  await page.getByRole("option", { name: new RegExp(`Create note: ${tD}`) }).first().click().catch(async () => { await q.press("Enter"); });
  await page.waitForTimeout(2000);
  out.palette = { server: (await byTitle(tD)).length, opened: await title(), paletteOpen: await q.isVisible().catch(() => false) };
  await refuse();
  const tD2 = `指令面板被拒 ${stamp}`;
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await q.fill(tD2);
  await page.waitForTimeout(800);
  await page.getByRole("option", { name: new RegExp(`Create note: ${tD2}`) }).first().click().catch(async () => { await q.press("Enter"); });
  await page.waitForTimeout(2000);
  out.palette403 = { server: (await byTitle(tD2)).length, paletteOpen: await q.isVisible().catch(() => false), query: await q.inputValue().catch(() => null), toast: await toasts() };
  await allow();
  } finally {
    console.log("NOTE01 " + JSON.stringify(out, null, 2));
  }
});
