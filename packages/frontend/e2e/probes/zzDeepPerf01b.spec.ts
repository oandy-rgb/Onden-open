// Feature-audit deepening (2026-10-08): PERF-01 follow-up — is the heap and
// listener growth seen over 30 note switches a leak? Four rounds of 45
// switches among the same 15 notes, measured after a forced GC each round.
import { test } from "@playwright/test";
import { BASE } from "../fullstack/helpers";


test("PERF-01b: heap/listeners across repeated note switches", async ({ browser }) => {
  test.setTimeout(600_000);
  const ctx = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json", viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("Performance.enable");
  const measure = async () => {
    await cdp.send("HeapProfiler.collectGarbage"); await p.waitForTimeout(300); await cdp.send("HeapProfiler.collectGarbage");
    const m = (await cdp.send("Performance.getMetrics")).metrics; const v = (k: string) => m.find((x) => x.name === k)?.value ?? 0;
    return { heapMB: Math.round(v("JSHeapUsedSize") / 1e5) / 10, nodes: v("Nodes"), listeners: v("JSEventListeners"), docs: v("Documents"), frames: v("Frames") };
  };
  await p.goto("/?view=notes", { waitUntil: "load" });
  await p.locator(".obsidian-page-button").first().waitFor({ timeout: 60_000 });
  const gate = p.getByText("Checking your workspace", { exact: false });
  for (let i = 0; i < 120 && await gate.isVisible().catch(() => false); i++) await p.waitForTimeout(250);
  await p.waitForTimeout(2000);
  const rows = p.locator(".obsidian-page-button");
  const rounds: unknown[] = [{ round: 0, ...(await measure()) }];
  for (let r = 1; r <= 4; r++) {
    const t0 = Date.now();
    for (let i = 0; i < 45; i++) {
      await rows.nth(i % 15).click().catch(() => {});
      await p.waitForTimeout(120);
    }
    await p.waitForTimeout(1500);
    rounds.push({ round: r, ms: Date.now() - t0, ...(await measure()) });
  }
  // Which listener targets grow? Count listeners on window/document via CDP.
  const { result } = await cdp.send("Runtime.evaluate", { expression: "window" });
  const winL = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId! });
  const { result: d } = await cdp.send("Runtime.evaluate", { expression: "document" });
  const docL = await cdp.send("DOMDebugger.getEventListeners", { objectId: d.objectId! });
  const tally = (ls: Array<{ type: string }>) => Object.entries(ls.reduce((a: Record<string, number>, l) => { a[l.type] = (a[l.type] ?? 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log("PERF01B " + JSON.stringify({ rounds, windowListeners: tally(winL.listeners), documentListeners: tally(docL.listeners) }, null, 2));
  await ctx.close();
});
