// Large-workspace (slim mode) performance after the GAP-249 / offline-copy
// changes: cold start, background download, warm reload, note open online
// and offline, JS heap. Chromium only (performance.memory).
import { test } from "@playwright/test";
import { ready, BASE } from "../fullstack/helpers";

test("large workspace performance", async ({ page, context }) => {
  test.setTimeout(400_000);
  const out: Record<string, unknown> = {};
  const heap = async () => Math.round(await page.evaluate(() => ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1048576));
  const gc = async () => { const s = await context.newCDPSession(page); await s.send("HeapProfiler.collectGarbage"); await s.detach(); };
  let bytes = 0, syncReqs = 0, bodyReqs = 0, lastBody = 0; const t0 = Date.now();
  page.on("response", async (r) => { if (!r.url().includes("/api/")) return; const b = (await r.body().catch(() => Buffer.alloc(0))).length; bytes += b;
    if (r.url().endsWith("/api/sync") && r.request().method() === "POST") syncReqs++; if (r.url().endsWith("/api/sync/bodies")) { bodyReqs++; lastBody = Date.now(); } });
  // 1. Cold start (fresh profile).
  await ready(page, "/?view=notes");
  out.coldShellMs = Date.now() - t0;
  await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  await page.waitForFunction(() => !!document.querySelector(".cm-content") || document.body.innerText.includes("Notes"), undefined, { timeout: 90_000 });
  out.coldUsableMs = Date.now() - t0;
  out.coldApiMB = +(bytes / 1048576).toFixed(2); out.coldSyncRequests = syncReqs;
  await page.waitForTimeout(1500);
  while (Date.now() - lastBody < 5000) await page.waitForTimeout(1000);
  out.download = { requests: bodyReqs, finishedAfterMs: lastBody ? lastBody - t0 : null, totalApiMB: +(bytes / 1048576).toFixed(2) };
  await gc(); out.heapAfterDownloadMB = await heap();
  out.nodes = await page.evaluate(async () => (await (await fetch("/api/bootstrap?bodies=none", { credentials: "include" })).json()).nodes.length);
  // 2. Open notes online (slim rows → hydrate).
  const ids: string[] = await page.evaluate(async () => (await (await fetch("/api/bootstrap?bodies=none", { credentials: "include" })).json()).nodes.filter((n: { node_type: string; body_len?: number }) => n.node_type === "content" && (n.body_len ?? 0) > 0).slice(200, 210).map((n: { id: string }) => n.id));
  const openTimes: number[] = [];
  for (const id of ids.slice(0, 5)) {
    const s = Date.now();
    await page.evaluate((nid) => { history.pushState(null, "", `/?view=notes&node=${nid}`); window.dispatchEvent(new PopStateEvent("popstate")); }, id);
    const ok = await page.waitForFunction((nid) => location.search.includes(nid) && (document.querySelector(".cm-content")?.textContent ?? "").length > 0 && !document.querySelector(".lazy-loading-pane"), id, { timeout: 15_000 }).then(() => true).catch(() => false);
    openTimes.push(ok ? Date.now() - s : -1);
  }
  out.openOnlineMs = openTimes;
  // 3. Open notes offline (stored bodies).
  await context.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  const offTimes: number[] = [];
  for (const id of ids.slice(5, 10)) {
    const s = Date.now();
    await page.evaluate((nid) => { history.pushState(null, "", `/?view=notes&node=${nid}`); window.dispatchEvent(new PopStateEvent("popstate")); }, id);
    const ok = await page.waitForFunction((nid) => location.search.includes(nid) && (document.querySelector(".cm-content")?.textContent ?? "").length > 0 && !document.querySelector(".lazy-loading-pane, .lazy-offline-pane"), id, { timeout: 15_000 }).then(() => true).catch(() => false);
    offTimes.push(ok ? Date.now() - s : -1);
  }
  out.openOfflineMs = offTimes;
  await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(3000);
  // 4. Warm reload (local copy exists).
  bytes = 0; syncReqs = 0; bodyReqs = 0;
  const t1 = Date.now();
  const warmId = ids[0]!;
  await page.goto(`${BASE}/?view=notes&node=${warmId}`);
  await page.waitForFunction(() => (document.querySelector(".cm-content")?.textContent ?? "").length > 0 && !document.querySelector(".membership-gate, .lazy-loading-pane"), undefined, { timeout: 90_000 });
  out.warmUsableMs = Date.now() - t1;
  await page.waitForTimeout(3000);
  out.warmApiMB = +(bytes / 1048576).toFixed(2); out.warmSyncRequests = syncReqs; out.warmBodyRequests = bodyReqs;
  await gc(); out.heapWarmMB = await heap();
  console.log("PERFLARGE " + JSON.stringify(out, null, 2));
});
