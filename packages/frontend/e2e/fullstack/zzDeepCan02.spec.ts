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
  const out: Record<string, string> = {};
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
  out.beforeReplay = JSON.stringify((await placed(cv.id)).map((n) => n.nodeId === X ? "X" : n.nodeId === Y ? `Y@${n.y}` : n.nodeId === Z ? "Z" : "?"));
  await devB.setOffline(false);
  await pb.waitForTimeout(8000);
  out.afterReplay = JSON.stringify((await placed(cv.id)).map((n) => n.nodeId === X ? "X" : n.nodeId === Y ? `Y@${n.y}` : n.nodeId === Z ? "Z" : "?"));
  out.devBShowsZ = String(await pb.locator(`.react-flow__node[data-id="${Z}"]`).count());
  // The offline move replays as a card upsert: Y moved down, and device A's Z
  // (added meanwhile) is kept rather than overwritten by B's stale layout.
  const after = await placed(cv.id);
  expect(after.find((n) => n.nodeId === Y)?.y ?? 0, "B's offline drag reached the server").toBeGreaterThan(100);
  expect(after.some((n) => n.nodeId === Z), "A's card survives B's replay").toBe(true);
  await devB.close();

  // ── 2) Quick-create entries on an empty board ───────────────────────────
  const seed = await mk(`QSeed ${stamp}`);
  const qb = await (await page.request.post("/api/canvases", { ...H, data: { title: `C02Quick ${stamp}` } })).json();
  await seedLayout(page.request, qb.id, { ...H, data: { data: { nodes: [{ nodeId: seed, x: 0, y: 0, width: 200 }] } } });
  await openBoard(page, qb.id);
  const pane = page.locator(".react-flow__pane");
  const pb2 = (await pane.boundingBox())!;
  const nodesCount = async () => ((await (await page.request.get("/api/bootstrap?slim=1")).json()).nodes as unknown[]).length;
  let n0 = await nodesCount();
  await page.mouse.dblclick(pb2.x + pb2.width * 0.6, pb2.y + pb2.height * 0.6);
  await page.waitForTimeout(2500);
  out.dblclickCreate = JSON.stringify({ dNotes: (await nodesCount()) - n0, placed: (await placed(qb.id)).length, editing: await page.locator(".card-node--editing").count() });
  await page.keyboard.press("Escape");
  await page.locator(".react-flow__pane").click({ position: { x: 30, y: 30 }, force: true });
  n0 = await nodesCount();
  await page.locator('button[title="New card — click canvas (C)"]').click();
  await page.mouse.click(pb2.x + pb2.width * 0.3, pb2.y + pb2.height * 0.75);
  await page.waitForTimeout(2500);
  out.toolbarCreate = JSON.stringify({ dNotes: (await nodesCount()) - n0, placed: (await placed(qb.id)).length });
  await page.keyboard.press("Escape");
  n0 = await nodesCount();
  await page.mouse.click(pb2.x + pb2.width * 0.8, pb2.y + pb2.height * 0.3, { button: "right" });
  await page.waitForTimeout(500);
  const createHere = page.locator(".ctx-menu").getByRole("menuitem", { name: "Create node here" });
  out.ctxMenu = (await page.locator(".ctx-menu").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 120);
  if (await createHere.count()) { await createHere.click(); await page.waitForTimeout(2500); }
  out.ctxCreate = JSON.stringify({ dNotes: (await nodesCount()) - n0, placed: (await placed(qb.id)).length });
  // Quick double double-click: two cards or one?
  await page.keyboard.press("Escape");
  n0 = await nodesCount();
  await page.mouse.dblclick(pb2.x + pb2.width * 0.15, pb2.y + pb2.height * 0.4);
  await page.mouse.dblclick(pb2.x + pb2.width * 0.15, pb2.y + pb2.height * 0.4);
  await page.waitForTimeout(3000);
  out.doubleDblclick = JSON.stringify({ dNotes: (await nodesCount()) - n0, placed: (await placed(qb.id)).length });

  // ── 3) Refused note create (403) ─────────────────────────────────────────
  await openBoard(page, qb.id);
  const p0 = (await placed(qb.id)).length; n0 = await nodesCount();
  await page.route("**/api/nodes", (r) => r.request().method() === "POST" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  await page.mouse.dblclick(pb2.x + pb2.width * 0.45, pb2.y + pb2.height * 0.85);
  await page.waitForTimeout(2500);
  out.create403 = JSON.stringify({ dNotes: (await nodesCount()) - n0, dPlaced: (await placed(qb.id)).length - p0, cardsOnScreen: await page.locator(".react-flow__node").count(), toast: (await page.locator(".toast").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").slice(0, 140) });
  await page.unroute("**/api/nodes");

  // ── 4) Offline create + place, then reconnect ───────────────────────────
  await openBoard(page, qb.id);
  const p1 = (await placed(qb.id)).length; n0 = await nodesCount();
  await context.setOffline(true);
  await page.waitForTimeout(600);
  await page.mouse.dblclick(pb2.x + pb2.width * 0.7, pb2.y + pb2.height * 0.85);
  await page.waitForTimeout(800);
  await page.keyboard.type(`Offline card ${stamp}`);
  await page.locator(".react-flow__pane").click({ position: { x: 30, y: 30 }, force: true });
  await page.waitForTimeout(1500);
  out.offlineUi = JSON.stringify({ cards: await page.locator(".react-flow__node").count(), sync: (await syncLabel(page)).replace(/\s+/g, " ").slice(0, 60) });
  await context.setOffline(false);
  await page.waitForTimeout(10_000);
  const boot = (await (await page.request.get("/api/bootstrap?slim=1")).json()).nodes as Array<{ id: string; title: string }>;
  const offNotes = boot.filter((n) => n.title.includes(`Offline card ${stamp}`));
  const pl = await placed(qb.id);
  out.offlineReplay = JSON.stringify({ dNotes: boot.length - n0, titled: offNotes.length, dPlaced: pl.length - p1, placedHasIt: offNotes.some((n) => pl.some((p) => p.nodeId === n.id)) });
  // The URL follows the selected card's note after a create, so a bare reload
  // would open that note; reopen the board itself.
  await openBoard(page, qb.id);
  out.afterReloadCards = `${await page.locator(".react-flow__node").count()} placed=${(await placed(qb.id)).length}`;
  } finally {
    await context.setOffline(false).catch(() => {});
    console.log("CAN02 " + JSON.stringify(out, null, 2));
  }
});
