// Feature-audit deepening (2026-10-08): PERF-01 — the e2e workspace as a fixed
// data set (≈2,000 notes, largest ≈155 KB) measured for cold and warm load,
// opening/typing/previewing the largest note, sidebar and palette search, a
// note with 500 sub-notes (its 「Sub-notes」 section — the children Table lens
// was removed in #486), a large image, the graph view, and JS heap growth over
// 30 in-app note switches. Long tasks and slow input events are summed per
// step so a slow step can be told apart from a functional failure.
import { test, type Page, type CDPSession } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { psql as sql, ready, switchNoteView, BASE, H, sidebarSearch } from "../fullstack/helpers";


const OBSERVE = () => {
  const w = window as unknown as { __lt: { n: number; ms: number }; __ev: number[] };
  w.__lt = { n: 0, ms: 0 }; w.__ev = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { w.__lt.n++; w.__lt.ms += e.duration; } }).observe({ type: "longtask", buffered: true }); } catch { /* */ }
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (/key|input|click|pointer/.test(e.name)) w.__ev.push(Math.round(e.duration)); }).observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit); } catch { /* */ }
};
const resetObs = (p: Page) => p.evaluate(() => { const w = window as unknown as { __lt: { n: number; ms: number }; __ev: number[] }; w.__lt = { n: 0, ms: 0 }; w.__ev = []; });
const readObs = (p: Page) => p.evaluate(() => { const w = window as unknown as { __lt: { n: number; ms: number }; __ev: number[] }; const ev = [...w.__ev].sort((a, b) => a - b); return { longTasks: w.__lt.n, longTaskMs: Math.round(w.__lt.ms), slowEvents: ev.length, eventMax: ev.at(-1) ?? 0, eventP95: ev[Math.floor(ev.length * 0.95)] ?? 0 }; });
async function heapMB(cdp: CDPSession, gc = true) {
  if (gc) await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  const m = (await cdp.send("Performance.getMetrics")).metrics;
  const v = (k: string) => m.find((x) => x.name === k)?.value ?? 0;
  return { heapMB: Math.round(v("JSHeapUsedSize") / 1e5) / 10, nodes: v("Nodes"), listeners: v("JSEventListeners") };
}

test("PERF-01: fixed data set — load, large note, search, big table, image, graph, heap", async ({ page, browser }, testInfo) => {
  test.setTimeout(1_200_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  out.dataset = sql("select count(*)||' live notes, '||pg_size_pretty(sum(length(markdown))::bigint)||' text, largest '||max(length(markdown))||' chars' from content_nodes where deleted_at is null");
  out.edges = sql("select count(*) from node_edges");
  const step = async (name: string, fn: () => Promise<void>) => { try { await fn(); } catch (e) { out[name] = `ERR ${String(e).split("\n")[0].slice(0, 200)}`; } };
  // Seed: a copy of the largest note, a 500-child parent, a big image note.
  const big = JSON.parse(sql("select json_build_object('md', markdown) from content_nodes where deleted_at is null order by length(markdown) desc limit 1")).md as string;
  const mk = async (title: string, markdown: string, parent?: string) => (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown, ...(parent ? { parent_id: parent } : {}) } })).json()) as { id: string; slug: string };
  const bigNote = await mk(`PerfBig ${stamp}`, big);
  const parent = await mk(`PerfTable ${stamp}`, "500 children");
  const t0 = Date.now();
  for (let i = 0; i < 500; i += 25) await Promise.all(Array.from({ length: 25 }, (_, k) => mk(`PerfRow ${String(i + k).padStart(3, "0")} ${stamp}`, `row ${i + k}`, parent.id)));
  out.seed500ms = Date.now() - t0;

  const ctx = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json", viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(OBSERVE);
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("Performance.enable");
  const boot: Array<{ url: string; ms: number; kb: number }> = [];
  p.on("requestfinished", async (r) => {
    if (!/\/api\/(bootstrap|sync|nodes\?|search)/.test(r.url())) return;
    const t = r.timing(); const body = await (await r.response())?.body().catch(() => null);
    boot.push({ url: r.url().replace(BASE, "").slice(0, 60), ms: Math.round(t.responseEnd), kb: body ? Math.round(body.length / 1024) : -1 });
  });
  const gate = p.getByText("Checking your workspace", { exact: false });
  const loadOnce = async (label: string) => {
    const s = Date.now();
    await p.goto("/?view=notes", { waitUntil: "load" });
    const opfs = p.getByText("Use browser storage", { exact: false }).first();
    const shell = p.locator(".app-topbar nav").first();
    await shell.or(opfs).waitFor({ timeout: 60_000 });
    if (await opfs.isVisible().catch(() => false)) await opfs.click();
    await shell.waitFor({ timeout: 60_000 });
    const tShell = Date.now() - s;
    await p.locator(".obsidian-page-button").first().waitFor({ timeout: 60_000 });
    const tRows = Date.now() - s;
    for (let i = 0; i < 240 && await gate.isVisible().catch(() => false); i++) await p.waitForTimeout(250);
    const tSettled = Date.now() - s;
    out[label] = { tShell, tRows, tSettled, ...(await readObs(p)), ...(await heapMB(cdp)) };
  };
  try {
    await step("coldLoad", () => loadOnce("coldLoad"));
    out.coldRequests = boot.splice(0);
    await p.waitForTimeout(3000);
    await step("warmLoad", () => loadOnce("warmLoad"));
    out.warmRequests = boot.splice(0);

    await step("bigNote", async () => {
      await resetObs(p);
      const s = Date.now();
      await p.goto(`/?view=notes&node=${bigNote.id}`, { waitUntil: "load" });
      await p.locator(".cm-content").first().waitFor({ timeout: 60_000 });
      await p.locator(".cm-line").nth(3).waitFor({ timeout: 60_000 });
      const tOpen = Date.now() - s;
      await p.locator(".cm-content").first().click();
      await p.keyboard.press("Control+End");
      await resetObs(p);
      const k = Date.now();
      await p.keyboard.type("perf typing probe 0123456789 abcdefghij", { delay: 30 });
      const tType = Date.now() - k - 40 * 30;
      const typing = await readObs(p);
      await resetObs(p);
      const v = Date.now();
      await switchNoteView(p, "preview");
      await p.locator(".obsidian-preview").first().waitFor({ timeout: 60_000 });
      await p.waitForFunction(() => (document.querySelector(".obsidian-preview")?.textContent ?? "").length > 1000, null, { timeout: 60_000 });
      const tPreview = Date.now() - v;
      out.bigNote = { chars: big.length, tOpen, tTypeOverhead40keys: tType, typing, tPreview, preview: await readObs(p), ...(await heapMB(cdp)) };
      await switchNoteView(p, "edit").catch(() => {});
    });

    await step("search", async () => {
      await p.goto("/?view=notes", { waitUntil: "load" });
      await p.locator(".obsidian-page-button").first().waitFor({ timeout: 60_000 });
      await resetObs(p);
      const input = sidebarSearch(p);
      if (!(await input.isVisible().catch(() => false))) await p.locator(".sidebar-search-toggle").filter({ visible: true }).click();
      await input.waitFor({ timeout: 10_000 });
      const s = Date.now();
      await input.fill(`PerfRow 499 ${stamp}`);
      await p.locator(".obsidian-page-button", { hasText: `PerfRow 499 ${stamp}` }).first().waitFor({ timeout: 30_000 }).catch(() => {});
      const tSidebar = Date.now() - s;
      const sidebarObs = await readObs(p);
      await p.keyboard.press("Escape");
      await resetObs(p);
      await p.keyboard.press("Control+k");
      await p.locator(".palette-input-wrap input").waitFor({ timeout: 10_000 });
      const q = Date.now();
      await p.locator(".palette-input-wrap input").fill("Paragraph 2999");
      await p.locator("[role='dialog']").getByText(/Paragraph 2999|MdLong/).first().waitFor({ timeout: 30_000 }).catch(() => {});
      const tPalette = Date.now() - q;
      const paletteHits = (await p.locator("[role='dialog'] [role='option'], [role='dialog'] li, [role='dialog'] button").count());
      await p.keyboard.press("Escape");
      const a = Date.now();
      const api = await p.request.get(`/api/search?q=${encodeURIComponent("Paragraph")}`);
      const tApi = Date.now() - a;
      out.search = { tSidebar, sidebarObs, tPalette, paletteHits, palette: await readObs(p), api: { status: api.status(), ms: tApi, kb: Math.round((await api.body()).length / 1024) } };
    });

    await step("table500", async () => {
      await resetObs(p);
      const s = Date.now();
      await p.goto(`/?view=notes&node=${parent.id}`, { waitUntil: "load" });
      const rows = p.locator(".note-relations-children");
      const row = rows.getByText(`PerfRow 000 ${stamp}`).first();
      await row.waitFor({ timeout: 60_000 });
      const tFirst = Date.now() - s;
      const rendered = await rows.getByText(new RegExp(`PerfRow \\d{3} ${stamp}`)).count();
      const sc = Date.now();
      for (let i = 0; i < 80; i++) {
        await p.mouse.move(800, 600); await p.mouse.wheel(0, 1500);
        if (await rows.getByText(`PerfRow 499 ${stamp}`).first().isVisible().catch(() => false)) break;
      }
      const reachedEnd = await rows.getByText(`PerfRow 499 ${stamp}`).first().isVisible().catch(() => false);
      out.table500 = { tFirst, rowsInDom: rendered, tScrollEnd: Date.now() - sc, reachedEnd, ...(await readObs(p)), ...(await heapMB(cdp)) };
    });

    await step("bigImage", async () => {
      // A 4000×4000 noisy PNG made in the browser.
      const b64 = await p.evaluate(async () => {
        const c = new OffscreenCanvas(4000, 4000); const g = c.getContext("2d")!;
        const img = g.createImageData(4000, 4000);
        for (let i = 0; i < img.data.length; i += 4) { const v = (i * 2654435761) >>> 24; img.data[i] = v; img.data[i + 1] = (v * 7) & 255; img.data[i + 2] = (i >> 12) & 255; img.data[i + 3] = 255; }
        g.putImageData(img, 0, 0);
        const blob = await c.convertToBlob({ type: "image/png" });
        const buf = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return btoa(s);
      });
      const buf = Buffer.from(b64, "base64");
      const up = await page.request.post("/api/media", { headers: { origin: BASE }, multipart: { file: { name: `perf-${stamp}.png`, mimeType: "image/png", buffer: buf } } });
      const media = await up.json().catch(() => ({}));
      const url = (media as { url?: string }).url ?? "";
      const n = await mk(`PerfImage ${stamp}`, `Big image below\n\n![big](${url})\n`);
      await resetObs(p);
      const s = Date.now();
      await p.goto(`/?view=notes&node=${n.id}`, { waitUntil: "load" });
      await switchNoteView(p, "preview");
      const ok = await p.waitForFunction(() => { const i = document.querySelector(".obsidian-preview img") as HTMLImageElement | null; return !!i && i.complete && i.naturalWidth > 0; }, null, { timeout: 60_000 }).then(() => true).catch(() => false);
      out.bigImage = { uploadStatus: up.status(), mb: Math.round(buf.length / 1e5) / 10, loaded: ok, tVisible: Date.now() - s, ...(await readObs(p)), ...(await heapMB(cdp)) };
    });

    await step("graph", async () => {
      await resetObs(p);
      const s = Date.now();
      await p.goto("/?view=graph", { waitUntil: "load" });
      await p.locator("canvas, .react-flow__node, svg circle").first().waitFor({ timeout: 60_000 });
      await p.waitForTimeout(3000);
      out.graph = { tFirstPaint: Date.now() - s, reactFlowNodes: await p.locator(".react-flow__node").count(), canvases: await p.locator("canvas").count(), ...(await readObs(p)), ...(await heapMB(cdp)) };
    });

    await step("heapSwitches", async () => {
      await p.goto(`/?view=notes&node=${parent.id}`, { waitUntil: "load" });
      await p.locator(".obsidian-page-button").first().waitFor({ timeout: 60_000 });
      for (let i = 0; i < 60 && await gate.isVisible().catch(() => false); i++) await p.waitForTimeout(250);
      const before = await heapMB(cdp);
      await resetObs(p);
      const rows = p.locator(".obsidian-page-button");
      const times: number[] = [];
      for (let i = 0; i < 30; i++) {
        const r = rows.nth(i % Math.max(1, Math.min(15, await rows.count())));
        const s = Date.now();
        await r.click().catch(() => {});
        await p.locator(".cm-content, .react-flow__pane, .obsidian-preview").first().waitFor({ timeout: 20_000 }).catch(() => {});
        times.push(Date.now() - s);
      }
      times.sort((a, b) => a - b);
      const after = await heapMB(cdp);
      out.heapSwitches = { before, after, growthMB: Math.round((after.heapMB - before.heapMB) * 10) / 10, switchMedian: times[15], switchMax: times.at(-1), ...(await readObs(p)) };
    });
  } finally {
    await ctx.close().catch(() => {});
    writeFileSync(testInfo.outputPath("perf01.json"), JSON.stringify(out, null, 2));
    console.log("PERF01 written " + testInfo.outputPath("perf01.json"));
  }
});
