// Tick 26: PER-05 — does a change made elsewhere reach a note that is open in another browser?
// Title, body and a property changed via the API; poll the open page; watch its sync traffic.
import { test } from "@playwright/test";
import { ready, BASE, H } from "../fullstack/helpers";
test("live update of an open note", async ({ page }) => {
  test.setTimeout(240_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  const note = await (await req.post("/api/nodes", { ...H, data: { title: `P05c ${s}`, markdown: "line one" } })).json();
  await req.put(`/api/nodes/${note.id}/attributes/k1`, { ...H, data: { value: "v0", value_type: "text" } });
  const traffic: string[] = [];
  const bodies: unknown[] = [];
  page.on("response", async (r) => { if (r.url().endsWith("/api/sync") && r.request().method() === "POST") { const req0 = r.request().postData() ?? ""; const t = await r.text().catch(() => ""); let nodes = 0, has = false, last = null; try { const j = JSON.parse(t); const n = j.nodes; nodes = n ? (Array.isArray(n) ? n.length : Object.keys(n).length) : 0; has = t.includes(note.id); last = j.last_event_id; } catch { /* */ } bodies.push({ at: Date.now() - s, req: req0.slice(0, 60), nodes, hasNote: has, last }); } });
  page.on("request", (r) => { const u = r.url(); if (/\/api\/(sync|events\/stream|stream|sse)/.test(u)) traffic.push(`${Date.now() - s} ${r.method()} ${u.replace(BASE, "").slice(0, 50)}`); });
  try {
    await ready(page, `/?view=notes&node=${note.id}`);
    await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
    await page.waitForTimeout(3000);
    out.bootSyncs = bodies.length; out.lastBoot = bodies.slice(-2);
    out.sseOpen = await page.evaluate(() => (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).map((e) => e.name).filter((n) => /stream|sse|events/.test(n)).map((n) => n.replace(location.origin, "")).slice(-5));
    const watch = async (label: string, change: () => Promise<unknown>, probe: () => Promise<boolean>) => {
      const t0 = Date.now(); traffic.length = 0; await change();
      for (let i = 0; i < 40; i++) { if (await probe()) { out[label] = { ms: Date.now() - t0 }; return; } await page.waitForTimeout(500); }
      out[label] = { ms: null, syncs: bodies.slice(-4) };
    };
    await watch("title", () => req.patch(`/api/nodes/${note.id}`, { ...H, data: { title: `P05c ${s} renamed` } }), async () => (await page.locator(".obsidian-title-input").inputValue().catch(() => "")).includes("renamed"));
    await watch("body", () => req.patch(`/api/nodes/${note.id}`, { ...H, data: { markdown: "line one\nremote line two" } }), async () => (await page.locator(".cm-content").innerText().catch(() => "")).includes("remote line two"));
    await watch("property", () => req.put(`/api/nodes/${note.id}/attributes/k1`, { ...H, data: { value: "v-remote", value_type: "text" } }), async () => (await page.locator("body").innerText()).includes("v-remote"));
    await watch("sidebarTitleOfOtherNote", async () => { const o = await (await req.post("/api/nodes", { ...H, data: { title: `P05c other ${s}` } })).json(); out.otherId = o.id; }, async () => (await page.getByText(`P05c other ${s}`).count()) > 0);
  } finally {
    await req.delete(`/api/nodes/${note.id}`, H).catch(() => {});
    if (out.otherId) await req.delete(`/api/nodes/${out.otherId}`, H).catch(() => {});
    console.log("PER05C " + JSON.stringify(out, null, 2));
  }
});
