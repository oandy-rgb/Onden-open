// Feature-audit deepening (2026-10-08, tick 9): INK-03 — history wording and
// thumbnails per host. Writes the same revision sequence (1 stroke → 2 strokes
// → erase a span → undo back to 1) to a handwritten note, a canvas and a PDF,
// then reads each node's History page; also enrols a PDF-with-ink and an
// erased ink note as review cards and reads the revealed card body.
import { test, type Page } from "@playwright/test";
import { ready, H } from "../fullstack/helpers";
import { makeReviewCard } from "../fullstack/reviewFixtures";

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

const S0 = { id: "s0", points: [[10, 10, 0.5], [200, 120, 0.5], [300, 200, 0.5]], color: "#000", size: 3 };
const S1 = { id: "s1", points: [[50, 300, 0.5], [250, 320, 0.5]], color: "#000", size: 3 };
const doc = (strokes: unknown[], erased: Record<string, unknown> = {}) => ({ version: 1, page: { width: 800 }, erased, strokes });
const REVS = [doc([S0]), doc([S0, S1]), doc([S0, S1], { s0: [[0, 0.5]] }), doc([S0])];
const wrap = (d: unknown) => ({ version: 1, pages: { 1: d } });

test("INK-03b: history wording and thumbnails per host", async ({ page }) => {
  test.setTimeout(300_000);
  const out: Record<string, unknown> = {};
  const req = page.request;
  const s = Date.now();
  const mk = async (title: string, md = "") => (await (await req.post("/api/nodes", { ...H, data: { title, markdown: md } })).json()).id as string;
  const put = (id: string, v: unknown) => req.put(`/api/nodes/${id}/attributes/ink_data`, { ...H, data: { value: JSON.stringify(v) } });
  const history = async (p: Page, id: string) => {
    // The per-note event list left History with the lens (history is the time slider now), so this
    // reads whatever the note's page shows: no raw ink JSON may appear there.
    await ready(p, `/?view=notes&node=${id}`); await p.waitForTimeout(3000);
    const t = (await p.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");
    return { drawing: t.match(/drawing[^·]{0,70}/g)?.slice(0, 6) ?? [], rawJson: /ink_data = \{/.test(t), excerpt: t.slice(0, 260) };
  };
  try {
    await ready(page, "/?view=notes");
    const note = await mk(`Ink03b note ${s}`);
    const canvas = (await (await req.post("/api/canvases", { ...H, data: { title: `Ink03b canvas ${s}` } })).json()).id as string;
    const pdf = await mk(`Ink03b pdf ${s}`);
    await req.put(`/api/nodes/${pdf}/attributes/pdf_url`, { ...H, data: { value: `data:application/pdf;base64,${TINY_PDF}`, value_type: "text" } });
    for (const r of REVS) { await put(note, r); await put(canvas, r); await put(pdf, wrap(r)); await page.waitForTimeout(300); }
    out.note = await history(page, note);
    out.canvas = await history(page, canvas);
    out.pdf = await history(page, pdf);
    const iv = await req.get(`/api/nodes/${pdf}/ink-versions`);
    out.pdfInkVersions = iv.status();

    // Thumbnails on review cards.
    const deck = await mk(`Ink03b deck ${s}`);
    const erasedNote = await mk(`Ink03b erased ${s}`);
    await put(erasedNote, doc([S0, S1], { s0: [[0, 1]] }));
    const pdfCard = await mk(`Ink03b pdfcard ${s}`);
    await req.put(`/api/nodes/${pdfCard}/attributes/pdf_url`, { ...H, data: { value: `data:application/pdf;base64,${TINY_PDF}`, value_type: "text" } });
    await put(pdfCard, wrap(doc([S0, S1])));
    for (const [i, id] of [erasedNote, pdfCard].entries()) {
      await req.patch(`/api/nodes/${id}`, { ...H, data: { parent_id: deck, sort_order: i } });
      await makeReviewCard(req, id);
    }
    await ready(page, `/?view=notes&node=${deck}`);
    await page.keyboard.press("Control+k"); await page.locator(".palette-input-wrap input").fill(">Review cards");
    await page.locator(".palette-item", { hasText: "Review cards under this note" }).click();
    await page.locator(".review-panel").waitFor({ timeout: 10_000 });
    const cards: Record<string, unknown> = {};
    for (let i = 0; i < 4; i++) {
      const title = (await page.locator(".review-card-title").innerText().catch(() => "")).trim();
      if (!title) break;
      await page.locator(".review-reveal").click(); await page.waitForTimeout(700);
      const body = page.locator(".review-card-body");
      cards[title.replace(/ \d+$/, "")] = { thumb: await body.locator(".review-ink-thumb").count(), paths: await body.locator(".review-ink-thumb path").count(), text: (await body.innerText()).replace(/\s+/g, " ").slice(0, 80) };
      await page.locator(".review-grade--3").click(); await page.waitForTimeout(800);
    }
    out.reviewCards = cards;
  } finally {
    console.log("INK03B " + JSON.stringify(out, null, 2));
  }
});
