// Feature-audit deepening (2026-10-08): CAN-02 — board membership: a second
// device replays a stale offline layout after someone else added a card; the
// three quick-create entries (double-click, toolbar "C" mode, right-click
// "Create node here"); offline create + place and replay; a refused note
// create leaves no placement.
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { ready, seedLayout, BASE, H, syncLabel } from "./helpers";


test("CAN-02: stale layout replay, quick-create entries, offline create, refused create", async ({ page, browser, context }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const mk = async (title: string) => (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: `${title} body` } })).json()).id as string;
  const placed = async (cv: string) => ((await (await page.request.get(`/api/canvases/${cv}`)).json()).data.nodes as Array<{ nodeId: string; x: number; y: number }>);
  const gate = (p: Page) => p.getByText("Checking your workspace", { exact: false });
  const settle = async (p: Page) => { for (let i = 0; i < 60 && await gate(p).isVisible().catch(() => false); i++) await p.waitForTimeout(500); await p.waitForTimeout(1500); };
  const openBoard = async (p: Page, id: string) => { await ready(p, `/?view=notes&node=${id}`); await p.locator(".react-flow__node").first().waitFor({ timeout: 30_000 }); await settle(p); };
  try {
  // ── 1) Stale layout from an offline second device ───────────────────────
  const X = await mk(`SX ${stamp}`), Y = await mk(`SY ${stamp}`), Z = await mk(`SZ ${stamp}`);
  const cv = await (await page.request.post("/api/canvases", { ...H, data: { title: `C02Stale ${stamp}` } })).json();
  await seedLayout(page.request, cv.id, { ...H, data: { data: { nodes: [{ nodeId: X, x: 40, y: 40, width: 240 }, { nodeId: Y, x: 400, y: 40, width: 240 }] } } });
  const devB: BrowserContext = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json" });
  const pb = await devB.newPage();
  await openBoard(pb, cv.id);
  await devB.setOffline(true);
  await pb.waitForTimeout(500);
  const yCard = pb.locator(`.react-flow__node[data-id="${Y}"]`);
  const yb = await yCard.boundingBox();
  // Grab the card body: the title strip is an input, where a drag selects text.
  expect(yb, "card Y is on device B's board").not.toBeNull();
  await pb.mouse.move(yb!.x + yb!.width / 2, yb!.y + yb!.height * 0.7); await pb.mouse.down();
  await pb.mouse.move(yb!.x + yb!.width / 2, yb!.y + yb!.height * 0.7 + 220, { steps: 10 }); await pb.mouse.up();
  await pb.waitForTimeout(1200);
  // Meanwhile device A (API) adds Z.
  await seedLayout(page.request, cv.id, { ...H, data: { data: { nodes: [...(await placed(cv.id)), { nodeId: Z, x: 40, y: 400, width: 240 }] } } });
  // While B is offline its drag has not reached the server: X, Y at its seeded place, and A's Z.
  const beforeReplay = await placed(cv.id);
  expect(beforeReplay.map((n) => n.nodeId).sort(), "the server holds X, Y and A's Z").toEqual([X, Y, Z].sort());
  expect(beforeReplay.find((n) => n.nodeId === Y)?.y, "B's offline drag has not reached the server yet").toBe(40);
  await devB.setOffline(false);
  // The offline move replays as a card upsert: Y moved down, and device A's Z
  // (added meanwhile) is kept rather than overwritten by B's stale layout (decisions-canvas.md: 寫入走 canvas writer, 判重/讀最新布局).
  await expect.poll(async () => (await placed(cv.id)).find((n) => n.nodeId === Y)?.y ?? 0, "B's offline drag reached the server").toBeGreaterThan(100);
  const after = await placed(cv.id);
  expect(after.map((n) => n.nodeId).sort(), "A's card survives B's replay and nothing else appears").toEqual([X, Y, Z].sort());
  expect(after.find((n) => n.nodeId === X), "X was not touched").toMatchObject({ x: 40, y: 40 });
  expect(after.find((n) => n.nodeId === Z), "Z stays where A put it").toMatchObject({ x: 40, y: 400 });
  // Device B shows A's card once its open board is checked against the server (decisions-canvas.md: 同步等核對, refreshOpenCanvas).
  await expect(pb.locator(`.react-flow__node[data-id="${Z}"]`)).toHaveCount(1);
  await devB.close();

  // ── 2) Quick-create entries ─────────────────────────────────────────────
  // The double-click, the toolbar's card mode and the right-click menu share one handler (decisions-canvas-history.md: 右鍵新建與雙擊／工具列共用
  // handler 和錯誤邊界): each makes one note and puts one card of it on the board.
  const seed = await mk(`QSeed ${stamp}`), farSeed = await mk(`QFar ${stamp}`);
  const qb = await (await page.request.post("/api/canvases", { ...H, data: { title: `C02Quick ${stamp}` } })).json();
  // Two cards far apart, so the view leaves empty board to act on (a single card is zoomed to fill the view, and a double click on it edits it).
  await seedLayout(page.request, qb.id, { ...H, data: { data: { nodes: [{ nodeId: seed, x: 0, y: 0, width: 200 }, { nodeId: farSeed, x: 1500, y: 900, width: 200 }] } } });
  await openBoard(page, qb.id);
  // A point of bare board: where the pointer lands on the pane itself, not on a card or a control.
  const emptySpot = () => page.evaluate(() => {
    const pane = document.querySelector(".react-flow__pane")!.getBoundingClientRect();
    for (let fy = 0.2; fy < 0.9; fy += 0.1) for (let fx = 0.2; fx < 0.9; fx += 0.1) {
      const x = pane.x + pane.width * fx, y = pane.y + pane.height * fy;
      const el = document.elementFromPoint(x, y);
      if (el?.closest(".react-flow__pane") && !el.closest(".react-flow__node, .react-flow__controls, .react-flow__minimap, .react-flow__panel, button")) return { x, y };
    }
    return null;
  });
  const bareSpot = async () => { const at = await emptySpot(); expect(at, "there is bare board to act on").not.toBeNull(); return at!; };
  const noteIds = async () => new Set(((await (await page.request.get("/api/bootstrap?slim=1")).json()).nodes as Array<{ id: string }>).map((n) => n.id));
  /** Runs `act`, then waits for the notes it made: returns their ids. */
  const madeBy = async (act: () => Promise<void>, expected: number) => {
    const known = await noteIds();
    await act();
    let made: string[] = [];
    await expect.poll(async () => { made = [...(await noteIds())].filter((id) => !known.has(id)); return made.length; }).toBe(expected);
    return made;
  };
  const placedIds = async () => new Set((await placed(qb.id)).map((n) => n.nodeId));
  await expect.poll(async () => (await placed(qb.id)).length).toBe(2);

  let at = await bareSpot();
  const dbl = await madeBy(() => page.mouse.dblclick(at.x, at.y), 1);
  await expect.poll(async () => (await placedIds()).has(dbl[0]), "the double click's note is placed on the board").toBe(true);
  // A card made by clicking the board opens with its title ready for typing (lib/cardTitleFocus.ts).
  await expect(page.locator(`.react-flow__node[data-id="${dbl[0]}"] .card-node-title-input`), "the new card's title is ready for typing").toBeFocused();
  await page.keyboard.press("Escape");
  await page.locator(".react-flow__pane").click({ position: { x: 30, y: 30 }, force: true });

  const tool = await madeBy(async () => {
    await page.locator('button[title="New card — click canvas (C)"]').click();
    at = await bareSpot();
    await page.mouse.click(at.x, at.y);
  }, 1);
  await expect.poll(async () => (await placedIds()).has(tool[0]), "the toolbar's note is placed on the board").toBe(true);
  await page.keyboard.press("Escape");

  at = await bareSpot();
  await page.mouse.click(at.x, at.y, { button: "right" });
  // The menu entry reads 「Create note here」 (components/ContextMenu.tsx), not "node".
  const ctx = await madeBy(() => page.locator(".ctx-menu").getByRole("menuitem", { name: "Create note here", exact: true }).click(), 1);
  await expect.poll(async () => (await placedIds()).has(ctx[0]), "the menu's note is placed on the board").toBe(true);
  await page.keyboard.press("Escape");

  // Two quick double clicks on the same spot make two cards: each double click is a create, and the first card is not under the
  // pointer yet when the second arrives.
  at = await bareSpot();
  const twice = await madeBy(async () => { await page.mouse.dblclick(at.x, at.y); await page.mouse.dblclick(at.x, at.y); }, 2); // pinned: today's behaviour, no written rule
  await expect.poll(async () => { const on = await placedIds(); return twice.filter((id) => on.has(id)).length; }).toBe(2); // pinned: today's behaviour, no written rule

  // ── 3) Refused note create (403) ─────────────────────────────────────────
  // A refused create leaves no note and no placement, no phantom card, and the refused input is kept in the recovery panel
  // (decisions-offline-account.md, batch 16; 403 reads 「You don't have permission to do that.」, lib/serverErrors.ts).
  await openBoard(page, qb.id);
  const p0 = (await placed(qb.id)).length;
  const cards0 = await page.locator(".react-flow__node").count();
  const known403 = await noteIds();
  await page.route("**/api/nodes", (r) => r.request().method() === "POST" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  at = await bareSpot();
  await page.mouse.dblclick(at.x, at.y);
  const recovery = page.locator(".failed-write-recovery").filter({ visible: true });
  await expect(recovery).toContainText("This change was rejected");
  await expect(recovery).toContainText("You don't have permission to do that.");
  await expect(recovery, "the refused input is kept").toContainText("New note");
  expect([...(await noteIds())].filter((id) => !known403.has(id)), "no note was made").toHaveLength(0);
  expect((await placed(qb.id)).length - p0, "nothing was placed").toBe(0);
  await expect(page.locator(".react-flow__node"), "and no phantom card is drawn").toHaveCount(cards0);
  await page.unroute("**/api/nodes");

  // ── 4) Offline create + place, then reconnect ───────────────────────────
  await openBoard(page, qb.id);
  const p1 = (await placed(qb.id)).length;
  const cards1 = await page.locator(".react-flow__node").count();
  await context.setOffline(true);
  await expect.poll(() => syncLabel(page)).toMatch(/Offline/);
  at = await bareSpot();
  await page.mouse.dblclick(at.x, at.y);
  await expect(page.locator(".card-node-title-input:focus"), "the new card's title is ready for typing (lib/cardTitleFocus.ts)").toHaveCount(1);
  await page.keyboard.type(`Offline card ${stamp}`);
  await page.locator(".react-flow__pane").click({ position: { x: 30, y: 30 }, force: true });
  // The card shows at once, and the sync status says the change waits (「Offline — {n} changes will sync on reconnect」, components/SyncStatus.tsx):
  // saved on this device is not shown as synced.
  await expect(page.locator(".react-flow__node")).toHaveCount(cards1 + 1);
  await expect.poll(() => syncLabel(page)).toMatch(/Offline — \d+ changes? will sync on reconnect/);
  await context.setOffline(false);
  // After reconnecting: exactly one note with that title, placed once on the board (the offline create replays once, decisions-offline-account.md).
  const titled = async () => ((await (await page.request.get("/api/bootstrap?slim=1")).json()).nodes as Array<{ id: string; title: string }>).filter((n) => n.title.includes(`Offline card ${stamp}`));
  await expect.poll(async () => (await titled()).length, { timeout: 30_000 }).toBe(1);
  const offNote = (await titled())[0];
  await expect.poll(async () => (await placed(qb.id)).filter((n) => n.nodeId === offNote.id).length, { timeout: 30_000 }).toBe(1);
  expect((await placed(qb.id)).length - p1, "one card was added to the board").toBe(1);
  // The URL follows the selected card's note after a create, so a bare reload
  // would open that note; reopen the board itself.
  await openBoard(page, qb.id);
  // The board shows as many cards as the server placed.
  await expect(page.locator(".react-flow__node")).toHaveCount((await placed(qb.id)).length);
  } finally {
    await context.setOffline(false).catch(() => {});
  }
});
