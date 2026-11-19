#!/usr/bin/env node
// A note whose pages are listed in `note_pages` (docs/architecture/proposals/pdf-pages-in-note-2026-11-16.md, step 1), in a real engine:
// a test helper gives a note the list [blank page, the three pages of a small generated PDF, blank page] and a 「手寫」 tab → the tab shows
// five pages in order, the PDF's pages drawn from the file → draw on a PDF page and on a blank page → reload → the strokes are stored under
// their page keys and the five pages are still there. A handwriting notebook (ink_data) and a PDF note made before (pdf_url) look as before.
//   npm run build:browser (repo root), then: node e2e/browser-app/notePages.mjs [chromium|mobile-chrome] [--dir dist-browser]
// The pointer is a mouse (Playwright's mouse events), on the phone size too: a finger or a pen is not tested here.
import { launch, startSite, openApp, waitSaved, VIEWPORTS } from "../layout-audit/env.mjs";

const engine = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "chromium";
const vp = VIEWPORTS.find((v) => v.id === (engine === "mobile-chrome" ? "pixel5" : "1280"));
const failures = [];
const check = (ok, what, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`); if (!ok) failures.push(what); };

/** A PDF of `pages` blank pages, 300 × 400 points, with a correct cross-reference table. */
function smallPdf(pages) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(" ")}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>")];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

const browser = await launch();
const site = await startSite(process.argv.includes("--dir") ? process.argv[process.argv.indexOf("--dir") + 1] : "dist-browser");
try {
  const { page, errors, context } = await openApp(browser, site, vp, { seed: false });
  // The browser build does not ship pdf.js's worker file (vite.browser.config.ts FROM_PUBLIC lists only the app's own files), so a PDF cannot be drawn
  // from the static site as it is; this script serves it from public/ the way the real app's server does.
  await context.route("**/pdf.worker.min.mjs", (route) => route.fulfill({ path: new URL("../../public/pdf.worker.min.mjs", import.meta.url).pathname, contentType: "text/javascript" }));
  if (process.argv.includes("--verbose")) {
    page.on("console", (m) => console.log("console:", m.type(), m.text().slice(0, 300)));
    page.on("response", async (r) => { if (r.request().method() !== "GET" && r.url().includes("/api/")) console.log("response:", r.request().method(), r.url().replace(site.base, ""), r.status(), (await r.text().catch(() => "")).slice(0, 200)); });
  }
  const call = (method, path, body) => page.evaluate(async ({ method, path, body }) => {
    const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status}`);
    return r.status === 204 ? null : r.json();
  }, { method, path, body });
  const until = async (probe, ms = 30_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await probe()) return true; await page.waitForTimeout(300); } return false; };
  const attr = (id, key) => page.evaluate(async ({ id, key }) => {
    const rows = await (await fetch(`/api/nodes/${id}/attributes?keys=${key}`)).json();
    return (Array.isArray(rows) ? rows : []).find((a) => a.key === key)?.value ?? null;
  }, { id, key });
  const keys = () => page.locator("[data-page-key]").evaluateAll((els) => els.map((el) => el.getAttribute("data-page-key")));
  const open = async (query) => { await page.goto(`${site.base}?${query}`); await page.locator("[data-page-key]").first().waitFor({ timeout: 60_000 }); await page.waitForTimeout(800); };
  const stroke = (id, points) => ({ id, color: "#1e1e1e", size: 4, toolId: "pen", points: points.map(([x, y], i) => [x, y, 0.5, i * 8]) });
  const doc = (strokes) => ({ version: 1, erased: {}, page: { width: 1000 }, strokes });
  const draw = async (key) => {
    const surface = page.locator(`[data-page-key="${key}"] .page-ink-surface`);
    await surface.scrollIntoViewIfNeeded();
    // The page's engine is built when the page is near the screen: wait for its canvas.
    await page.locator(`[data-page-key="${key}"] canvas.page-ink-canvas`).first().waitFor({ state: "attached", timeout: 15_000 });
    await page.waitForTimeout(300);
    const box = await surface.boundingBox();
    const x0 = box.x + box.width * 0.2, y0 = box.y + Math.min(box.height * 0.3, 160);
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) await page.mouse.move(x0 + i * 10, y0 + Math.sin(i / 2) * 24, { steps: 2 });
    await page.mouse.up();
  };

  const url = await page.evaluate(async (pdfText) => {
    const form = new FormData(); form.append("file", new File([pdfText], "lecture.pdf", { type: "application/pdf" }));
    return (await (await fetch("/api/media", { method: "POST", body: form })).json()).url;
  }, smallPdf(3));
  check(typeof url === "string" && url.startsWith("/api/media/"), "the small PDF is uploaded", String(url));

  // The note with a list of pages and a 「手寫」 tab.
  const NOTE = "00000000-0000-4000-8000-0000000e0001";
  const list = { version: 1, runs: [{ id: "b1", kind: "blank" }, { id: "r1", kind: "pdf", file: url, from: 1, to: 3 }, { id: "b2", kind: "blank" }] };
  await call("POST", "/api/nodes", { id: NOTE, title: "有頁面清單的筆記", markdown: "" });
  await call("PUT", `/api/nodes/${NOTE}/attributes/note_pages`, { value: JSON.stringify(list), value_type: "text" });
  const view = await call("POST", `/api/nodes/${NOTE}/views`, { name: "手寫", layout: "handwriting" });
  // A handwriting notebook of two pages, and a PDF note made before note_pages (pdf_url, its strokes in ink_data's PDF envelope).
  const BOOK = "00000000-0000-4000-8000-0000000e0002";
  const OLD_PDF = "00000000-0000-4000-8000-0000000e0003";
  const first = doc([stroke("o1", [[150, 350], [250, 400], [350, 360], [450, 420]])]);
  await call("POST", "/api/nodes", { id: BOOK, title: "舊的手寫筆記", markdown: "" });
  await call("PUT", `/api/nodes/${BOOK}/attributes/ink_data`, { value: JSON.stringify({ ...first, morePages: { version: 1, pages: { u1: { key: "u1", background: { kind: "blank" }, size: { width: 1000, height: 1400 }, doc: doc([stroke("o2", [[100, 100], [200, 160], [300, 120]])]) } }, order: ["page", "u1"] } }), value_type: "text" });
  await call("POST", "/api/nodes", { id: OLD_PDF, title: "舊的 PDF 筆記", markdown: "" });
  await call("PUT", `/api/nodes/${OLD_PDF}/attributes/pdf_url`, { value: url, value_type: "text" });
  await waitSaved(page);

  // 1 — the five pages, in order, the PDF's pages drawn from the file.
  await open(`view=notes&node=${NOTE}&lens=editor&tab=${view.id}`);
  check((await keys()).join(",") === "b1,r1:1,r1:2,r1:3,b2", "five pages in the list's order", (await keys()).join(","));
  check(await until(async () => (await page.locator("[data-pdf-page] canvas").count()) >= 1), "a PDF page is drawn from the file");
  check((await page.locator("[data-pdf-page]").count()) === 3, "three pages are the PDF's");
  check((await page.locator(".handwriting-pane-notice").count()) === 0, "no 'PDF not on this device' sentence");

  // 2 — strokes on a PDF page and on a blank page are stored under their keys and survive a reload.
  await draw("r1:2");
  await draw("b1");
  if (process.argv.includes("--verbose")) {
    await page.waitForTimeout(4000);
    console.log("state:", JSON.stringify(await page.evaluate(async () => (await fetch("/api/browser-app/state")).json())));
    console.log("toasts:", JSON.stringify(await page.locator("[role=status], [role=alert], .toast").allInnerTexts()));
    console.log("canvases:", await page.locator('[data-page-key="r1:2"] canvas').count(), await page.locator(".page-ink-surface").count());
  }
  const stored = async () => { const v = await attr(NOTE, "note_ink"); try { return JSON.parse(v); } catch { return null; } };
  check(await until(async () => { const d = await stored(); const pages = Object.keys(d?.morePages?.pages ?? {}).sort(); return pages.join(",") === "b1,r1:2"; }), "the strokes are stored in note_ink under the pages' keys (b1, r1:2)", JSON.stringify(Object.keys((await stored())?.morePages?.pages ?? {})));
  const d = await stored();
  check(d?.morePages?.carrier === true && (d?.strokes ?? []).length === 0, "the first page of note_ink is the empty carrier");
  check((await attr(NOTE, "note_pages")) === JSON.stringify(list), "the list is not changed by drawing");
  await waitSaved(page);
  await open(`view=notes&node=${NOTE}&lens=editor&tab=${view.id}`);
  check((await keys()).join(",") === "b1,r1:1,r1:2,r1:3,b2", "after a reload the five pages are still in order");
  const again = await stored();
  check(Object.keys(again?.morePages?.pages ?? {}).sort().join(",") === "b1,r1:2" && JSON.stringify(again).match(/"points"/g)?.length === 2, "after a reload both strokes are still stored (two strokes, two pages)");
  // A page that is not near the screen shows its strokes as a picture (PageInkSvg): the PDF page's, after the reload, before anything scrolls there.
  const picture = (key) => page.locator(`[data-page-key="${key}"] .page-ink-svg path`).count();
  check(await until(async () => (await picture("r1:2")) >= 1), "the PDF page shows its stroke after the reload", `r1:2 paths=${await picture("r1:2")}`);
  check((await picture("r1:3")) === 0, "a PDF page nobody drew on shows none", `r1:3 paths=${await picture("r1:3")}`);

  // 3 — what was there before looks as before.
  await open(`view=notes&node=${BOOK}&lens=editor`);
  check((await keys()).join(",") === "page,u1", "a handwriting notebook still has its two pages, `page` first", (await keys()).join(","));
  check(await attr(BOOK, "note_pages") === null, "and no note_pages was written for it");
  await open(`view=notes&node=${OLD_PDF}&lens=editor`);
  check(await until(async () => (await keys()).join(",") === "pdf:1,pdf:2,pdf:3"), "a PDF note made before shows its three pages, keyed pdf:<n>", (await keys()).join(","));
  check(await attr(OLD_PDF, "note_pages") === null && await attr(OLD_PDF, "pdf_url") === url, "its stored data is unchanged (pdf_url, no note_pages)");
  check(errors.length === 0, "no page errors", errors.join(" | "));
} catch (error) {
  check(false, "the script ran to the end", String(error?.stack ?? error).slice(0, 400));
}
await browser.close();
await site.close?.();
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);
