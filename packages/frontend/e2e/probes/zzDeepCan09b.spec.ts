// Feature-audit deepening (2026-10-09, tick 18): CAN-09 — exporting a board in
// a slim session (workspace ≥ 2 000 notes, bodies not hydrated). Which bodies
// does export fetch; one member's fetch failing with 500 / 404 / network error
// (no partial file, clear message); then a clean export carries every body.
import { test } from "@playwright/test";
import { ready, seedLayout, boardMoreItem, H } from "../fullstack/helpers";


test("CAN-09: slim export with a failing body fetch", async ({ page }) => {
  test.setTimeout(400_000);
  const out: Record<string, unknown> = {};
  const req = page.request; const s = Date.now();
  // Existing notes the slim bootstrap ships without bodies (not created in this session).
  const slimNodes = ((await (await req.get("/api/bootstrap?bodies=none")).json()).nodes as Array<{ id: string; node_type: string; body_len?: number; markdown?: string }>)
    .filter((n) => n.node_type === "content" && (n.body_len ?? 0) > 40 && !n.markdown).slice(-13);
  const notes: Array<{ id: string; snippet: string }> = [];
  for (const n of slimNodes) { const full = await (await req.get(`/api/nodes/${n.id}`)).json(); notes.push({ id: n.id, snippet: String(full.markdown).replace(/\s+/g, " ").trim().slice(-25) }); }
  const board = await (await req.post("/api/canvases", { ...H, data: { title: `C09b board ${s}` } })).json();
  await seedLayout(req, board.id, { ...H, data: { data: { nodes: notes.map((n, i) => ({ nodeId: n.id, x: (i % 5) * 300, y: Math.floor(i / 5) * 260, width: 260 })) } } });
  const victim = notes[7].id;
  const fetched: string[] = [];
  page.on("request", (r) => { const m = /\/api\/nodes\/([0-9a-f-]{36})(\?|$)/.exec(r.url()); if (r.method() === "GET" && m && notes.some((n) => n.id === m[1])) fetched.push(m[1]); });
  const toasts = () => page.locator(".toast-message").allInnerTexts();
  const exportOnce = async (label: string) => {
    fetched.length = 0;
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 12_000 }).catch(() => null), boardMoreItem(page, "Export board (.canvas)").then((b) => b.click())]);
    await page.waitForTimeout(1500);
    const res: Record<string, unknown> = { downloaded: !!dl, fetchedDuringExport: fetched.length, victimFetched: fetched.includes(victim), toasts: await toasts() };
    if (dl) {
      const json = JSON.parse(await (await dl.createReadStream())!.toArray().then((c) => Buffer.concat(c).toString("utf8")));
      const texts = (json.nodes ?? []).filter((n: { type: string }) => n.type === "text").map((n: { text: string }) => n.text);
      res.cards = texts.length;
      res.bodiesPresent = notes.filter((n) => texts.some((t: string) => t.replace(/\s+/g, " ").includes(n.snippet))).length;
    }
    out[label] = res;
    for (const b of await page.locator(".toast button, .toast-close").filter({ visible: true }).all()) await b.click().catch(() => {});
  };
  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await ready(page, `/?view=notes&node=${board.id}`);
    await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
    await page.locator(".react-flow__node").first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(2000);
    out.slim = await page.evaluate(async () => { const r = await fetch("/api/bootstrap?bodies=none", { credentials: "include" }); const j = await r.json(); return j.nodes.length; });
    out.cardsOnBoard = await page.locator(".react-flow__node").count();
    out.fetchedWhileOpening = fetched.length;

    for (const [label, fulfil] of [
      ["fail500", (r: import("@playwright/test").Route) => r.fulfill({ status: 500, contentType: "application/json", body: "{\"error\":\"boom\"}" })],
      ["fail404", (r: import("@playwright/test").Route) => r.fulfill({ status: 404, contentType: "application/json", body: "{\"error\":\"not_found\"}" })],
      ["failNetwork", (r: import("@playwright/test").Route) => r.abort("failed")],
    ] as const) {
      await page.route(`**/api/nodes/${victim}`, (r) => r.request().method() === "GET" ? fulfil(r) : r.continue());
      await exportOnce(label);
      await page.unroute(`**/api/nodes/${victim}`);
    }
    await exportOnce("clean");
    await exportOnce("cleanAgain");
  } finally {
    await req.delete(`/api/canvases/${board.id}`, H).catch(() => {});
    console.log("CAN09B " + JSON.stringify(out, null, 2));
  }
});
