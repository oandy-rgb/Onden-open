// Feature-audit deepening (2026-10-08): PDF-02 diagnostic — does a real mouse
// drag select text (and show the → Card tip) on page 1 vs page 3 of a 20-page PDF?
import { test, type Page } from "@playwright/test";
import { ready, BASE, H } from "../fullstack/helpers";
import { readFileSync } from "node:fs";

const FX = "/var/home/oandy/桌面/git/note/Onden/.acceptance/feature-loop-2026-10-07/tick7/fixture";

test("PDF-02x: drag selection page 1 vs 3", async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const req = page.request;
  const up = await (await req.post("/api/media", { headers: { origin: BASE }, multipart: { file: { name: `p02x-${stamp}.pdf`, mimeType: "application/pdf", buffer: readFileSync(`${FX}/text20.pdf`) } } })).json();
  const pdf = (await (await req.post("/api/nodes", { ...H, data: { title: `PDF02x ${stamp}`, markdown: "" } })).json()).id as string;
  await req.put(`/api/nodes/${pdf}/attributes/pdf_url`, { ...H, data: { value: up.url, value_type: "text" } });
  await ready(page, `/?view=notes&node=${pdf}`);
  await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  await page.locator(".pdf-text-layer span").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  const tryDrag = async (p: Page, pageNo: number, line: number, how: string) => {
    if (pageNo > 1) await p.locator(`[data-page-key="pdf:${pageNo}"]`).evaluate((el) => { const sc = document.querySelector(".pagebook-scroll") as HTMLElement; sc.scrollTop = (el as HTMLElement).offsetTop; });
    const span = p.locator(`[data-page-key="pdf:${pageNo}"] .pdf-text-layer span`, { hasText: `Line ${line} of page ${pageNo}` }).first();
    await span.waitFor({ timeout: 15_000 });
    await p.waitForTimeout(1200);
    const b = (await span.boundingBox())!;
    const y = b.y + b.height / 2;
    if (how === "drag") { await p.mouse.move(b.x + 1, y); await p.mouse.down(); await p.mouse.move(b.x + b.width - 1, y, { steps: 12 }); await p.mouse.up(); }
    else await p.mouse.click(b.x + 20, y, { clickCount: 2 });
    await p.waitForTimeout(800);
    return `${how} p${pageNo} L${line}: sel=${JSON.stringify(await p.evaluate(() => String(window.getSelection()).slice(0, 40)))} tip=${await p.locator(".pdf-node-selection-tip").count()}`;
  };
  const res = [await tryDrag(page, 1, 5, "drag"), await tryDrag(page, 1, 7, "dbl"), await tryDrag(page, 3, 5, "drag"), await tryDrag(page, 3, 7, "dbl")];
  console.log("PDF02X " + JSON.stringify(res, null, 2));
});
