// Feature-audit deepening (2026-10-08, tick 8): INK-03 — the three ink hosts
// (handwritten note, canvas ink layer, PDF ink) against a damaged ink_data
// value ("lost blob": unparsable, wrong shape, empty) and against a failing
// save (500), then reopen. Observes: which surface renders, error boundary,
// page errors, and what the next stroke does to the stored value.
import { test, type Page } from "@playwright/test";
import { ready, H, syncLabel } from "../fullstack/helpers";

const TINY_PDF = Buffer.from(
  `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<<>>>>endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000052 00000 n
0000000101 00000 n
trailer<</Size 4/Root 1 0 R>>
startxref
178
%%EOF`,
).toString("base64");

const raw = async (page: Page, id: string) => {
  const at = await (await page.request.get(`/api/nodes/${id}/attributes`)).json();
  const list = Array.isArray(at) ? at : at.attributes ?? [];
  return list.find((a: { key: string }) => a.key === "ink_data")?.value as string | undefined;
};
const summary = (v: string | undefined) => {
  if (v === undefined) return "absent";
  try { const p = JSON.parse(v); if (p?.pages) return `pdf:${Object.values(p.pages as Record<string, { strokes?: unknown[] }>).reduce((n, d) => n + (d.strokes?.length ?? 0), 0)}`; return `doc:${Array.isArray(p?.strokes) ? p.strokes.length : "noStrokes"}`; } catch { return `unparsable:${v.slice(0, 12)}`; }
};
async function stroke(page: Page, box: { x: number; y: number; width: number; height: number }, dy = 0) {
  const cx = box.x + box.width / 2, cy = box.y + Math.min(box.height / 2, 250) + dy;
  await page.mouse.move(cx - 100, cy); await page.mouse.down();
  await page.mouse.move(cx, cy + 20, { steps: 8 }); await page.mouse.move(cx + 100, cy - 10, { steps: 8 }); await page.mouse.up();
}
const CORRUPT: Record<string, string | null> = { control: null,  garbage: "{not json", wrongShape: '{"version":1}', emptyString: "" };

test("INK-03: damaged ink_data and failing saves across hosts", async ({ page }) => {
  test.setTimeout(600_000);
  const out: Record<string, unknown> = {};
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 120)));
  const observe = async () => ({
    inkNote: await page.locator(".ink-note").count(),
    canvasLayer: await page.locator(".canvas-ink-layer").count(),
    pdfToolbar: await page.locator(".pdf-node-bar").count(),
    boundary: (await page.locator(".app-error-boundary").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 80),
    pageErrors: errors.splice(0).slice(0, 3),
  });
  const makeNote = async () => (await (await page.request.post("/api/nodes", { ...H, data: { title: `Ink03 ${Date.now()}`, markdown: "" } })).json()).id as string;
  const makeCanvas = async () => (await (await page.request.post("/api/canvases", { ...H, data: { title: `Ink03c ${Date.now()}` } })).json()).id as string;
  const makePdf = async () => { const id = await makeNote(); await page.request.put(`/api/nodes/${id}/attributes/pdf_url`, { ...H, data: { value: `data:application/pdf;base64,${TINY_PDF}`, value_type: "text" } }); return id; };
  const seed = (id: string, v: string) => page.request.put(`/api/nodes/${id}/attributes/ink_data`, { ...H, data: { value: v } });

  const drawOn = async (host: string) => {
    if (host === "note") { if (!(await page.locator(".pagebook-page").count())) return "noPage"; const b = await page.locator(".pagebook-page").boundingBox(); if (!b) return "noPage"; await stroke(page, b); await page.waitForTimeout(2500); return "drawn"; }
    if (host === "canvas") { if (!(await page.locator(".canvas-ink-toolbar").isVisible())) await page.keyboard.press("p"); await page.waitForTimeout(1500); if (!(await page.locator(".canvas-ink-layer").count())) return "noLayer"; const b = await page.locator(".canvas-ink-layer").boundingBox(); if (!b) return "noLayer"; await stroke(page, b); await page.waitForTimeout(2500); return "drawn"; }
    const btn = page.locator('[data-ink-tool="pen"]');
    if (!(await btn.count())) return "noDrawBtn";
    await btn.click(); await page.waitForTimeout(500);
    const b = await page.locator(".pdf-node-content").boundingBox(); if (!b) return "noContent";
    await stroke(page, b); await page.waitForTimeout(300);
    const stop = page.locator('[data-pdf-tool="select"]');
    if (await stop.count()) await stop.click();
    await page.waitForTimeout(2500); return "drawn";
  };
  const make: Record<string, () => Promise<string>> = { note: makeNote, canvas: makeCanvas, pdf: makePdf };

  try {
    // Damaged values per host.
    for (const host of ["note", "canvas", "pdf"]) {
      for (const [kind, v] of Object.entries(CORRUPT)) {
        if (host === "note" && v === null) continue; // a note without ink_data is not an ink note
        const id = await make[host]();
        if (v !== null) await seed(id, v);
        await ready(page, `/?view=notes&node=${id}`); await page.waitForTimeout(3500);
        const r: Record<string, unknown> = { open: await observe(), openToast: (await page.locator(".toast").allInnerTexts()).join(" | ").replace(/\s+/g, " ").slice(-100) };
        r.draw = await drawOn(host);
        r.storedAfterDraw = summary(await raw(page, id));
        r.toast = (await page.locator(".toast").allInnerTexts()).join(" | ").replace(/\s+/g, " ").slice(-100);
        await ready(page, `/?view=notes&node=${id}`); await page.waitForTimeout(3000);
        r.reopen = await observe();
        out[`${host}.${kind}`] = r;
      }
    }
    // Failing save (500) per host, then reopen.
    for (const host of ["canvas", "pdf"]) {
      const id = await make[host]();
      await ready(page, `/?view=notes&node=${id}`); await page.waitForTimeout(3500);
      const r: Record<string, unknown> = {};
      r.first = await drawOn(host); r.storedOne = summary(await raw(page, id));
      if (host === "canvas") { await page.keyboard.press("Escape"); await page.waitForTimeout(300); }
      await page.route(`**/api/nodes/${id}/attributes/ink_data`, (q) => q.request().method() === "PUT" ? q.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' }) : q.continue());
      r.second = await drawOn(host);
      await page.waitForTimeout(4000);
      r.storedAfterFail = summary(await raw(page, id));
      r.toast = (await page.locator(".toast").allInnerTexts()).join(" | ").replace(/\s+/g, " ").slice(-120);
      r.recovery = (await page.locator(".failed-write-recovery").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 100);
      r.sync = (await syncLabel(page)).replace(/\s+/g, " ");
      await page.unroute(`**/api/nodes/${id}/attributes/ink_data`);
      await page.waitForTimeout(8000);
      r.storedAfterUnroute = summary(await raw(page, id));
      await ready(page, `/?view=notes&node=${id}`); await page.waitForTimeout(3000);
      r.reopenStored = summary(await raw(page, id));
      r.reopenSvgPaths = host === "pdf" ? await page.locator(".page-ink-svg path").count() : undefined;
      out[`${host}.save500`] = r;
    }
  } finally {
    console.log("INK03 " + JSON.stringify(out, null, 2));
  }
});
