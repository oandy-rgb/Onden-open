import { test } from "@playwright/test";
import { ready, openSidebarSearch, H } from "./helpers";

// SCALE PROBE (PROBE_SCALE=1, ad hoc, SLOW): the #4 measurement gate.
// Seeds synthetic-but-realistic notes in tiers, then measures what a user
// actually feels: bootstrap payload + latency, time-to-interactive, JS heap,
// and interaction latency (sidebar, search keystroke, node switch).
// Bootstrap-slimming work proceeds ONLY if these numbers say so.
//
// Run:  PROBE_SCALE=1 [SCALE_TIERS=1000,5000,20000] playwright test scaleProbe
const TIERS = (process.env.SCALE_TIERS ?? "1000,5000,20000").split(",").map((n) => parseInt(n, 10));

// ~1.2KB of realistic markdown per note: headings, a list, a wikilink, tags.
function noteBody(i: number, linkTo: string): string {
  return [
    `# 筆記 ${i}`,
    "",
    `這是第 ${i} 篇合成筆記，模擬真實的段落長度與結構。記錄一些想法、觀察與待辦事項，足夠讓 payload 接近實際使用。`,
    "",
    "## 重點",
    "",
    `- 第一個重點，帶一點內文 ${i % 97}`,
    `- 第二個重點，連到 [[${linkTo}]]`,
    "- 第三個重點 #scale" + (i % 23),
    "",
    "## 細節",
    "",
    "細節段落。".repeat(30),
    "",
    `結尾段落，編號 ${i}。#probe`,
  ].join("\n");
}

test("scale probe: bootstrap + interaction latency per tier", async ({ page }) => {
  test.skip(!process.env.PROBE_SCALE, "slow measurement probe — PROBE_SCALE=1 on a fresh stack");
  test.setTimeout(3_600_000);

  const report: Array<Record<string, string | number>> = [];
  let seeded = 0;
  let lastTitle = "起點筆記";
  await page.request.post("/api/nodes", { ...H, data: { title: lastTitle, markdown: "# 起點\n\nroot." } });
  seeded++;

  for (const tier of TIERS) {
    // ── Seed up to `tier` notes with bounded concurrency ──
    const toCreate = tier - seeded;
    const CONC = 16;
    const t0 = Date.now();
    let created = 0;
    for (let batch = 0; batch < Math.ceil(toCreate / CONC); batch++) {
      const jobs: Promise<unknown>[] = [];
      for (let k = 0; k < CONC && created + k < toCreate; k++) {
        const i = seeded + created + k;
        jobs.push(page.request.post("/api/nodes", {
          ...H,
          data: { title: `筆記 ${i}`, markdown: noteBody(i, lastTitle) },
        }).then((r) => { if (!r.ok()) throw new Error(`seed failed: ${r.status()}`); }));
      }
      await Promise.all(jobs);
      created += jobs.length;
      if (created % 1000 < CONC) console.log(`SEED| tier=${tier} ${seeded + created}/${tier} (${Math.round((Date.now() - t0) / 1000)}s)`);
      lastTitle = `筆記 ${seeded + created - 1}`;
    }
    seeded += created;
    console.log(`SEED| tier ${tier} ready in ${Math.round((Date.now() - t0) / 1000)}s`);

    // ── Measure: raw bootstrap (server + payload) ──
    const bt0 = Date.now();
    const bres = await page.request.get("/api/bootstrap");
    const bMs = Date.now() - bt0;
    const bBytes = (await bres.body()).length;

    // ── Measure: app TTI (fresh load → today note interactive) ──
    const lt0 = Date.now();
    await ready(page, "/?view=notes");
    await page.locator(".obsidian-title-input, .cm-content").first().waitFor({ timeout: 120_000 });
    const ttiMs = Date.now() - lt0;

    const heapMb = await page.evaluate(() =>
      // Chrome-only; fine for a probe.
      Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1048576),
    );

    // ── Measure: interaction latency ──
    // Search keystroke → results painted.
    const search = await openSidebarSearch(page);
    const st0 = Date.now();
    await search.fill(`筆記 ${Math.floor(tier / 2)}`);
    await page.locator(".obsidian-search-count, .obsidian-search-row, .sb-item-title").first().waitFor({ timeout: 60_000 }).catch(() => {});
    const searchMs = Date.now() - st0;
    await search.fill("");

    // Node switch: click two sidebar rows, time the editor swap.
    const rows = page.locator(".obsidian-page-row .obsidian-page-button");
    const rowCount = await rows.count();
    let switchMs = -1;
    if (rowCount >= 2) {
      await rows.nth(0).click();
      // DELIBERATE waitForTimeout: measurement isolation, not a condition wait —
      // let the FIRST switch fully settle so the timed second switch below
      // starts from an idle frame (any leftover work would pollute switchMs).
      await page.waitForTimeout(300);
      const wt0 = Date.now();
      await rows.nth(1).click();
      await page.locator(".cm-content").first().waitFor({ timeout: 60_000 });
      switchMs = Date.now() - wt0;
    }

    const row = {
      tier,
      bootstrap_ms: bMs,
      bootstrap_mb: Math.round((bBytes / 1048576) * 100) / 100,
      tti_ms: ttiMs,
      heap_mb: heapMb,
      search_ms: searchMs,
      node_switch_ms: switchMs,
      sidebar_rows: rowCount,
    };
    report.push(row);
    console.log("TIER_RESULT| " + JSON.stringify(row));
  }

  console.log("SCALE_REPORT| " + JSON.stringify(report));
});
