// GAP-249 fix check: order of bootstrap vs first sync on a fresh profile, and the cursor each carries.
import { test } from "@playwright/test";
import { ready } from "../fullstack/helpers";
test("cold start cursor order", async ({ page }) => {
  test.setTimeout(180_000);
  const log: string[] = []; const t0 = Date.now();
  page.on("request", (r) => { const u = r.url(); if (/\/api\/(bootstrap|sync)/.test(u)) log.push(`${Date.now() - t0}ms REQ ${r.method()} ${u.replace(/^https?:\/\/[^/]+/, "")} ${(r.postData() ?? "").slice(0, 60)}`); });
  page.on("response", async (r) => { const u = r.url(); if (/\/api\/bootstrap/.test(u)) { const j = await r.json().catch(() => ({})); log.push(`${Date.now() - t0}ms RES bootstrap last_event_id=${j.last_event_id} nodes=${j.nodes?.length}`); } });
  page.on("console", (m) => { if (/cursor|last_event/i.test(m.text())) log.push(`console ${m.text().slice(0, 120)}`); });
  await ready(page, "/?view=notes");
  await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  await page.waitForTimeout(5000);
  const b = await (await page.request.get("/api/bootstrap?bodies=none")).json();
  log.push(`API bootstrap last_event_id=${b.last_event_id} nodes=${b.nodes.length}`);
  console.log("ORDER\n" + log.slice(0, 25).join("\n"));
});
