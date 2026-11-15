// Usability walkthrough P0s (docs/archive/usability-walkthrough-2026-10-13.md),
// pinned in the real app:
//   F1 — PDF ink saves while drawing mode stays on; Esc keeps it.
//   F5 — quick-capture Esc keeps the draft, across a reload.
//   F6 — a card made by double-clicking the board takes typing in its title.
import { test, expect, type Page } from "@playwright/test";
import { boardOwnCardsOnly, openQuickCapture, ready, H } from "./helpers";


// One blank page, as in pdfInk.spec.ts.
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

async function inkStrokes(page: Page, nodeId: string): Promise<number> {
  const r = await page.request.get(`/api/nodes/${nodeId}/attributes`);
  if (!r.ok()) return 0;
  const raw = ((await r.json()) as Array<{ key: string; value: string }>).find((a) => a.key === "ink_data")?.value;
  if (!raw) return 0;
  try {
    const doc = JSON.parse(raw) as { pages?: Record<string, { strokes: unknown[] }> };
    return Object.values(doc.pages ?? {}).reduce((n, p) => n + p.strokes.length, 0);
  } catch { return 0; }
}

async function stroke(page: Page, dy: number): Promise<void> {
  const box = (await page.locator(".pdf-node-content").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2 + dy;
  await page.mouse.move(cx - 80, cy);
  await page.mouse.down();
  for (const x of [cx - 30, cx + 20, cx + 80]) await page.mouse.move(x, cy + 10, { steps: 6 });
  await page.mouse.up();
}

test("F1: PDF ink is saved without leaving drawing mode, and Esc keeps it", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "chromium-scoped like the other PDF ink specs");
  const node = (await (await page.request.post("/api/nodes", {
    ...H, data: { title: `UX F1 ${Date.now()}`, markdown: "" },
  })).json()) as { id: string };
  expect((await page.request.put(`/api/nodes/${node.id}/attributes/pdf_url`, {
    ...H, data: { value: `data:application/pdf;base64,${TINY_PDF}`, value_type: "text" },
  })).ok()).toBeTruthy();

  await ready(page, `/?view=notes&node=${node.id}`);
  await expect(page.locator(".pdf-node-content [data-page-key], .pdf-node-content canvas").first()).toBeVisible({ timeout: 20_000 });

  await page.locator('[data-ink-tool="pen"]').click();
  await stroke(page, -60);
  // Still on the pen: the stroke reaches the server on its own.
  await expect(page.locator('[data-ink-tool="pen"][aria-pressed="true"]')).toBeVisible();
  await expect.poll(() => inkStrokes(page, node.id), { timeout: 10_000 }).toBeGreaterThan(0);
  const afterFirst = await inkStrokes(page, node.id);

  // A second stroke, then Esc right away: going back to Select keeps it.
  await stroke(page, 40);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-pdf-tool="select"][aria-pressed="true"]')).toBeVisible();
  await expect.poll(() => inkStrokes(page, node.id), { timeout: 10_000 }).toBeGreaterThan(afterFirst);

  await page.reload({ waitUntil: "load" });
  await ready(page, `/?view=notes&node=${node.id}`);
  await expect(page.locator(".page-ink-svg path").first()).toBeVisible({ timeout: 20_000 });
});

test("F5: quick-capture Esc keeps the draft, across a reload", async ({ page }) => {
  const text = `UX F5 draft ${Date.now()}`;
  await ready(page);
  await openQuickCapture(page);
  await page.locator(".quick-capture-textarea").fill(text);
  await page.keyboard.press("Escape");
  await expect(page.locator(".quick-capture-textarea")).toBeHidden();

  await page.reload({ waitUntil: "load" });
  await ready(page);
  await openQuickCapture(page);
  await expect(page.locator(".quick-capture-textarea")).toHaveValue(text);

  // Deleting the text clears the stored draft.
  await page.locator(".quick-capture-textarea").fill("");
  await page.keyboard.press("Escape");
  await page.reload({ waitUntil: "load" });
  await ready(page);
  await openQuickCapture(page);
  await expect(page.locator(".quick-capture-textarea")).toHaveValue("");
});

test("F6: a card made by double-clicking the board takes typing in its title", async ({ page }) => {
  const stamp = Date.now();
  const canvas = await (await page.request.post("/api/canvases", { ...H, data: { title: `UX F6 ${stamp}` } })).json();
  await ready(page, `/?view=notes&node=${canvas.id}`);
  const pane = page.locator(".react-flow__pane");
  await pane.waitFor({ timeout: 30_000 });
  // A board of the person's own cards, so the double-click lands on empty board, not on the note's own card.
  await boardOwnCardsOnly(page);
  // The hint renders once the board is active; a double-click before that
  // lands on a board with no canvas to place the card on.
  await expect(page.locator(".canvas-empty-hint")).toBeVisible({ timeout: 30_000 });

  const box = (await pane.boundingBox())!;
  // A double-click during the cold-start membership gate lands on its scrim
  // and is dropped (only typing is kept), so retry while no card exists yet.
  const title = page.locator(".card-node-title-input:focus");
  await expect(async () => {
    if (await page.locator(".react-flow__node").count() === 0) {
      await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    }
    await expect(title).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await page.keyboard.type(`Typed ${stamp}`);
  await page.keyboard.press("Enter");

  // The title is an input, so check its value (has-text never sees it).
  await expect(page.locator(".card-node-title-input").first()).toHaveValue(`Typed ${stamp}`);
  // The server has the card on the board, under the typed title.
  await expect.poll(async () => {
    const saved = await (await page.request.get(`/api/canvases/${canvas.id}`, H)).json();
    const ids = ((saved.data?.nodes ?? []) as Array<{ nodeId?: string }>).map((n) => n.nodeId).filter(Boolean);
    for (const id of ids) {
      const r = await page.request.get(`/api/nodes/${id}`, H);
      if (r.ok() && ((await r.json()) as { title?: string }).title === `Typed ${stamp}`) return true;
    }
    return false;
  }, { timeout: 15_000 }).toBe(true);
});
