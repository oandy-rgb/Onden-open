// Feature-audit deepening (2026-10-08): PDF-03 second pass — a text highlight's
// position after reload and after zoom (does the rect still sit on its text?),
// a selection that crosses pages 1→2, removing one highlight vs "Clear", and
// what Clear takes with it (ink) and whether it can be undone.
import { test, type Page } from "@playwright/test";
import { ready, BASE, H, psql as sql } from "../fullstack/helpers";
import { readFileSync } from "node:fs";

const FX = "/var/home/oandy/桌面/git/note/Onden/.acceptance/feature-loop-2026-10-07/tick7/fixture";
const INK = JSON.stringify({ version: 2, pages: { "1": { strokes: [{ id: "k1", points: [[100, 100], [300, 200]], color: "#e00", size: 4, toolId: "pen" }], erased: {} } } });

test("PDF-03b: highlight position, cross-page, delete, Clear", async ({ page }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const req = page.request;
  const up = await (await req.post("/api/media", { headers: { origin: BASE }, multipart: { file: { name: `p03-${stamp}.pdf`, mimeType: "application/pdf", buffer: readFileSync(`${FX}/text20.pdf`) } } })).json();
  const pdf = (await (await req.post("/api/nodes", { ...H, data: { title: `PDF03b ${stamp}`, markdown: "" } })).json()).id as string;
  await req.put(`/api/nodes/${pdf}/attributes/pdf_url`, { ...H, data: { value: up.url, value_type: "text" } });
  const ann = () => { try { return (JSON.parse(sql(`select value from node_attributes where node_id='${pdf}' and key='ink_data'`) || "{}") as { annotations?: Array<{ type: string; position?: { boundingRect?: { pageNumber: number }; rects?: Array<{ pageNumber: number }> }; content?: { text?: string } }> }).annotations ?? []; } catch { return []; } };
  const open = async () => {
    await ready(page, `/?view=notes&node=${pdf}`);
    await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
    await page.locator(".pdf-text-layer span").first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1500);
  };
  const span = (p: Page, pg: number, line: number) => p.locator(`[data-page-key="pdf:${pg}"] .pdf-text-layer span`, { hasText: `Line ${line} of page ${pg}` }).first();
  const align = async (p: Page, pg: number, line: number) => {
    const s = await span(p, pg, line).boundingBox();
    const hls = await p.locator(`[data-page-key="pdf:${pg}"] .pdf-hl-text`).evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
    if (!s || !hls.length) return `span=${!!s} hl=${hls.length}`;
    const best = hls.map((h) => Math.abs(h.y + h.h / 2 - (s.y + s.height / 2))).sort((a, b) => a - b)[0];
    return `hl=${hls.length} dyCenter=${best.toFixed(1)}px spanH=${s.height.toFixed(1)}`;
  };
  await open();
  // 1. Text highlight on page 1, line 5.
  const b = (await span(page, 1, 5).boundingBox())!;
  await page.mouse.move(b.x + 1, b.y + b.height / 2); await page.mouse.down();
  await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 12 }); await page.mouse.up();
  // A selection writes nothing until 「劃線」 is pressed (R4, 2026-10-14).
  await page.locator(".pdf-node-selection-mark").click();
  await page.waitForTimeout(2500);
  out.afterHighlight = { stored: ann().length, align: await align(page, 1, 5) };
  // 2. Reload → still aligned.
  await open();
  out.afterReload = await align(page, 1, 5);
  // 3. Zoom in twice, then fit.
  await page.locator("[data-pdf-more]").click(); await page.getByRole("menuitem", { name: "Zoom in" }).click(); await page.waitForTimeout(500);
  await page.locator("[data-pdf-more]").click(); await page.getByRole("menuitem", { name: "Zoom in" }).click(); await page.waitForTimeout(1500);
  await span(page, 1, 5).evaluate((el) => { const sc = document.querySelector(".pagebook-scroll") as HTMLElement; const r = el.getBoundingClientRect(); const s = sc.getBoundingClientRect(); sc.scrollTop += r.top - s.top - 100; });
  await page.waitForTimeout(800);
  out.afterZoom = await align(page, 1, 5);
  await page.locator("[data-pdf-more]").click(); await page.getByRole("menuitem", { name: "Fit width" }).click(); await page.waitForTimeout(1500);
  // 4. Cross-page: page 1 line 39 → page 2 line 1.
  await page.locator(`[data-page-key="pdf:1"]`).evaluate((el) => { const sc = document.querySelector(".pagebook-scroll") as HTMLElement; sc.scrollTop = (el as HTMLElement).offsetTop + (el as HTMLElement).offsetHeight - 260; });
  await page.waitForTimeout(1500);
  const a1 = await span(page, 1, 39).boundingBox();
  const a2 = await span(page, 2, 1).boundingBox();
  if (a1 && a2) {
    await page.mouse.move(a1.x + 1, a1.y + a1.height / 2); await page.mouse.down();
    await page.mouse.move(a2.x + a2.width - 1, a2.y + a2.height / 2, { steps: 20 }); await page.mouse.up();
    await page.locator(".pdf-node-selection-mark").click();
    await page.waitForTimeout(2500);
    const last = ann().slice(-1)[0];
    out.crossPage = { stored: ann().length, text: last?.content?.text?.slice(0, 120), boundingPage: last?.position?.boundingRect?.pageNumber, rectPages: [...new Set((last?.position?.rects ?? []).map((r) => r.pageNumber))], tip: await page.locator(".pdf-node-selection-tip").count(), hlP2: await page.locator(`[data-page-key][data-page-number="2"] .pdf-hl-text`).count() };
  } else out.crossPage = `spans p1L39=${!!a1} p2L1=${!!a2}`;
  // 5. Single delete: any control on a highlight?
  await page.locator(".pdf-hl-text").first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(600);
  out.clickHighlightUi = (await page.locator("[role=menu], .pdf-hl-popup, .pdf-hl-delete, [aria-label*='Delete' i], [aria-label*='Remove' i]").allInnerTexts().catch(() => [])).slice(0, 5);
  await page.locator(".pdf-hl-text").first().click({ button: "right", force: true }).catch(() => {});
  await page.waitForTimeout(600);
  out.rightClickUi = (await page.locator("[role=menu]").allInnerTexts().catch(() => [])).slice(0, 3);
  await page.keyboard.press("Escape");
  // 6. Clear with ink present.
  await req.put(`/api/nodes/${pdf}/attributes/ink_data`, { ...H, data: { value: INK, value_type: "text" } });
  await open();
  out.beforeClear = { ann: ann().length, ink: sql(`select length(value) from node_attributes where node_id='${pdf}' and key='ink_data'`) };
  // Clear all lives in the "⋯" menu and asks first; decline, so nothing changes.
  await page.locator("[data-pdf-more]").click();
  await page.getByRole("menuitem", { name: "Clear all annotations" }).click();
  const dialog = (await page.locator(".confirm-dialog").innerText()).replace(/\s+/g, " ");
  await page.locator(".confirm-dialog").getByRole("button", { name: "Cancel" }).click();
  await page.waitForTimeout(3000);
  out.clear = { dialog, ann: ann().length, ink: sql(`select coalesce(left(value, 80), '(none)') from node_attributes where node_id='${pdf}' and key='ink_data'`), toasts: (await page.locator(".toast").allInnerTexts().catch(() => [])).map((s) => s.slice(0, 80)) };
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(1500);
  out.afterCtrlZ = { ann: ann().length };
  console.log("PDF03B " + JSON.stringify(out, null, 2));
});
