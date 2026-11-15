import { test, expect, type Page } from "@playwright/test";
import { ready, H } from "./helpers";

// PDF ink unification: freehand drawn on a PDF persists as the CANONICAL ink
// doc (per-page InkMultiPageDoc on ink_data — same rail as canvas ink, so it
// is diffable/governable), renders as vector SVG (no dataUrl bitmaps), and
// survives a reload. Chromium-scoped like the other ink specs.


// Minimal single-page PDF (one blank A4-ish page), small enough to inline.
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

type Attr = { key: string; value: string };

async function attrs(page: Page, nodeId: string): Promise<Attr[]> {
  const r = await page.request.get(`/api/nodes/${nodeId}/attributes`);
  return r.ok() ? ((await r.json()) as Attr[]) : [];
}

test("pdf ink: freehand persists as vector ink_data, renders as SVG, survives reload", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "chromium-scoped: pdf.js + drawing capture envelope");
  const stamp = Date.now();

  const node = (await (await page.request.post("/api/nodes", {
    ...H,
    data: { title: `Paper ${stamp}`, markdown: "" },
  })).json()) as { id: string };
  const pdfAttribute = await page.request.put(`/api/nodes/${node.id}/attributes/pdf_url`, {
    ...H,
    data: { value: `data:application/pdf;base64,${TINY_PDF}`, value_type: "text" },
  });
  expect(pdfAttribute.ok()).toBeTruthy();

  await ready(page, `/?view=notes&node=${node.id}`);
  await expect(page.locator(".pdf-node-bar")).toBeVisible({ timeout: 20_000 });
  // pdf.js page mounted (text layer or page canvas inside the highlighter).
  await expect(page.locator(".pdf-node-content [data-page-key], .pdf-node-content canvas").first())
    .toBeVisible({ timeout: 20_000 });

  // ── Draw a freehand stroke ────────────────────────────────────────────────
  // One toolbar, always: Select, then the handwriting page's own tools — the
  // shapes are one button (0422ea6e) and Text joined them (PdfInkTools.test).
  await expect(page.locator(".ink-note-toolbar")).toHaveCount(1);
  const toolIds = () => page.locator('.ink-note-toolbar [role="group"][aria-label="Tool"] > button')
    .evaluateAll((buttons) => buttons.map((b) => b.getAttribute("data-ink-tool") ?? b.getAttribute("data-pdf-tool")));
  await expect.poll(toolIds).toEqual(["select", "pen", "highlighter", "eraser", "shape", "hand", "text"]);
  await expect(page.locator('[data-pdf-tool="select"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator('[data-ink-tool="pen"]').click();
  await expect(page.locator(".ink-note-toolbar")).toHaveCount(1);
  const box = (await page.locator(".pdf-node-content").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 80, cy - 30);
  await page.mouse.down();
  for (const [x, y] of [[cx - 30, cy], [cx + 20, cy - 20], [cx + 80, cy + 10]] as Array<[number, number]>) {
    await page.mouse.move(x, y, { steps: 6 });
  }
  await page.mouse.up();
  // Strokes also save on their own a second after the pen lifts (uxP0 F1);
  // Going back to Select commits at once.
  await page.locator('[data-pdf-tool="select"]').click();
  await expect(page.locator('[data-pdf-tool="select"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".ink-note-toolbar")).toHaveCount(1);

  // ── Canonical persistence: ink_data envelope, page 1 ──────────────────────
  // Two forms of the same drawing (page units, step 1 of merging the PDF and
  // handwriting pages): `units` (InkPages: pdf:1, an InkDocument 1000 wide) and the
  // older fields (pages[1] + a drawing record), still written for older apps.
  type Envelope = {
    version: number;
    pages?: Record<string, { strokes: Array<{ id: string }> }>;
    annotations?: Array<{ type: string; content?: { image?: string; strokes?: unknown[] } }>;
    units?: { pages: Record<string, { key: string; background: { kind: string; page: number }; size: { width: number }; doc: { strokes: Array<{ id: string }>; page: { width: number } } }> };
    unitsFrom?: string;
  };
  const envelopeOf = async (): Promise<Envelope | null> => {
    const raw = (await attrs(page, node.id)).find((a) => a.key === "ink_data")?.value;
    if (!raw) return null;
    try { return JSON.parse(raw) as Envelope; } catch { return null; }
  };
  await expect.poll(async () => (await envelopeOf())?.units?.pages["pdf:1"]?.doc.strokes.length ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
  const envelope = (await envelopeOf())!;
  const unitsPage = envelope.units!.pages["pdf:1"]!;
  expect(unitsPage).toMatchObject({ key: "pdf:1", background: { kind: "pdf", page: 1 }, size: { width: 1000 }, doc: { page: { width: 1000 } } });
  expect(typeof envelope.unitsFrom).toBe("string");
  // the older form says the same drawing, with the same stroke ids, and no bitmap
  expect(envelope.pages?.["1"]?.strokes.map((s) => s.id)).toEqual(unitsPage.doc.strokes.map((s) => s.id));
  const drawing = (envelope.annotations ?? []).find((h) => h.type === "drawing")!;
  expect(drawing.content?.image).toBeUndefined();
  expect((drawing.content?.strokes ?? []).length).toBeGreaterThan(0);

  // ── Committed rendering is vector SVG, and it survives a reload ──────────
  await expect(page.locator(".page-ink-svg path").first()).toBeVisible();
  await page.reload({ waitUntil: "load" });
  await ready(page, `/?view=notes&node=${node.id}`);
  await expect(page.locator(".page-ink-svg path").first()).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: "/tmp/pw-output/shots/pdf-ink-vector.png", fullPage: false });
});
