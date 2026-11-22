// Feature-audit deepening (2026-10-08): CAN-05 — canvas undo against a later
// edit made elsewhere (another device moves the same card), and switching to
// another board (its row in the notes list) while a drag's save is still in flight.
import { test, expect } from "@playwright/test";
import { ready, seedLayout, H } from "./helpers";


test("CAN-05: undo vs later remote move; board switch during save", async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
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
  // The drag is saved: Y moved down from (600,300) and kept its column (decisions-canvas.md: 一個手勢一組位置).
  await expect.poll(() => pos(A.id, Y)).not.toBe("600,300");
  const [dragX, dragY] = (await pos(A.id, Y)).split(",").map(Number);
  expect(dragX, "a vertical drag keeps the column").toBe(600);
  expect(dragY, "and moves the card down").toBeGreaterThan(300);
  const cur = ((await (await page.request.get(`/api/canvases/${A.id}`)).json()).data.nodes as Array<{ nodeId: string; x: number; y: number }>);
  await seedLayout(page.request, A.id, { ...H, data: { data: { nodes: cur.map((n) => n.nodeId === Y ? { ...n, x: 1500, y: 1500 } : n) } } });
  expect(await pos(A.id, Y), "the other device's move is on the server").toBe("1500,1500");
  // The open board shows it once sync refreshes it (decisions-canvas.md: 同步等核對, refreshOpenCanvas).
  await expect.poll(() => page.locator(`.react-flow__node[data-id="${Y}"]`).evaluate((e) => (e as HTMLElement).style.transform)).toBe("translate(1500px, 1500px)");
  // The drag is still in this board's undo history (decisions-canvas.md: 復原 — position entries in useBoardHistory) ...
  await expect(undo).toBeEnabled();
  await undo.click();
  // ... but undo must not put back a card another device moved since: it stays where the other device put it and says so.
  // GAP-180 / decisions-canvas.md: 退回只動仍停在手勢留下位置的卡片，之後被移動過的保留較新位置。
  await expect(page.locator(".toast").filter({ hasText: /moved again since/ }).first()).toBeVisible();
  expect(await pos(A.id, Y)).toBe("1500,1500");

  // 2) Drag on A, save delayed 3s, switch to B before it lands.
  await open(A.id);
  await page.route(`**/api/boards/${A.id}`, async (r) => { if (r.request().method() === "PATCH") { await new Promise((res) => setTimeout(res, 3000)); } return r.continue(); });
  const xBefore = await pos(A.id, X);
  await dragBy(X, 150, 0);
  await page.waitForTimeout(200); // the save is in flight (held 3 s by the route) when the board is switched
  // In-app switch: click board B's row in the notes list (no page navigation). A board is a note with a Canvas tab, so it is
  // listed there; there is no board chooser page any more (docs/architecture/canvas-as-view.md).
  await page.locator(".obsidian-sidebar").getByRole("button", { name: `C05B ${stamp}`, exact: true }).click();
  await page.locator(`.react-flow__node[data-id="${P}"]`).waitFor({ timeout: 15_000 });
  // The save lands on the board the drag was made on (decisions-canvas.md: 呼叫者保留開始時的白板 ID), not on the one now open.
  await expect.poll(() => pos(A.id, X), { timeout: 20_000 }).not.toBe(xBefore);
  const [movedX, movedY] = (await pos(A.id, X)).split(",").map(Number);
  expect(movedX, "X moved right on A").toBeGreaterThan(Number(xBefore.split(",")[0]));
  expect(movedY, "and stayed on its row").toBe(Number(xBefore.split(",")[1]));
  expect(await pos(B.id, X), "the drag did not leak onto B").toBe("absent");
  expect(await pos(B.id, P), "B's own card did not move").toBe("0,0");
  // The undo history belongs to the board it was made on and to this session (decisions-canvas.md: 只在開著的白板內有效、不跨工作階段).
  await expect(undo, "B has nothing to undo").toBeDisabled();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await open(A.id);
  await expect(undo, "a reopened board has nothing to undo").toBeDisabled();
  expect(await pos(A.id, X), "the move stays").toBe(`${movedX},${movedY}`);
});
