// Feature-audit deepening (2026-10-08): RSS-06 — highlight → quote card from
// the reader (double-click a paragraph): normal path (card under the saved
// article + highlight_source edge), edge refused then retried (duplicate
// card?), card create refused (phantom card?), card create 503 then replay.
import { test, expect, type Page } from "@playwright/test";
import { ready, H } from "./helpers";

type Item = { id: string; title: string; saved_node_id?: string | null };

// Superseded: quote cards were replaced by 「引用到筆記」 (append to a note,
// feat/rss-quote-write); its offline/undo paths are unit-tested in
// modules/rss/rssQuote.test.tsx. Kept as the audit record.
test.skip(true, "quote cards were replaced by 引用到筆記");
test("RSS-06: quote cards with partial failures", async ({ page, context }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  for (let i = 0; i < 4; i++) {
    const node = await (await page.request.post("/api/nodes", { ...H, data: { title: `R6 art ${i} (${stamp})`, markdown: `Quotable paragraph number ${i} for ${stamp}.` } })).json();
    await page.request.put(`/api/nodes/${node.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
  }
  const sub = await (await page.request.post("/api/rss/subscribe", { ...H, data: { url: `http://nginx/site/feed.xml?run=${stamp}` } })).json();
  await page.request.post(`/api/rss/sources/${sub.id}/refresh`, { ...H, data: {} });
  const items = async (): Promise<Item[]> => (((await (await page.request.get("/api/rss/items?limit=200")).json()).items ?? []) as Item[]).filter((i) => i.title.includes(`(${stamp})`));
  await expect.poll(async () => (await items()).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
  const its = (await items()).sort((a, b) => a.title.localeCompare(b.title));
  const boot = async () => await (await page.request.get("/api/bootstrap?slim=1")).json() as { nodes: Array<{ id: string; title: string; parent_id?: string | null }>; edges: Array<{ source_node_id: string; target_node_id: string; edge_type: string }> };
  const cards = async (n: number) => { const b = await boot(); const cs = b.nodes.filter((x) => x.title.startsWith(`Quotable paragraph number ${n} for ${stamp}`)); return cs.map((c) => ({ parentIsArticle: !!b.nodes.find((p) => p.id === c.parent_id && p.title === its[n].title), edge: b.edges.some((e) => e.source_node_id === c.id && e.edge_type === "highlight_source") })); };
  const open = async (p: Page, title: string) => { await ready(p, "/?view=rss"); await p.waitForTimeout(1500); const min = p.getByRole("button", { name: "Minimize recovery panel" }); if (await min.isVisible().catch(() => false)) await min.click(); await p.locator(".rss-item-list button", { hasText: title }).first().click(); await p.waitForTimeout(1200); };
  const quoteIt = async (n: number) => { await page.locator(".rss-right p", { hasText: `Quotable paragraph number ${n}` }).first().dblclick(); await page.waitForTimeout(300); const btn = page.getByRole("button", { name: "Save highlight as card" }); const shown = await btn.isVisible().catch(() => false); if (shown) await btn.click(); await page.waitForTimeout(2000); return shown; };
  const notice = async () => ((await page.locator(".rss-right").innerText().catch(() => "")).match(/Quote saved[^\n]*|Could not[^\n]*|permission[^\n]*/i)?.[0]?.slice(0, 100) ?? "") + " | toasts: " + (await page.locator(".toast").allInnerTexts()).join(" ").replace(/\s+/g, " ").slice(-80);
  try {
  await open(page, its[0].title);
  out.normal = { bar: await quoteIt(0), notice: await notice(), cards: await cards(0) };
  // Edge refused, then press again.
  await open(page, its[1].title);
  await page.route("**/api/edges", (r) => r.request().method() === "POST" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  out.edge403 = { bar: await quoteIt(1), notice: await notice(), quoteBarStill: await page.getByRole("button", { name: "Save highlight as card" }).isVisible().catch(() => false) };
  await page.unroute("**/api/edges");
  if (await page.getByRole("button", { name: "Save highlight as card" }).isVisible().catch(() => false)) { await page.getByRole("button", { name: "Save highlight as card" }).click(); await page.waitForTimeout(2000); }
  out.edge403AfterRetry = await cards(1);
  // Card create refused.
  await open(page, its[2].title);
  await page.route("**/api/nodes", (r) => r.request().method() === "POST" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  out.card403 = { bar: await quoteIt(2), notice: await notice(), server: await cards(2), sidebarPhantom: await page.locator(".obsidian-page-button", { hasText: `Quotable paragraph number 2 for ${stamp}` }).count() };
  await page.unroute("**/api/nodes");
  // Card create 503 → queued → replay.
  await open(page, its[3].title);
  await page.route("**/api/nodes", (r) => r.request().method() === "POST" ? r.fulfill({ status: 503, body: "{}" }) : r.continue());
  out.card503 = { bar: await quoteIt(3), notice: await notice() };
  await page.unroute("**/api/nodes");
  await context.setOffline(true); await page.waitForTimeout(800); await context.setOffline(false);
  await page.waitForTimeout(8000);
  out.card503Replay = await cards(3);
  } finally {
    await context.setOffline(false).catch(() => {});
    console.log("RSS06 " + JSON.stringify(out, null, 2));
  }
});
