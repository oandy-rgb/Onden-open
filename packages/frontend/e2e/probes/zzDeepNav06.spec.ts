// Feature-audit deepening (2026-10-08): NAV-06 — phone (390×844): Content ⇄
// other lenses keep the unsaved draft; a "keyboard" (viewport height
// shrunk to 420) keeps the caret line visible; landscape 844×390; back to the
// list keeps the draft; modals stay visible while side panels are hidden.
// A note's page has no Info tab any more (its tags are a section under the
// title, 91a0e24d) and the Table lens is gone (#486), so the round-trips
// cover Canvas and History.
import { test, type Page } from "@playwright/test";
import { ready, BASE, H } from "../fullstack/helpers";


test("NAV-06: phone tabs, keyboard, landscape, back keeps draft", async ({ browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const ctx = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const parent = (await (await p.request.post("/api/nodes", { ...H, data: { title: `Mob ${stamp}`, markdown: Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") } })).json()).id as string;
  await p.request.post("/api/nodes", { ...H, data: { title: `MobChild ${stamp}`, markdown: "c", parent_id: parent } });
  const editorText = () => p.locator(".cm-content").first().innerText().catch(() => "");
  const tabs = async () => (await p.locator(".overview-mobile-tabs button, [role=tab]").filter({ visible: true }).allInnerTexts()).map((t) => t.trim()).filter(Boolean);
  const sw = () => p.evaluate(() => document.documentElement.scrollWidth);
  try {
  await ready(p, `/?view=notes&node=${parent}&lens=editor`);
  await p.locator(".cm-content").first().click(); await p.keyboard.press("Control+End"); await p.keyboard.type(" DRAFT1");
  out.tabs = await tabs();
  out.infoTab = await p.locator(".overview-mobile-tabs").getByRole("button", { name: "Info", exact: true }).count();
  // Other lenses and back to Content.
  const lensResults: Record<string, unknown> = {};
  for (const lens of ["Canvas", "History"]) {
    const btn = p.getByRole("tab", { name: lens, exact: true }).or(p.getByRole("button", { name: lens, exact: true })).filter({ visible: true }).first();
    if (!(await btn.count())) { lensResults[lens] = "no entry"; continue; }
    await btn.click(); await p.waitForTimeout(800);
    const back = p.getByRole("tab", { name: "Content", exact: true }).or(p.getByRole("button", { name: "Content", exact: true })).filter({ visible: true }).first();
    const backReachable = await back.isVisible().catch(() => false);
    if (backReachable) { await back.click(); await p.waitForTimeout(600); }
    lensResults[lens] = { backReachable, draft: (await editorText()).includes("DRAFT1"), sw: await sw() };
  }
  out.lenses = lensResults;
  // Keyboard: shrink height while caret is at the end.
  await p.locator(".cm-content").first().click(); await p.keyboard.press("Control+End");
  await p.setViewportSize({ width: 390, height: 420 }); await p.waitForTimeout(800);
  await p.keyboard.type(" KBD");
  out.keyboard = await p.evaluate(() => { const sel = window.getSelection(); const r = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null; return { caretTop: r ? Math.round(r.top) : null, vh: innerHeight, caretVisible: r ? r.top >= 0 && r.bottom <= innerHeight : null }; });
  await p.setViewportSize({ width: 844, height: 390 }); await p.waitForTimeout(800);
  out.landscape = { sw: await sw(), vw: 844, editorVisible: await p.locator(".cm-content").first().isVisible(), draft: (await editorText()).includes("KBD") };
  await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(600);
  // Back to list right after typing.
  await p.locator(".cm-content").first().click(); await p.keyboard.press("Control+End"); await p.keyboard.type(" DRAFT2");
  await p.getByRole("button", { name: /Back to notes list|‹/ }).filter({ visible: true }).first().click();
  await p.waitForTimeout(600);
  out.listShown = await p.locator(".obsidian-page-button").first().isVisible().catch(() => false);
  await p.waitForTimeout(2500);
  out.serverAfterBack = ((await (await p.request.get(`/api/nodes/${parent}`)).json()).markdown as string).includes("DRAFT2");
  // Modal while side panels hidden: open More sheet and the palette.
  await p.getByRole("button", { name: "More", exact: true }).filter({ visible: true }).first().click(); await p.waitForTimeout(500);
  out.moreSheetVisible = await p.locator("[role=dialog], [role=menu]").filter({ visible: true }).count();
  await p.keyboard.press("Escape");
  } finally {
    console.log("NAV06 " + JSON.stringify(out, null, 2));
    await ctx.close();
  }
});
