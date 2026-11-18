// Feature-audit deepening (2026-10-08): CAN-05 — canvas undo against a later
// edit made elsewhere (another device moves the same card), and switching to
// another board (its row in the notes list) while a drag's save is still in flight.
import { test, expect } from "@playwright/test";
import { ready, seedLayout, H } from "./helpers";


test("CAN-05: undo vs later remote move; board switch during save", async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const mk = async (t: string) => (await (await page.request.post("/api/nodes", { ...H, data: { title: t, markdown: `${t} body` } })).json()).id as string;
  const X = await mk(`UX ${stamp}`), Y = await mk(`UY ${stamp}`), P = await mk(`UP ${stamp}`);
  const A = await (await page.request.post("/api/canvases", { ...H, data: { title: `C05A ${stamp}` } })).json();
  const B = await (await page.request.post("/api/canvases", { ...H, data: { title: `C05B ${stamp}` } })).json();
  await seedLayout(page.request, A.id, { ...H, data: { data: { nodes: [{ nodeId: X, x: 0, y: 0, width: 240 }, { nodeId: Y, x: 600, y: 300, width: 240 }] } } });
  await seedLayout(page.request, B.id, { ...H, data: { data: { nodes: [{ nodeId: P, x: 0, y: 0, width: 240 }] } } });
  const pos = async (cv: string, id: string) => { const n = ((await (await page.request.get(`/api/canvases/${cv}`)).json()).data.nodes as Array<{ nodeId: string; x: number; y: number }>).find((q) => q.nodeId === id); return n ? `${Math.round(n.x)},${Math.round(n.y)}` : "absent"; };
  const open = async (id: string) => { await ready(page, `/?view=notes&node=${id}`); await page.locator(".react-flow__node").first().waitFor({ timeout: 30_000 }); await page.waitForTimeout(1500); };
  const dragBy = async (id: string, dx: number, dy: number) => {
    const bb = (await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox())!;
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height * 0.7); await page.mouse.down();
    await page.mouse.move(bb.x + bb.width / 2 + dx, bb.y + bb.height * 0.7 + dy, { steps: 10 }); await page.mouse.up();
  };
  const undo = page.locator('button[title="Undo canvas move"]');

  // 1) Undo after another device moved the same card.
  await open(A.id);
  await dragBy(Y, 0, 120);
  await page.waitForTimeout(2000);
  out.afterDrag = await pos(A.id, Y);
  const cur = ((await (await page.request.get(`/api/canvases/${A.id}`)).json()).data.nodes as Array<{ nodeId: string; x: number; y: number }>);
  await seedLayout(page.request, A.id, { ...H, data: { data: { nodes: cur.map((n) => n.nodeId === Y ? { ...n, x: 1500, y: 1500 } : n) } } });
  out.afterRemoteMove = await pos(A.id, Y);
  await page.waitForTimeout(4000); // let sync refresh the open board
  out.screenAfterRemote = await page.locator(`.react-flow__node[data-id="${Y}"]`).evaluate((e) => (e as HTMLElement).style.transform);
  out.undoEnabled = await undo.isEnabled();
  await undo.click().catch(() => {});
  await page.waitForTimeout(2500);
  out.afterUndo = { Y: await pos(A.id, Y), toast: (await page.locator(".toast").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").slice(0, 140) };
  // GAP-180: undo must not put back a card another device moved since.
  expect(out.afterUndo.Y).toBe("1500,1500");
  expect(out.afterUndo.toast).toMatch(/moved again since/);

  // 2) Drag on A, save delayed 3s, switch to B before it lands.
  await open(A.id);
  await page.route(`**/api/boards/${A.id}`, async (r) => { if (r.request().method() === "PATCH") { await new Promise((res) => setTimeout(res, 3000)); } return r.continue(); });
  const xBefore = await pos(A.id, X);
  await dragBy(X, 150, 0);
  await page.waitForTimeout(200);
  // In-app switch: click board B's row in the notes list (no page navigation). A board is a note with a Canvas tab, so it is
  // listed there; there is no board chooser page any more (docs/architecture/canvas-as-view.md).
  await page.locator(".obsidian-sidebar").getByRole("button", { name: `C05B ${stamp}`, exact: true }).click();
  await page.locator(`.react-flow__node[data-id="${P}"]`).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(4500);
  out.switchDuringSave = { xBefore, xAfter: await pos(A.id, X), bHasX: await pos(B.id, X), pOnB: await pos(B.id, P), undoOnB: await undo.isEnabled().catch(() => null) };
  if (await undo.isEnabled().catch(() => false)) {
    await undo.click(); await page.waitForTimeout(2500);
    out.undoOnBEffect = { xOnA: await pos(A.id, X), pOnB: await pos(B.id, P) };
  }
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await open(A.id);
  out.backOnA = { undo: await undo.isEnabled(), x: await pos(A.id, X) };
  console.log("CAN05 " + JSON.stringify(out, null, 2));
});
