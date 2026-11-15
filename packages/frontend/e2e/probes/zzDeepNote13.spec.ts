// Feature-audit deepening (2026-10-08): NOTE-13 — single-note export from the
// note's More actions: Markdown with an unsaved draft, HTML with a private
// image, Print / save as PDF (print called; cancelling the dialog), offline
// (Markdown ok, HTML/PDF need a connection), a refused export-preview (403),
// a blocked pop-up, and Copy as Markdown with clipboard denied.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { ready, BASE, H, PNG_1X1_B64 } from "../fullstack/helpers";

const PNG_B64 = PNG_1X1_B64; // a real image: the server decodes uploads

test("NOTE-13: export markdown/html/pdf/copy — draft, media, offline, refused", async ({ page, context }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const up = await page.request.post("/api/media", { headers: { origin: BASE }, multipart: { file: { name: "p.png", mimeType: "image/png", buffer: Buffer.from(PNG_B64, "base64") } } });
  const media = (await up.json()).url as string;
  const note = await (await page.request.post("/api/nodes", { ...H, data: { title: `Exp ${stamp}`, markdown: `# Exp heading\n\n![pic](${media})\n\nsaved line` } })).json();
  await context.addInitScript(() => { (window as unknown as { __prints: number }).__prints = 0; const orig = window.open; window.open = function (...a: Parameters<typeof window.open>) { const w = orig.apply(window, a); if (w) { try { w.print = () => { (window as unknown as { __prints: number }).__prints++; }; } catch { /* cross-origin */ } } return w; }; });
  const toasts = async () => (await page.locator(".toast").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").slice(-200);
  const exportVia = async (label: string) => {
    // Wide: "Export as ›" submenu; phone: the sheet's "Export" tile.
    const exp = page.getByRole("menuitem", { name: /^Export( as)?$/ });
    if (!(await exp.isVisible().catch(() => false))) await page.getByRole("button", { name: "More actions" }).filter({ visible: true }).first().click();
    const opt = page.getByRole("menuitem", { name: label, exact: true });
    if (!(await opt.isVisible().catch(() => false))) await exp.click();
    await opt.click();
  };
  try {
  await ready(page, `/?view=notes&node=${note.id}&lens=editor`);
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\nunsaved draft line");
  // Markdown right away (draft not yet autosaved).
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 10_000 }), exportVia("Markdown file")]);
  const md = readFileSync((await dl.path())!, "utf8");
  out.markdown = { file: dl.suggestedFilename(), hasDraft: md.includes("unsaved draft line"), hasImageRef: md.includes(media), serverHasDraft: ((await (await page.request.get(`/api/nodes/${note.id}`)).json()).markdown as string).includes("unsaved draft line") };
  // HTML.
  const [dh] = await Promise.all([page.waitForEvent("download", { timeout: 15_000 }), exportVia("HTML")]);
  const html = readFileSync((await dh.path())!, "utf8");
  out.html = { file: dh.suggestedFilename(), hasDraft: html.includes("unsaved draft line"), img: (/<img[^>]*src="([^"]+)"/.exec(html) ?? [])[1] ?? null, scripts: (html.match(/<script/g) ?? []).length, bytes: html.length };
  const anon = await (await fetch(`${BASE}${media.startsWith("/") ? media : "/" + media}`).catch(() => null))?.status;
  out.imageAnonStatus = anon ?? "fetch failed";
  // PDF (print).
  const popupP = page.waitForEvent("popup", { timeout: 10_000 }).catch(() => null);
  await exportVia("Print / save as PDF");
  const popup = await popupP;
  await page.waitForTimeout(2500);
  out.pdf = { popup: !!popup, popupHasDraft: popup ? (await popup.content().catch(() => "")).includes("unsaved draft line") : null, printsCalled: await page.evaluate(() => (window as unknown as { __prints: number }).__prints), toast: await toasts() };
  if (popup) await popup.close().catch(() => {});
  // Blocked pop-up.
  await page.evaluate(() => { (window as unknown as { open: unknown }).open = () => null; });
  await exportVia("Print / save as PDF");
  await page.waitForTimeout(1500);
  out.pdfBlocked = await toasts();
  await page.keyboard.press("Escape");
  // Refused export-preview.
  await page.route("**/export-preview", (r) => r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }));
  const dl403 = page.waitForEvent("download", { timeout: 4000 }).catch(() => null);
  await exportVia("HTML");
  out.html403 = { downloaded: !!(await dl403), toast: await toasts() };
  await page.unroute("**/export-preview");
  await page.keyboard.press("Escape");
  // Offline.
  await context.setOffline(true);
  const dlOffMd = page.waitForEvent("download", { timeout: 6000 }).catch(() => null);
  await exportVia("Markdown file");
  out.offlineMarkdown = !!(await dlOffMd);
  await page.keyboard.press("Escape");
  const dlOffHtml = page.waitForEvent("download", { timeout: 4000 }).catch(() => null);
  await exportVia("HTML").catch((e) => { out.offlineHtmlMenu = String(e).slice(0, 80); });
  out.offlineHtml = { downloaded: !!(await dlOffHtml), toast: await toasts() };
  await context.setOffline(false);
  await page.keyboard.press("Escape");
  // Clipboard denied.
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("denied")) }, configurable: true }); });
  const cp = page.getByRole("menuitem", { name: "Copy Markdown", exact: true });
  if (!(await cp.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "More actions" }).filter({ visible: true }).first().click();
    await page.getByRole("menuitem", { name: /^Export( as)?$/ }).click();
  }
  await cp.click();
  await page.waitForTimeout(1200);
  out.copyDenied = { toast: await toasts(), menuOpen: await page.getByRole("menu", { name: "More actions" }).isVisible().catch(() => false) };
  } finally {
    await context.setOffline(false).catch(() => {});
    console.log("NOTE13 " + JSON.stringify(out, null, 2));
  }
});
