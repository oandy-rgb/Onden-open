// CAN-03 follow-up (2026-10-08): drag a card from its body centre at 1× and
// at the board's minimum zoom; compare flow-space movement with 100 screen px.
import { test } from "@playwright/test";
import { ready, seedLayout, H } from "../fullstack/helpers";


test("CAN-03b: drag precision at 1x and low zoom", async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) ids.push((await (await page.request.post("/api/nodes", { ...H, data: { title: `Z${i} ${stamp}`, markdown: `z${i}` } })).json()).id);
  const cv = await (await page.request.post("/api/canvases", { ...H, data: { title: `C03b ${stamp}` } })).json();
  await seedLayout(page.request, cv.id, { ...H, data: { data: { nodes: ids.map((id, i) => ({ nodeId: id, x: (i % 4) * 1500, y: Math.floor(i / 4) * 1200, width: 260 })) } } });
  const pos = async (id: string) => ((await (await page.request.get(`/api/canvases/${cv.id}`)).json()).data.nodes as Array<{ nodeId: string; x: number; y: number }>).find((n) => n.nodeId === id)!;
  await ready(page, `/?view=notes&node=${cv.id}`);
  await page.locator(".react-flow__node").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  const zoom = () => page.evaluate(() => { const v = document.querySelector(".react-flow__viewport") as HTMLElement; const m = /scale\(([\d.]+)\)/.exec(v.style.transform); return m ? Number(m[1]) : null; });
  const drag = async (id: string) => {
    const pre = await pos(id);
    const bb = (await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox())!;
    const hit = await page.evaluate(({ x, y }) => (document.elementFromPoint(x, y) as HTMLElement)?.className?.toString().slice(0, 40), { x: bb.x + bb.width / 2, y: bb.y + bb.height * 0.7 });
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height * 0.7); await page.mouse.down();
    await page.mouse.move(bb.x + bb.width / 2 + 100, bb.y + bb.height * 0.7, { steps: 12 }); await page.mouse.up();
    await page.waitForTimeout(2000);
    const post = await pos(id);
    const z = await zoom();
    return { zoom: z, card: `${Math.round(bb.width)}x${Math.round(bb.height)}`, hit, dx: post.x - pre.x, dy: post.y - pre.y, expected: z ? Math.round(100 / z) : null };
  };
  out.fitZoom = await drag(ids[6]);
  out.compact = await page.locator(".card-node--compact").count();
  console.log("CAN03B " + JSON.stringify(out, null, 2));
});
