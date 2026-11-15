// CAN-06 follow-up (2026-10-08): task checkbox in a card preview, and web
// embed cards for odd / unsafe URLs (cards located by data-id).
import { test } from "@playwright/test";
import { ready, seedLayout, H } from "../fullstack/helpers";


test("CAN-06b: card task toggle and embeds", async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const mk = async (title: string, markdown: string) => (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown } })).json()).id as string;
  const body = async (id: string) => (await (await page.request.get(`/api/nodes/${id}`)).json()).markdown as string;
  const T = await mk(`CTask ${stamp}`, "- [ ] one\n- [ ] two");
  const urls = ["javascript:alert(1)", "http://example.invalid/page", "data:text/html,<b>x</b>", "https://example.com/a b", "https://example.com/ok"];
  const W = await Promise.all(urls.map((u, i) => mk(`W${i} ${stamp}`, u)));
  const cv = await (await page.request.post("/api/canvases", { ...H, data: { title: `C06b ${stamp}` } })).json();
  await seedLayout(page.request, cv.id, { ...H, data: { data: { nodes: [T, ...W].map((id, i) => ({ nodeId: id, x: 40 + (i % 3) * 320, y: 40 + Math.floor(i / 3) * 300, width: 280 })) } } });
  await ready(page, `/?view=notes&node=${cv.id}`);
  await page.locator(".react-flow__node").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  const card = page.locator(`.react-flow__node[data-id="${T}"]`);
  const box = card.locator("[role=checkbox], input[type=checkbox]").first();
  out.boxInfo = await box.evaluate((b) => ({ tag: b.tagName, role: b.getAttribute("role"), cls: b.className, checked: b.getAttribute("aria-checked") ?? (b as HTMLInputElement).checked })).catch(() => null);
  await box.click();
  await page.waitForTimeout(3000);
  out.afterClick1 = { server: await body(T), aria: await box.getAttribute("aria-checked").catch(() => null) };
  await box.click();
  await page.waitForTimeout(3000);
  out.afterClick2 = { server: await body(T), aria: await box.getAttribute("aria-checked").catch(() => null) };
  out.embeds = await Promise.all(W.map(async (id, i) => {
    const n = page.locator(`.react-flow__node[data-id="${id}"]`);
    return n.evaluate((el, u) => ({ url: u, embed: !!el.querySelector(".card-node-webembed"), iframe: el.querySelector("iframe")?.getAttribute("src") ?? null, sandbox: el.querySelector("iframe")?.getAttribute("sandbox") ?? null, links: Array.from(el.querySelectorAll("a")).map((a) => a.getAttribute("href")) }), urls[i]).catch(() => ({ url: urls[i], missing: true }));
  }));
  console.log("CAN06B " + JSON.stringify(out, null, 2));
});
