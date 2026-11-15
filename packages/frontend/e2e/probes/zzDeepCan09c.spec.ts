// Tick 18: CAN-09 / PERF — in a ≥2 000-note workspace, which startup requests carry note bodies?
import { test } from "@playwright/test";
import { ready } from "../fullstack/helpers";
test("slim session body traffic", async ({ page }) => {
  test.setTimeout(240_000);
  const postSync: unknown[] = [];
  const rows: Array<{ url: string; method: string; bytes: number; withBody: number; nodes: number }> = [];
  page.on("response", async (r) => {
    const u = r.url(); if (!u.includes("/api/")) return;
    const text = await r.text().catch(() => "");
    let withBody = 0, nodes = 0;
    try { const j = JSON.parse(text); const arr = (j.nodes ?? j.items ?? j.upserts ?? (Array.isArray(j) ? j : [])) as Array<{ markdown?: string }>;
      if (Array.isArray(arr)) { nodes = arr.length; withBody = arr.filter((n) => typeof n?.markdown === "string" && n.markdown.length > 0).length; } } catch { /* not json */ }
    if (u.endsWith("/api/sync") && r.request().method() === "POST") { try { const j = JSON.parse(text); const req = JSON.parse(r.request().postData() ?? "{}");
      const find = (o: unknown): Array<{ markdown?: string }> => Array.isArray(o) ? o as Array<{ markdown?: string }> : [];
      const nodesArr = find((j.nodes ?? j.changes?.nodes ?? j.delta?.nodes));
      postSync.push({ since: req.since, nodeShape: Array.isArray(j.nodes) ? "array" : typeof j.nodes, nodeCount: j.nodes && !Array.isArray(j.nodes) ? Object.keys(j.nodes).length : (j.nodes?.length ?? 0), reqKeys: Object.keys(req), idsRequested: Array.isArray(req.ids) ? req.ids.length : null, keys: Object.keys(j), nodes: nodesArr.length, withBody: nodesArr.filter((n) => typeof n.markdown === "string" && n.markdown.length > 0).length, markdownKeyCount: (text.match(/"markdown":"[^"]/g) ?? []).length }); } catch { /* */ } }
    rows.push({ url: u.replace(/^https?:\/\/[^/]+/, "").slice(0, 90), method: r.request().method(), bytes: text.length, withBody, nodes });
  });
  await ready(page, "/?view=notes");
  await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  await page.waitForTimeout(8000);
  const big = rows.filter((r) => r.bytes > 20_000 || r.withBody > 0).sort((a, b) => b.bytes - a.bytes).slice(0, 15);
  console.log("SLIMTRAFFIC " + JSON.stringify({ postSync, total: rows.length, totalBytes: rows.reduce((a, r) => a + r.bytes, 0), big }, null, 1));
});
