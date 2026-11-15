// Feature-audit deepening (2026-10-09, tick 49): PER-04 — duplicate / stale
// sync deltas. Capture the sync response that delivered title T2, let T3
// arrive normally, then answer the next sync with the captured T2 response
// again (a retried / out-of-order delivery). Does the list regress to T2, does
// the cursor move backwards, and does it heal?
import { test, type Route } from "@playwright/test";
import { ready, H } from "../fullstack/helpers";


test("PER-04: stale delta replayed after a newer one", async ({ page }) => {
  test.setTimeout(240_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  // A sibling note stays open in the editor; the target is watched in the list.
  const target = await (await req.post("/api/nodes", { ...H, data: { title: `P04 T1 ${s}`, markdown: "x" } })).json();
  const other = await (await req.post("/api/nodes", { ...H, data: { title: `P04 other ${s}`, markdown: "y" } })).json();
  let captured: { body: string; reqSince: string } | null = null;
  const sinces: string[] = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/sync") && r.method() === "POST") sinces.push((r.postData() ?? "").slice(0, 40)); });
  page.on("response", async (r) => { if (!captured && r.url().endsWith("/api/sync") && r.request().method() === "POST") { const t = await r.text().catch(() => ""); if (t.includes(`P04 T2 ${s}`)) captured = { body: t, reqSince: r.request().postData() ?? "" }; } });
  const listed = async (t: string) => (await page.getByText(t, { exact: true }).count()) > 0;
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await ready(page, `/?view=notes&node=${other.id}`);
    await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(3000);
    await req.patch(`/api/nodes/${target.id}`, { ...H, data: { title: `P04 T2 ${s}` } });
    for (let i = 0; i < 40 && !captured; i++) await page.waitForTimeout(500);
    out.capturedT2 = !!captured;
    await req.patch(`/api/nodes/${target.id}`, { ...H, data: { title: `P04 T3 ${s}` } });
    await page.waitForTimeout(6000);
    out.beforeReplay = { T3: await listed(`P04 T3 ${s}`), T2: await listed(`P04 T2 ${s}`) };
    // Replay the old T2 response for the next sync request.
    let replayed = 0;
    await page.route("**/api/sync", async (r: Route) => { if (r.request().method() === "POST" && captured && replayed === 0) { replayed++; return r.fulfill({ status: 200, contentType: "application/json", body: captured.body }); } return r.continue(); });
    await req.patch(`/api/nodes/${other.id}`, { ...H, data: { title: `P04 other2 ${s}` } }); // trigger a sync
    await page.waitForTimeout(4000);
    out.afterReplay = { replayed, T3: await listed(`P04 T3 ${s}`), T2: await listed(`P04 T2 ${s}`) };
    await page.unroute("**/api/sync");
    await req.patch(`/api/nodes/${other.id}`, { ...H, data: { title: `P04 other3 ${s}` } }); // another sync
    await page.waitForTimeout(6000);
    out.afterHeal = { T3: await listed(`P04 T3 ${s}`), T2: await listed(`P04 T2 ${s}`) };
    await page.reload(); await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(4000);
    out.afterReload = { T3: await listed(`P04 T3 ${s}`), T2: await listed(`P04 T2 ${s}`) };
    out.sinces = sinces.slice(-8);
  } finally {
    await page.unroute("**/api/sync").catch(() => {});
    for (const n of [target, other]) await req.delete(`/api/nodes/${n.id}`, H).catch(() => {});
    console.log("PER04B " + JSON.stringify(out, null, 2));
  }
});
