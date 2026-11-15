// Feature-audit deepening (2026-10-08): PDF-02 — real text selection on page 3
// of a 20-page PDF → "→ Card": body/page/edge; then failures: the source edge
// POST fails, the card POST 503s (can the same selection be retried?), and the
// card POST commits but its response is lost (retry → duplicate?). Finally,
// from a card, how does the user get back to the source page?
import { test, type Page } from "@playwright/test";
import { ready, BASE, H, psql as sql } from "../fullstack/helpers";
import { readFileSync } from "node:fs";

const FX = "/var/home/oandy/桌面/git/note/Onden/.acceptance/feature-loop-2026-10-07/tick7/fixture";

test("PDF-02: capture, failures, retry, back to source", async ({ page }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const req = page.request;
  const up = await (await req.post("/api/media", { headers: { origin: BASE }, multipart: { file: { name: `p02-${stamp}.pdf`, mimeType: "application/pdf", buffer: readFileSync(`${FX}/text20.pdf`) } } })).json();
  const pdf = (await (await req.post("/api/nodes", { ...H, data: { title: `PDF02 ${stamp}`, markdown: "" } })).json()).id as string;
  await req.put(`/api/nodes/${pdf}/attributes/pdf_url`, { ...H, data: { value: up.url, value_type: "text" } });
  const cards = () => sql(`select n.title || ' | ' || replace(n.markdown, E'\\n', ' ') || ' | page=' || coalesce((select value from node_attributes a where a.node_id=n.id and a.key='pdf_page'),'-') || ' | edge=' || (select count(*) from node_edges e where e.source_node_id=n.id and e.target_node_id='${pdf}' and e.edge_type='highlight_source') from content_nodes n where parent_id='${pdf}' and deleted_at is null order by created_at`).split("\n").filter(Boolean);
  const annCount = () => { const v = sql(`select value from node_attributes where node_id='${pdf}' and key='ink_data'`); try { return (JSON.parse(v).annotations ?? []).length; } catch { return 0; } };

  await ready(page, `/?view=notes&node=${pdf}`);
  await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  await page.locator(".pdf-text-layer span").first().waitFor({ timeout: 30_000 });
  const select = async (p: Page, lineNo: number, pageNo = 3) => {
    // Scroll only the PDF scroller so the toolbar and tip stay in view.
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.locator(`[data-page-key="pdf:${pageNo}"]`).evaluate((el) => { const sc = document.querySelector(".pagebook-scroll") as HTMLElement; sc.scrollTop = (el as HTMLElement).offsetTop; });
    const span = p.locator(`[data-page-key="pdf:${pageNo}"] .pdf-text-layer span`, { hasText: `Line ${lineNo} of page ${pageNo}` }).first();
    await span.waitFor({ timeout: 15_000 });
    await span.evaluate((el) => { const sc = document.querySelector(".pagebook-scroll") as HTMLElement; const r = el.getBoundingClientRect(); const s = sc.getBoundingClientRect(); sc.scrollTop += r.top - s.top - s.height / 3; });
    await p.evaluate(() => window.getSelection()?.removeAllRanges());
    await p.waitForTimeout(1200);
    const b = (await span.boundingBox())!;
    // Full-width drag across the line (double/triple-click commits a highlight
    // but the → Card tip vanishes; see zzDeepPdf02x).
    await p.mouse.move(b.x + 1, b.y + b.height / 2);
    await p.mouse.down();
    await p.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 12 });
    await p.mouse.up();
    const tip = p.locator(".pdf-node-selection-tip");
    await p.waitForTimeout(500);
    console.log(`SEL line=${lineNo} box=${JSON.stringify(b)} sel=${JSON.stringify(await p.evaluate(() => String(window.getSelection()).slice(0, 50)))} tipDom=${await tip.count()} scrollerTop=${await p.evaluate(() => (document.querySelector(".pagebook-scroll") as HTMLElement).scrollTop)}`);
    return tip.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
  };
  const toasts = async () => (await page.locator(".toast").allInnerTexts().catch(() => [])).map((s) => s.replace(/\s+/g, " ").slice(0, 120));

  // 1. Normal.
  out.tip1 = await select(page, 5);
  out.selected1 = await page.evaluate(() => String(window.getSelection()).slice(0, 60));
  await page.locator(".pdf-node-selection-tip").click();
  await page.waitForTimeout(2000);
  out.flash1 = await page.locator(".pdf-node-spawn-flash").count();
  out.cards1 = cards();
  out.ann1 = annCount();

  // 2. Edge POST fails.
  await page.route("**/api/edges", (r) => r.request().method() === "POST" ? r.fulfill({ status: 500, body: "{\"error\":\"boom\"}", contentType: "application/json" }) : r.continue());
  out.tip2 = await select(page, 9);
  await page.locator(".pdf-node-selection-tip").click();
  await page.waitForTimeout(2000);
  out.flash2 = await page.locator(".pdf-node-spawn-flash").count();
  out.toasts2 = await toasts();
  await page.unroute("**/api/edges");
  out.cards2 = cards();

  // 3. Card POST 503 → can the same selection be retried?
  await page.route("**/api/nodes", (r) => r.request().method() === "POST" ? r.fulfill({ status: 503, body: "{\"error\":\"unavailable\"}", contentType: "application/json" }) : r.continue());
  out.tip3 = await select(page, 13);
  await page.locator(".pdf-node-selection-tip").click();
  await page.waitForTimeout(2000);
  out.toasts3 = await toasts();
  out.ann3 = annCount();
  await page.unroute("**/api/nodes");
  out.tip3Still = await page.locator(".pdf-node-selection-tip").isVisible().catch(() => false);
  out.tip3Retry = await select(page, 13);
  if (out.tip3Retry) { await page.locator(".pdf-node-selection-tip").click(); await page.waitForTimeout(2000); }
  out.cards3 = cards();
  out.ann3after = annCount();

  // 4. Card POST commits, response lost; retry.
  let n = 0;
  await page.route("**/api/nodes", async (r) => {
    if (r.request().method() === "POST" && n++ === 0) { await r.fetch(); return r.abort("connectionreset"); }
    return r.continue();
  });
  out.tip4 = await select(page, 17);
  await page.locator(".pdf-node-selection-tip").click();
  await page.waitForTimeout(2000);
  out.toasts4 = await toasts();
  out.tip4Retry = await select(page, 17);
  if (out.tip4Retry) { await page.locator(".pdf-node-selection-tip").click(); await page.waitForTimeout(2000); }
  await page.unroute("**/api/nodes");
  out.cards4 = cards();
  out.idemKeyHeader = "see code: spawnHighlightNode sends no Idempotency-Key";

  // 5. From a card back to the source.
  const firstCard = sql(`select id from content_nodes where parent_id='${pdf}' and deleted_at is null order by created_at limit 1`);
  await ready(page, `/?view=notes&node=${firstCard}`);
  await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  out.cardLinks = await page.evaluate(() => Array.from(document.querySelectorAll("a, button")).map((e) => (e as HTMLElement).innerText.trim()).filter((s) => /PDF02|page|source|Source/.test(s)).slice(0, 8));
  const parentLink = page.locator("button, a", { hasText: `PDF02 ${stamp}` }).first();
  out.parentLinkFound = await parentLink.count();
  if (await parentLink.count()) {
    await parentLink.click();
    await page.waitForTimeout(3000);
    out.backToSource = { url: page.url().replace(BASE, ""), scrollTop: await page.evaluate(() => Math.round((document.querySelector(".pagebook-scroll") as HTMLElement | null)?.scrollTop ?? -1)) };
  }
  console.log("PDF02 " + JSON.stringify(out, null, 2));
});
