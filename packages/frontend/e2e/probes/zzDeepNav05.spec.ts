// Feature-audit deepening (2026-10-08): NAV-05 — every shortcut in
// lib/shortcuts.ts fired from a neutral spot, the cheatsheet matches the list,
// and bare keys ("?", Delete) do not fire while typing in inputs, the editor,
// the palette or quick capture.
import { test, type Page } from "@playwright/test";
import { ready, BASE, H } from "../fullstack/helpers";


test("NAV-05: shortcuts fire, match the cheatsheet, and don't misfire", async ({ page }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const count = async () => ((await (await page.request.get("/api/bootstrap?slim=1")).json()).nodes as unknown[]).length;
  const neutral = async (p: Page) => { await p.keyboard.press("Escape"); await p.locator(".app-topbar").click({ position: { x: 5, y: 5 } }).catch(() => {}); await p.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.()); };
  const note = (await (await page.request.post("/api/nodes", { ...H, data: { title: `Kbd ${stamp}`, markdown: "kbd body" } })).json()).id as string;
  try {
  await ready(page, `/?view=notes&node=${note}&lens=editor`);
  await page.waitForTimeout(1500);
  const r: Record<string, unknown> = {};
  await neutral(page); await page.keyboard.press("Control+k"); await page.waitForTimeout(400);
  r.palette = await page.locator(".palette-input-wrap input").isVisible(); await page.keyboard.press("Escape");
  await neutral(page); await page.keyboard.press("Control+f"); await page.waitForTimeout(400);
  r.focusSearch = await page.evaluate(() => { const a = document.activeElement as HTMLInputElement | null; return a ? `${a.tagName}:${a.placeholder ?? ""}`.slice(0, 40) : null; });
  await neutral(page); await page.keyboard.press("Control+Shift+N"); await page.waitForTimeout(400);
  r.capture = await page.locator(".quick-capture-textarea").isVisible(); await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  if (await page.locator(".quick-capture-textarea").isVisible()) await page.getByRole("button", { name: "Close" }).first().click().catch(() => {});
  await neutral(page); await page.keyboard.press("Control+Shift+D"); await page.waitForTimeout(1200);
  r.daily = await page.locator(".obsidian-title-input, [aria-label='Note title']").first().inputValue().catch(() => null);
  await neutral(page); let n0 = await count(); await page.keyboard.press("Control+n"); await page.waitForTimeout(1500);
  r.newNote = { delta: (await count()) - n0, title: await page.locator(".obsidian-title-input, [aria-label='Note title']").first().inputValue().catch(() => null) };
  await ready(page, `/?view=notes&node=${note}&lens=editor`); await page.waitForTimeout(1000);
  await page.locator(".cm-content").first().click(); await page.keyboard.press("Control+End"); await page.keyboard.type(" savekey");
  const t0 = Date.now(); await page.keyboard.press("Control+s");
  let saved = -1; while (Date.now() - t0 < 3000) { if (((await (await page.request.get(`/api/nodes/${note}`)).json()).markdown as string).includes("savekey")) { saved = Date.now() - t0; break; } await page.waitForTimeout(100); }
  r.saveMs = saved;
  await page.keyboard.press("Control+e"); await page.waitForTimeout(600);
  r.togglePreviewFromEditor = await page.locator(".obsidian-preview").isVisible().catch(() => false);
  await neutral(page); await page.keyboard.press("Control+e"); await page.waitForTimeout(600);
  r.togglePreviewBack = await page.locator(".cm-content").first().isVisible().catch(() => false);
  // Focus mode is Ctrl+Alt+F (lib/shortcuts.ts focus-mode); Ctrl+\ is side by side now and would leave a split pane on the account.
  await neutral(page); const fm0 = await page.evaluate(() => document.body.className); await page.keyboard.press("Control+Alt+F"); await page.waitForTimeout(600);
  r.focusMode = { before: fm0.includes("zen") || fm0.includes("focus"), after: await page.evaluate(() => document.body.className.slice(0, 120)) }; await page.keyboard.press("Control+Alt+F"); await page.waitForTimeout(400);
  await neutral(page); const insp = page.locator(".notes-inspector-toggle"); const i0 = await insp.getAttribute("aria-pressed").catch(() => null); await page.keyboard.press("Control+."); await page.waitForTimeout(500);
  r.inspector = `${i0}→${await insp.getAttribute("aria-pressed").catch(() => null)}`; await page.keyboard.press("Control+."); await page.waitForTimeout(300);
  await neutral(page); await page.keyboard.press("?"); await page.waitForTimeout(500);
  const sheet = page.locator(".shortcuts-modal");
  r.cheatsheet = { open: await sheet.isVisible().catch(() => false), rows: (await sheet.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 600) };
  await page.keyboard.press("Escape");
  out.fire = r;

  // Misfire checks.
  const m: Record<string, unknown> = {};
  await neutral(page); await page.keyboard.press("Control+f"); await page.waitForTimeout(400); await page.keyboard.type("a?b");
  m.questionInSearch = { sheet: await page.locator(".shortcuts-modal").isVisible().catch(() => false), value: await page.evaluate(() => (document.activeElement as HTMLInputElement)?.value ?? null) };
  await page.keyboard.press("Escape");
  await ready(page, `/?view=notes&node=${note}&lens=editor`); await page.waitForTimeout(800);
  await page.locator(".cm-content").first().click(); await page.keyboard.press("Control+End"); await page.keyboard.type(" q?x"); await page.keyboard.press("Delete");
  await page.waitForTimeout(400);
  m.inEditor = { sheet: await sheet.isVisible().catch(() => false), url: page.url().includes(note), text: (await page.locator(".cm-content").first().innerText()).slice(-10) };
  await page.keyboard.press("Control+k"); await page.locator(".palette-input-wrap input").type("x?"); n0 = await count();
  await page.keyboard.press("Control+n"); await page.waitForTimeout(1200);
  m.paletteOpen = { query: await page.locator(".palette-input-wrap input").inputValue().catch(() => null), ctrlNCreated: (await count()) - n0, sheet: await sheet.isVisible().catch(() => false) };
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+N"); await page.locator(".quick-capture-textarea").type("cap?");
  n0 = await count(); await page.keyboard.press("Control+Shift+D"); await page.waitForTimeout(1000);
  m.captureOpen = { value: await page.locator(".quick-capture-textarea").inputValue().catch(() => null), stillOpen: await page.locator(".quick-capture-textarea").isVisible(), url: page.url().replace(BASE, "").slice(0, 50) };
  out.misfire = m;
  } finally {
    console.log("NAV05 " + JSON.stringify(out, null, 2));
  }
});
