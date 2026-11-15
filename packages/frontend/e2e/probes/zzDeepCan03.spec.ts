// Feature-audit deepening (2026-10-08): CAN-03 + CAN-05 — "Tidy up (grid)"
// and "Arrange as tree" with variable card sizes and a 3-level hierarchy
// (overlap measured on the rendered DOM), dragging at low zoom, undo after an
// arrangement, an arrangement refused by the server, and undo after reload.
import { test, expect, type Page } from "@playwright/test";
import { ready, seedLayout, boardMoreItem, H } from "../fullstack/helpers";


test("CAN-03/05: arrange with real sizes, low-zoom drag, undo edges", async ({ page }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const out: Record<string, string> = {};
  const mk = async (title: string, parent?: string, md = `${title} body`) => (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: md, ...(parent ? { parent_id: parent } : {}) } })).json()).id as string;
  const R = await mk(`TR ${stamp}`);
  const C1 = await mk(`TC1 ${stamp}`, R), C2 = await mk(`TC2 ${stamp}`, R);
  const G1 = await mk(`TG1 ${stamp}`, C1), G2 = await mk(`TG2 ${stamp}`, C1), G3 = await mk(`TG3 ${stamp}`, C2);
  const Loose = await mk(`TLoose ${stamp}`, undefined, Array.from({ length: 30 }, (_, i) => `para ${i}`).join("\n\n"));
  const ids = [R, C1, C2, G1, G2, G3, Loose];
  const names: Record<string, string> = { [R]: "R", [C1]: "C1", [C2]: "C2", [G1]: "G1", [G2]: "G2", [G3]: "G3", [Loose]: "Loose" };
  const sizes = [[500, 300], [260, 140], [420, 380], [260, 140], [600, 200], [260, 140], [300, null]];
  const cv = await (await page.request.post("/api/canvases", { ...H, data: { title: `C03 ${stamp}` } })).json();
  await seedLayout(page.request, cv.id, { ...H, data: { data: { nodes: ids.map((id, i) => ({ nodeId: id, x: (i * 137) % 900, y: (i * 211) % 700, width: sizes[i][0], ...(sizes[i][1] ? { height: sizes[i][1] } : {}) })) } } });
  const saved = async () => ((await (await page.request.get(`/api/canvases/${cv.id}`)).json()).data.nodes as Array<{ nodeId: string; x: number; y: number; width?: number; height?: number }>);
  const overlaps = async (p: Page) => p.evaluate(() => {
    const els = Array.from(document.querySelectorAll(".react-flow__node:not(.react-flow__node-section)")) as HTMLElement[];
    const r = els.map((e) => ({ id: e.getAttribute("data-id")!, b: e.getBoundingClientRect() }));
    const pairs: string[] = [];
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
      const a = r[i].b, c = r[j].b;
      if (a.left < c.right - 1 && c.left < a.right - 1 && a.top < c.bottom - 1 && c.top < a.bottom - 1) pairs.push(`${r[i].id}|${r[j].id}`);
    }
    return pairs;
  });
  const nameOverlaps = (pairs: string[]) => pairs.map((p) => p.split("|").map((id) => names[id] ?? "?").join("×"));
  try {
  await ready(page, `/?view=notes&node=${cv.id}`);
  await page.locator(".react-flow__node").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  const undoBtn = page.locator('button[title="Undo canvas move"]');

  // Grid tidy.
  await (await boardMoreItem(page, "Tidy up (grid)")).click();
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "Fit view", exact: true }).click().catch(() => {});
  await page.waitForTimeout(800);
  out.gridOverlaps = JSON.stringify(nameOverlaps(await overlaps(page)));
  out.gridSaved = JSON.stringify((await saved()).map((n) => `${names[n.nodeId]}@${n.x},${n.y} ${n.width}x${n.height ?? "auto"}`));
  out.undoEnabledAfterGrid = String(await undoBtn.isEnabled());
  await undoBtn.click();
  await page.waitForTimeout(2000);
  out.afterUndoGrid = JSON.stringify((await saved()).map((n) => `${names[n.nodeId]}@${n.x},${n.y}`));

  // Tree: select root first.
  await page.locator(`.react-flow__node[data-id="${R}"]`).click();
  await (await boardMoreItem(page, "Arrange as tree")).click();
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "Fit view", exact: true }).click().catch(() => {});
  await page.waitForTimeout(800);
  out.treeOverlaps = JSON.stringify(nameOverlaps(await overlaps(page)));
  out.treeSaved = JSON.stringify((await saved()).map((n) => `${names[n.nodeId]}@${n.x},${n.y}`));

  // Refused arrangement (PATCH 403): what is left on the undo stack?
  await ready(page, `/?view=notes&node=${cv.id}`); await page.locator(".react-flow__node").first().waitFor({ timeout: 30_000 }); await page.waitForTimeout(1500);
  out.undoAfterReload = String(await undoBtn.isEnabled());
  const beforeRefused = JSON.stringify(await saved());
  await page.route(`**/api/boards/${cv.id}`, (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  await (await boardMoreItem(page, "Tidy up (grid)")).click();
  await page.waitForTimeout(2500);
  const shown = await page.evaluate(() => Array.from(document.querySelectorAll(".react-flow__node")).map((e) => (e as HTMLElement).style.transform).join(";"));
  out.refusedGrid = JSON.stringify({ serverUnchanged: JSON.stringify(await saved()) === beforeRefused, undoEnabled: await undoBtn.isEnabled(), toast: (await page.locator(".toast").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").slice(0, 120) });
  await page.unroute(`**/api/boards/${cv.id}`);
  await page.waitForTimeout(1500);
  const shownAfter = await page.evaluate(() => Array.from(document.querySelectorAll(".react-flow__node")).map((e) => (e as HTMLElement).style.transform).join(";"));
  out.refusedScreenRolledBack = String(shown !== shownAfter || JSON.stringify(await saved()) === beforeRefused);
  if (await undoBtn.isEnabled()) {
    await undoBtn.click(); await page.waitForTimeout(2000);
    out.undoAfterRefused = JSON.stringify({ serverChanged: JSON.stringify(await saved()) !== beforeRefused, toast: (await page.locator(".toast").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").slice(0, 120) });
  }
  // Redo shortcuts exist?
  const before = JSON.stringify(await saved());
  await page.locator(".react-flow__pane").click({ position: { x: 20, y: 20 }, force: true });
  await page.keyboard.press("Control+Shift+z"); await page.keyboard.press("Control+y");
  await page.waitForTimeout(1500);
  out.redoKeysChangeSomething = String(JSON.stringify(await saved()) !== before);

  // Low zoom drag precision: zoom out to ~0.2, drag a card 100 screen px.
  await ready(page, `/?view=notes&node=${cv.id}`); await page.locator(".react-flow__node").first().waitFor({ timeout: 30_000 }); await page.waitForTimeout(1500);
  for (let i = 0; i < 12; i++) { await page.mouse.move(700, 400); await page.mouse.wheel(0, 300); await page.waitForTimeout(80); }
  await page.waitForTimeout(800);
  const zoom = await page.evaluate(() => { const v = document.querySelector(".react-flow__viewport") as HTMLElement; const m = /scale\(([\d.]+)\)/.exec(v.style.transform); return m ? Number(m[1]) : null; });
  const card = page.locator(`.react-flow__node[data-id="${G3}"]`);
  const pre = (await saved()).find((n) => n.nodeId === G3)!;
  const bb = await card.boundingBox();
  if (bb) { await page.mouse.move(bb.x + bb.width / 2, bb.y + Math.min(6, bb.height / 2)); await page.mouse.down(); await page.mouse.move(bb.x + bb.width / 2 + 100, bb.y + Math.min(6, bb.height / 2), { steps: 10 }); await page.mouse.up(); }
  await page.waitForTimeout(2000);
  const post = (await saved()).find((n) => n.nodeId === G3)!;
  out.lowZoomDrag = JSON.stringify({ zoom, cardPx: bb ? `${Math.round(bb.width)}x${Math.round(bb.height)}` : null, dxFlow: post.x - pre.x, dyFlow: post.y - pre.y, expectedDx: zoom ? Math.round(100 / zoom) : null });
  } finally {
    console.log("CAN03 " + JSON.stringify(out, null, 2));
  }
});
