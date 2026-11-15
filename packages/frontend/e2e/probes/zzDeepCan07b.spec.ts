// CAN-07 follow-up (2026-10-08): delete a semantic link from the canvas —
// right-click at the drawn edge's midpoint, and select + Delete key.
import { test } from "@playwright/test";
import { ready, seedLayout, H } from "../fullstack/helpers";


test("CAN-07b: delete an edge from the canvas", async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const out: Record<string, string> = {};
  const mk = async (t: string) => (await (await page.request.post("/api/nodes", { ...H, data: { title: t, markdown: t } })).json()).id as string;
  const A = await mk(`DA ${stamp}`), B = await mk(`DB ${stamp}`), C = await mk(`DC ${stamp}`);
  const e1 = await (await page.request.post("/api/edges", { ...H, data: { source_node_id: A, target_node_id: B, edge_type: "knowledge_link" } })).json();
  const e2 = await (await page.request.post("/api/edges", { ...H, data: { source_node_id: A, target_node_id: C, edge_type: "knowledge_link" } })).json();
  const cv = await (await page.request.post("/api/canvases", { ...H, data: { title: `C07b ${stamp}` } })).json();
  await seedLayout(page.request, cv.id, { ...H, data: { data: { nodes: [{ nodeId: A, x: 40, y: 60, width: 240 }, { nodeId: B, x: 460, y: 60, width: 240 }, { nodeId: C, x: 460, y: 360, width: 240 }], edges: [] } } });
  const live = async (id: string) => {
    const boot = await (await page.request.get("/api/bootstrap?slim=1")).json();
    return ((boot.edges ?? []) as Array<{ id: string }>).some((e) => e.id === id);
  };
  await ready(page, `/?view=notes&node=${cv.id}`);
  await page.locator(".react-flow__node").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1200);
  out.rendered = String(await page.locator(".react-flow__edge").count());
  const mid = async (id: string) => page.locator(`.react-flow__edge[data-id="${id}"] path.react-flow__edge-path, [data-testid="rf__edge-${id}"] path`).first().evaluate((p) => {
    const path = p as SVGPathElement; const pt = path.getPointAtLength(path.getTotalLength() / 2);
    const m = path.getScreenCTM()!; return { x: pt.x * m.a + pt.y * m.c + m.e, y: pt.x * m.b + pt.y * m.d + m.f };
  }).catch(() => null);
  const m1 = await mid(e1.id);
  out.edgeDom = JSON.stringify(await page.locator(".react-flow__edge").evaluateAll((els) => els.map((e) => ({ cls: e.getAttribute("class"), id: e.getAttribute("data-id") ?? e.getAttribute("data-testid"), pe: getComputedStyle(e).pointerEvents, hasInteraction: !!e.querySelector(".react-flow__edge-interaction") }))));
  if (m1) out.hitAtMid = await page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); return `${el?.tagName}.${(el as HTMLElement)?.className?.toString?.().slice(0, 60)}`; }, m1);
  await page.screenshot({ path: test.info().outputPath("can07b.png") });
  out.mid1 = JSON.stringify(m1);
  if (m1) {
    await page.mouse.click(m1.x, m1.y, { button: "right" });
    await page.waitForTimeout(600);
    const menu = page.locator(".ctx-menu").first();
    out.menu = (await menu.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
    const del = menu.getByRole("button").or(menu.getByRole("menuitem")).filter({ hasText: /Delete|Remove|刪除|Unlink/ }).first();
    if (await del.count()) { await del.click(); await page.waitForTimeout(2000); }
    out.afterMenu = `live=${await live(e1.id)} rendered=${await page.locator(".react-flow__edge").count()}`;
  }
  const m2 = await mid(e2.id);
  if (m2) {
    await page.mouse.click(m2.x, m2.y);
    await page.waitForTimeout(400);
    out.selected = String(await page.locator(".react-flow__edge.selected").count());
    await page.keyboard.press("Delete");
    await page.waitForTimeout(2000);
    out.afterDeleteKey = `live=${await live(e2.id)} rendered=${await page.locator(".react-flow__edge").count()}`;
  }
  console.log("CAN07B " + JSON.stringify(out, null, 2));
});
