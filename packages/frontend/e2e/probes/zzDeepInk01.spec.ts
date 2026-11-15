// Feature-audit deepening (2026-10-08): INK-01 — handwritten note: leaving /
// reloading within 300 ms of a stroke (does the engine flush?), a refused
// save (403: strokes on screen, recovery), offline strokes, highlighter /
// colour / size settings stored on the stroke, undo/redo persisted.
import { test, type Page } from "@playwright/test";
import { ready, syncLabel } from "../fullstack/helpers";

type Ink = { strokes: Array<Record<string, unknown>>; erased: Record<string, unknown> };
test("INK-01: quick leave, refusal, offline, tool settings, redo", async ({ page, context }) => {
  test.setTimeout(300_000);
  const out: Record<string, unknown> = {};
  const inkDoc = async (id: string): Promise<Ink | null> => { const at = await (await page.request.get(`/api/nodes/${id}/attributes`)).json(); const list = Array.isArray(at) ? at : at.attributes ?? []; const raw = list.find((a: { key: string }) => a.key === "ink_data")?.value; return raw ? JSON.parse(raw) : null; };
  const count = async (id: string) => (await inkDoc(id))?.strokes.length ?? 0;
  const newInk = async () => {
    await ready(page, "/?view=notes"); await page.waitForTimeout(800);
    await page.keyboard.press("Control+k"); await page.locator(".palette-input-wrap input").fill(">handwritten");
    await page.locator(".palette-item", { hasText: "New handwritten note" }).click();
    await page.locator(".ink-note").waitFor({ timeout: 15_000 });
    await page.waitForTimeout(800);
    return new URL(page.url()).searchParams.get("node")!;
  };
  const stroke = async (p: Page, dy = 0) => { const b = (await p.locator(".pagebook-page").boundingBox())!; await p.mouse.move(b.x + 100, b.y + 80 + dy); await p.mouse.down(); for (const [x, y] of [[220, 110], [340, 90]]) await p.mouse.move(b.x + x, b.y + y + dy, { steps: 8 }); await p.mouse.up(); };
  try {
  let id = await newInk();
  await stroke(page); await page.waitForTimeout(2000);
  out.baseline = await count(id);
  await stroke(page, 80); await page.waitForTimeout(200);
  await page.locator(".app-primary-nav").getByRole("button", { name: "Tasks", exact: true }).click();
  await page.waitForTimeout(2500);
  out.leaveQuick = { stored: await count(id), expected: 2 };
  id = await newInk();
  await stroke(page); await page.waitForTimeout(2000); await stroke(page, 80); await page.waitForTimeout(200);
  await page.reload(); await page.waitForTimeout(3000);
  out.reloadQuick = { stored: await count(id), expected: 2, recovery: (await page.locator(".failed-write-recovery").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 60) };
  // Tool settings.
  id = await newInk();
  await page.locator(".ink-tool-btn[title='Highlighter']").click();
  const colorBtns = page.locator(".ink-toolbar-group[aria-label='Color'] button");
  if (await colorBtns.count() > 2) await colorBtns.nth(2).click();
  const sizeBtns = page.locator(".ink-toolbar-group[aria-label='Size'] button");
  if (await sizeBtns.count() > 2) await sizeBtns.last().click();
  await stroke(page); await page.waitForTimeout(2000);
  const doc = await inkDoc(id);
  const s0 = doc?.strokes[0] ?? {};
  out.toolSettings = Object.fromEntries(Object.entries(s0).filter(([k]) => k !== "points").map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v).slice(0, 40) : v]));
  // Undo / redo persisted.
  await page.locator(".ink-tool-btn[title='Pen']").click();
  await stroke(page, 80); await page.waitForTimeout(1500);
  await page.locator(".ink-note").focus(); await page.keyboard.press("Control+z"); await page.waitForTimeout(1500);
  const afterUndo = await count(id);
  await page.keyboard.press("Control+Shift+z"); await page.waitForTimeout(1500);
  out.undoRedo = { afterUndo, afterRedo: await count(id) };
  // Refused save.
  await page.route(`**/api/nodes/${id}/attributes/**`, (r) => r.request().method() === "PUT" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  const before = await count(id);
  await stroke(page, 160); await page.waitForTimeout(2500);
  out.refused = { stored: await count(id), before, toast: (await page.locator(".toast").allInnerTexts()).join(" | ").replace(/\s+/g, " ").slice(-90), recovery: (await page.locator(".failed-write-recovery").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 60) };
  await page.unroute(`**/api/nodes/${id}/attributes/**`);
  // Offline.
  id = await newInk();
  await context.setOffline(true); await page.waitForTimeout(600);
  await stroke(page); await page.waitForTimeout(2000);
  out.offlineSync = (await syncLabel(page)).replace(/\s+/g, " ");
  await context.setOffline(false); await page.waitForTimeout(6000);
  out.offlineReplay = await count(id);
  } finally {
    await context.setOffline(false).catch(() => {});
    console.log("INK01 " + JSON.stringify(out, null, 2));
  }
});
