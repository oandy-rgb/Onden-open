// Feature-audit deepening (2026-10-08): CAN-04 — dense groups: 16 overlapping
// / nested sections with long titles (do headings collide at fit and at 1x?),
// whether colour / fold controls exist, and a group move refused with 403
// (members stay, undo entry).
import { test } from "@playwright/test";
import { ready, seedLayout, H } from "../fullstack/helpers";


test("CAN-04: dense group headings, colour/fold controls, refused group move", async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const cards: string[] = [];
  for (let i = 0; i < 6; i++) cards.push((await (await page.request.post("/api/nodes", { ...H, data: { title: `GC${i} ${stamp}`, markdown: `gc${i}` } })).json()).id);
  const sections = Array.from({ length: 16 }, (_, i) => ({
    id: `s${i}-${stamp}`, title: i % 3 === 0 ? `Very long group title number ${i} about thermodynamics lecture notes` : `G${i}`,
    x: (i % 4) * 60, y: Math.floor(i / 4) * 50, width: 900 - (i % 4) * 60, height: 700 - Math.floor(i / 4) * 50, ...(i % 5 === 0 ? { color: "#ef4444" } : {}),
  }));
  const cv = await (await page.request.post("/api/canvases", { ...H, data: { title: `C04 ${stamp}` } })).json();
  await seedLayout(page.request, cv.id, { ...H, data: { data: { nodes: cards.map((id, i) => ({ nodeId: id, x: 300 + (i % 3) * 200, y: 300 + Math.floor(i / 3) * 160, width: 180 })), sections } } });
  await ready(page, `/?view=notes&node=${cv.id}`);
  await page.locator(".react-flow__node").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2000);
  const headingReport = () => page.evaluate(() => {
    const hs = Array.from(document.querySelectorAll(".section-node-heading")) as HTMLElement[];
    const r = hs.map((h) => h.getBoundingClientRect()).filter((b) => b.width > 0);
    let pairs = 0;
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) { const a = r[i], c = r[j]; if (a.left < c.right - 1 && c.left < a.right - 1 && a.top < c.bottom - 1 && c.top < a.bottom - 1) pairs++; }
    const truncated = hs.filter((h) => { const t = h.querySelector(".section-node-title") as HTMLElement | null; return t ? t.scrollWidth > t.clientWidth + 1 : false; }).length;
    const v = document.querySelector(".react-flow__viewport") as HTMLElement; const z = /scale\(([\d.]+)\)/.exec(v.style.transform)?.[1];
    return { headings: r.length, overlappingPairs: pairs, truncatedTitles: truncated, zoom: z ? Number(z) : null };
  });
  out.atFit = await headingReport();
  // Zoom in to ~1x around the top-left cluster.
  for (let i = 0; i < 6; i++) { await page.mouse.move(500, 250); await page.mouse.wheel(0, -200); await page.waitForTimeout(100); }
  await page.waitForTimeout(800);
  out.zoomedIn = await headingReport();
  out.colorsRendered = await page.evaluate(() => Array.from(document.querySelectorAll(".section-node")).map((e) => getComputedStyle(e as HTMLElement).getPropertyValue("--section-color").trim()).filter((c) => c && c !== "#6366f1").length);
  // Controls on a group: right-click a heading.
  const h0 = page.locator(".section-node-heading").first();
  await h0.click({ button: "right" }).catch(() => {});
  await page.waitForTimeout(500);
  out.groupContextMenu = (await page.locator(".ctx-menu").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
  await page.keyboard.press("Escape");
  out.groupButtons = await page.locator(".section-node").first().locator("button").allInnerTexts().catch(() => []);

  // Refused group move (403).
  await ready(page, `/?view=notes&node=${cv.id}`);
  await page.locator(".react-flow__node").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  const before = JSON.stringify((await (await page.request.get(`/api/canvases/${cv.id}`)).json()).data);
  await page.route(`**/api/boards/${cv.id}`, (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  const last = page.locator(".section-node-leader").last();
  const bb = await page.locator(".section-node").last().boundingBox();
  if (bb) { await page.mouse.move(bb.x + bb.width - 10, bb.y + bb.height - 10); await page.mouse.down(); await page.mouse.move(bb.x + bb.width + 90, bb.y + bb.height + 50, { steps: 10 }); await page.mouse.up(); }
  await page.waitForTimeout(2500);
  out.refusedMove = { serverUnchanged: JSON.stringify((await (await page.request.get(`/api/canvases/${cv.id}`)).json()).data) === before, toast: (await page.locator(".toast").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").slice(0, 120), undo: await page.locator('button[title="Undo canvas move"]').isEnabled(), leader: await last.count() };
  await page.unrouteAll({ behavior: "ignoreErrors" });
  console.log("CAN04 " + JSON.stringify(out, null, 2));
});
