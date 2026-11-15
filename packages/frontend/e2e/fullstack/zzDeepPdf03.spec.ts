// Feature-audit deepening (2026-10-08): PDF-03 — freehand on a PDF: commit
// (back to Select) then leave for Tasks / reload within 200 ms (does the 800
// ms debounced save survive?), Escape during a draw session, a refused save.
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
  const out: Record<string, unknown> = {};
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
    await p.locator('[data-ink-tool="pen"]').click();
    const b = (await p.locator(".pdf-node-content").boundingBox())!; const cx = b.x + b.width / 2, cy = b.y + b.height / 3 + dy;
    await p.mouse.move(cx - 80, cy); await p.mouse.down(); for (const [x, y] of [[cx - 20, cy + 15], [cx + 60, cy - 10]]) await p.mouse.move(x, y, { steps: 6 }); await p.mouse.up();
    if (commit) await p.locator('[data-pdf-tool="select"]').click();
  };
  try {
  let id = await newPdf();
  await draw(page); await page.waitForTimeout(2000);
  out.baseline = await inkGroups(id);
  await draw(page, 60); await page.waitForTimeout(200);
  await page.locator(".app-primary-nav").getByRole("button", { name: "Tasks", exact: true }).click();
  await page.waitForTimeout(2500);
  out.leaveQuick = { stored: await inkGroups(id), expected: 2 };
  id = await newPdf();
  await draw(page); await page.waitForTimeout(2000); await draw(page, 60); await page.waitForTimeout(200);
  await page.reload(); await page.waitForTimeout(3000);
  out.reloadQuick = { stored: await inkGroups(id), expected: 2 };
  id = await newPdf();
  await draw(page, 0, false); await page.keyboard.press("Escape"); await page.waitForTimeout(2000);
  out.escapeDiscards = { stored: await inkGroups(id), svg: await page.locator(".page-ink-svg path").count(), toast: (await page.locator(".toast").allInnerTexts()).join(" | ").slice(-80) };
  await page.route(`**/api/nodes/${id}/attributes/**`, (r) => r.request().method() === "PUT" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  await draw(page); await page.waitForTimeout(2500);
  out.refused = { stored: await inkGroups(id), svg: await page.locator(".page-ink-svg path").count(), toast: (await page.locator(".toast").allInnerTexts()).join(" | ").replace(/\s+/g, " ").slice(-90), recovery: (await page.locator(".failed-write-recovery").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 50) };
  await page.unroute(`**/api/nodes/${id}/attributes/**`);
  } finally {
    console.log("PDF03 " + JSON.stringify(out, null, 2));
  }
});
