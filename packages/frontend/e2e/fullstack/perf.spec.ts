import { test, expect } from "@playwright/test";
import { H } from "./helpers";

// Performance smoke — measures the key latencies against the wired stack and
// guards GENEROUS budgets (catch gross regressions, not micro-jitter). Numbers
// are printed; thresholds are deliberately loose for a single-box docker stack.
const ms = (label: string, v: number) => console.log(`   ⏱  ${label}: ${Math.round(v)} ms`);

test.describe("performance", () => {
  test("cold app load is within budget", async ({ page }) => {
    const t0 = Date.now();
    await page.goto("/?view=notes", { waitUntil: "load" });
    const wall = Date.now() - t0;
    const nav = await page.evaluate(() => {
      const e = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      return e ? { dcl: e.domContentLoadedEventEnd, load: e.loadEventEnd, resp: e.responseEnd } : null;
    });
    ms("goto wall", wall);
    if (nav) { ms("responseEnd", nav.resp); ms("DOMContentLoaded", nav.dcl); ms("load", nav.load); }
    await expect(page.locator(".view-tabs [role=tab]").first()).toBeVisible();
    expect(wall).toBeLessThan(12_000);
  });

  test("bootstrap + node-create API latency", async ({ page }) => {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = Date.now();
      const r = await page.request.get("/api/bootstrap");
      expect(r.ok()).toBeTruthy();
      samples.push(Date.now() - t);
    }
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    ms("bootstrap avg (5x)", avg);
    expect(avg).toBeLessThan(3000);

    const tc = Date.now();
    const c = await page.request.post("/api/nodes", { ...H, data: { title: "perf node", markdown: "x" } });
    const dt = Date.now() - tc;
    expect(c.status()).toBe(201);
    ms("node create", dt);
    expect(dt).toBeLessThan(2500);
  });

  test("lens-switch interaction latency", async ({ page }) => {
    const parent = await (await page.request.post("/api/nodes", { ...H, data: { title: `Perf parent ${Date.now()}`, markdown: "p" } })).json();
    await page.request.post("/api/nodes", { ...H, data: { title: `Perf child ${Date.now()}`, markdown: "c", parent_id: parent.id } });
    // The whiteboard is a view tab the note has (added from the tab row's ＋, docs/architecture/canvas-as-view.md);
    // having children no longer earns one (same as soak.spec.ts), so give the note that tab.
    const view = await page.request.post(`/api/nodes/${parent.id}/views`, { ...H, data: { name: "Canvas", layout: "canvas", visible_fields: [] } });
    expect(view.ok(), await view.text()).toBeTruthy();
    await page.goto(`/?view=notes&node=${parent.id}`, { waitUntil: "load" });
    const tab = page.locator('.view-tabs [role=tab]:has-text("Canvas")');
    await tab.waitFor();
    const t = Date.now();
    await tab.click();
    await expect(page).toHaveURL(/lens=canvas/);
    const dt = Date.now() - t;
    ms("lens switch (click → URL)", dt);
    expect(dt).toBeLessThan(2500);
  });

  // True simultaneous write burst — the regression guard for the pg-pool
  // deadlock. Before withTransaction was made reentrant, each create held one
  // pool connection inside its mutate() transaction and then called syncBlockIds
  // (→ a nested withTransaction → a SECOND connection), so a burst wider than
  // half the pool deadlocked and the backend wedged forever (no connection
  // timeout). N here deliberately exceeds the pool max (20), so passing proves
  // the requests QUEUE and DRAIN rather than deadlock.
  test("survives a simultaneous write burst (no pool deadlock)", async ({ page }) => {
    const N = 50;
    const t = Date.now();
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        page.request
          .post("/api/nodes", { ...H, data: { title: `burst ${Date.now()}-${i}`, markdown: `b${i} body` } })
          .then((r) => r.status())
          .catch(() => 0)),
    );
    const ok = results.filter((s) => s === 201).length;
    const dt = Date.now() - t;
    ms(`burst of ${N} simultaneous creates → ${ok} ok`, dt);
    expect(ok).toBe(N);          // every write lands — none time out or wedge
    expect(dt).toBeLessThan(20_000);
  });

  test("bootstrap stays responsive after creating 50 nodes", async ({ page }) => {
    // Scale test: does the app stay fast with MORE DATA? Bounded concurrency
    // here keeps it about data volume, not the burst path (covered above).
    const N = 50, CONC = 8;
    let ok = 0;
    const tCreate = Date.now();
    for (let start = 0; start < N; start += CONC) {
      const batch = Array.from({ length: Math.min(CONC, N - start) }, (_, j) => {
        const i = start + j;
        return page.request
          .post("/api/nodes", { ...H, data: { title: `bulk ${Date.now()}-${i}`, markdown: `bulk body ${i}` } })
          .then((r) => r.status()).catch(() => 0);
      });
      ok += (await Promise.all(batch)).filter((s) => s === 201).length;
    }
    ms(`created ${ok}/${N} nodes (concurrency ${CONC})`, Date.now() - tCreate);
    expect(ok).toBeGreaterThanOrEqual(N * 0.9);

    const t = Date.now();
    const r = await page.request.get("/api/bootstrap");
    expect(r.ok()).toBeTruthy();
    const dt = Date.now() - t;
    ms("bootstrap after +50 nodes", dt);
    expect(dt).toBeLessThan(5000);
  });
});
