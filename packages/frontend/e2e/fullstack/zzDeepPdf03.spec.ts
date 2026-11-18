// Feature-audit deepening (2026-10-08): PDF-03 — freehand on a PDF: commit
// (back to Select) then leave for Tasks / reload within 200 ms (does the 800
// ms debounced save survive?), Escape during a draw session (it keeps what was
// drawn and goes back to Select: docs/agents/decisions-canvas.md), a refused save.
import { test, expect, type Page } from "@playwright/test";
import { ready, H } from "./helpers";

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

test("PDF-03: ink save timing, Escape, refusal", async ({ page }) => {
  test.setTimeout(300_000);
  const inkGroups = async (id: string) => { const at = await (await page.request.get(`/api/nodes/${id}/attributes`)).json(); const list = Array.isArray(at) ? at : at.attributes ?? []; const raw = list.find((a: { key: string }) => a.key === "ink_data")?.value; if (!raw) return 0; try { return JSON.parse(raw).pages?.["1"]?.strokes.length ?? 0; } catch { return -1; } };
  const newPdf = async () => {
    const node = await (await page.request.post("/api/nodes", { ...H, data: { title: `Pdf3 ${Date.now()}`, markdown: "" } })).json();
    await page.request.put(`/api/nodes/${node.id}/attributes/pdf_url`, { ...H, data: { value: `data:application/pdf;base64,${TINY_PDF}`, value_type: "text" } });
    await ready(page, `/?view=notes&node=${node.id}`);
    await expect(page.locator(".pdf-node-content [data-page-key], .pdf-node-content canvas").first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(800);
    return node.id as string;
  };
  const draw = async (p: Page, dy = 0, commit = true) => {
    const pen = p.locator('[data-ink-tool="pen"]');
    await pen.click();
    await expect(pen, "the pen is the tool before the stroke is drawn").toHaveAttribute("aria-pressed", "true");
    const b = (await p.locator(".pdf-node-content").boundingBox())!; const cx = b.x + b.width / 2, cy = b.y + b.height / 3 + dy;
    await p.mouse.move(cx - 80, cy); await p.mouse.down(); for (const [x, y] of [[cx - 20, cy + 15], [cx + 60, cy - 10]]) await p.mouse.move(x, y, { steps: 6 }); await p.mouse.up();
    if (commit) await p.locator('[data-pdf-tool="select"]').click();
  };
  let id = await newPdf();
  await draw(page);
  // A stroke drawn and committed is saved (after the debounce): one stroke on page 1.
  await expect.poll(() => inkGroups(id), { timeout: 15_000 }).toBe(1);
  // A second stroke, then leaving for Tasks within 200 ms: the debounced save must survive the leave
  // (decisions-canvas.md: 進行中寫入由 writeLifecycle 登記 protectPendingWriteOnExit; the page's own leave commits the draw session first).
  await draw(page, 60); await page.waitForTimeout(200); // the leave is the action under test: it must come before the save's debounce ends
  await page.locator(".app-primary-nav").getByRole("button", { name: "Tasks", exact: true }).click();
  await expect.poll(() => inkGroups(id), { timeout: 15_000 }).toBe(2);
  // The same with a reload within 200 ms.
  id = await newPdf();
  await draw(page); await expect.poll(() => inkGroups(id), { timeout: 15_000 }).toBe(1);
  await draw(page, 60); await page.waitForTimeout(200);
  await page.reload();
  await expect.poll(() => inkGroups(id), { timeout: 15_000 }).toBe(2);
  // Escape during a draw session goes back to Select and keeps what was drawn, saved
  // (decisions-canvas.md: 「Esc 回選取並保留已畫的」; decisions-canvas-history.md: 「Esc 回選取（同樣先存）」).
  id = await newPdf();
  await draw(page, 0, false);
  await page.keyboard.press("Escape");
  await expect.poll(() => inkGroups(id), { timeout: 15_000 }).toBe(1);
  await expect(page.locator(".page-ink-svg path"), "the stroke stays on the page").toHaveCount(1);
  await expect(page.locator('[data-pdf-tool="select"]'), "Escape went back to Select").toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".toast"), "Escape keeps the stroke without a notice").toHaveCount(0); // pinned: today's behaviour, no written rule
  // A refused save (403): the server keeps what it had, the stroke stays on the page, and the refused input is kept in the recovery panel
  // (decisions-offline-account.md, batch 16: a refusal is not a discard; 403 reads 「You don't have permission to do that.」).
  await page.route(`**/api/nodes/${id}/attributes/**`, (r) => r.request().method() === "PUT" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  await draw(page);
  const recovery = page.locator(".failed-write-recovery").filter({ visible: true });
  await expect(recovery).toContainText("This change was rejected");
  await expect(recovery).toContainText("You don't have permission to do that.");
  expect(await inkGroups(id), "the server still has one stroke").toBe(1);
  await expect(page.locator(".page-ink-svg path"), "both strokes stay on the page").toHaveCount(2);
  await expect(page.locator(".toast"), "the refusal is reported once, in the recovery panel, not also as a toast").toHaveCount(0); // pinned: today's behaviour, no written rule
  await page.unroute(`**/api/nodes/${id}/attributes/**`);
});
