// npm run build:browser (repo root), then: node e2e/browser-app/pdfNoteText.mjs [chromium] [--dir dist-browser]
// A PDF note carries its text: the create sheet's 「上傳檔案」 with a text PDF → the note's body holds the PDF's words and search finds them.
// The PDF is built here (a few hundred bytes, one line of text): no binary is committed.
// Exit code 1 when a check fails; 2 when the browser cannot start.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { serve } from "./serve.mjs";
import { contextOptions, VIEWPORTS, READY_TEXT, waitSaved } from "../layout-audit/env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const engine = "chromium"; // the create sheet's 建立 button is the desktop window's
const dirArg = process.argv.indexOf("--dir");
const vp = VIEWPORTS.find((v) => v.id === "1280");
const failures = [];
const check = (ok, what, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} [${engine}] ${what}${detail ? ` — ${detail}` : ""}`); if (!ok) failures.push(what); };

/** A one-page PDF whose only text is `word` (hand-written objects; pdf.js rebuilds a missing xref). */
function textPdf(word) {
  const stream = `BT /F1 24 Tf 72 700 Td (${word}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n"; const offsets = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const WORD = "Quokkaphrase";

let browser;
try { browser = await playwright.chromium.launch(); } catch (error) { console.log(`SKIPPED: ${String(error).slice(0, 160)}`); process.exit(2); }
const site = await serve(resolve(here, "../..", dirArg > 0 ? process.argv[dirArg + 1] : "dist-browser"));
const context = await browser.newContext(contextOptions(vp));
const until = async (probe, ms = 30_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await probe()) return true; await new Promise((r) => setTimeout(r, 400)); } return false; };
const openPage = async (path) => {
  const page = await context.newPage();
  await page.goto(`${site.base}${path}`);
  // The welcome note is the landing on a desktop only; on a phone the app is ready when its local backend answers.
  const ready = await until(() => page.evaluate(async () => (await fetch("/api/browser-app/state")).ok).catch(() => false), 120_000);
  if (!ready) throw new Error("the browser app did not start");
  await page.getByText(READY_TEXT).first().waitFor({ state: "attached", timeout: 120_000 });
  return page;
};
const call = (page, method, path, body) => page.evaluate(async ({ method, path, body }) => {
  const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status}`);
  return r.status === 204 ? null : r.json();
}, { method, path, body });
try {
  // The create sheet's 「上傳檔案」 with a text PDF (the desktop window's 建立 button).
  const page = await openPage("");
  await page.waitForTimeout(2_000);
  await page.getByRole("button", { name: "建立", exact: true }).first().click();
  await page.getByRole("dialog").getByText("上傳檔案", { exact: true }).first().click();
  const chooser = page.waitForEvent("filechooser", { timeout: 20_000 });
  await page.getByRole("dialog").getByRole("button", { name: "建立", exact: true }).click();
  await (await chooser).setFiles({ name: "Sheet_Door.pdf", mimeType: "application/pdf", buffer: textPdf(WORD) });
  const found = await until(async () => (await call(page, "GET", `/api/nodes/search?q=${WORD}`)).length > 0, 60_000);
  check(found, "search finds a word of the PDF made from the create sheet");
  await waitSaved(page);
  await page.close();
} catch (error) {
  check(false, "the script ran to the end", String(error).slice(0, 300));
} finally {
  await browser.close();
  site.close?.();
}
if (failures.length) { console.log(`${failures.length} check(s) failed`); process.exit(1); }
console.log("all checks passed");
