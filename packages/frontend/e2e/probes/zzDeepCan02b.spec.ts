// CAN-02 follow-up (2026-10-08): on a board whose centre is empty, (a) a
// double-click card create refused with 403, (b) an offline double-click
// create followed by typing into the new card, then reconnect: is the typed
// text kept, and is there exactly one note + one placement?
import { test } from "@playwright/test";
import { ready, seedLayout, BASE, H } from "../fullstack/helpers";


test("CAN-02b: refused and offline quick create", async ({ page, context }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const mk = async (title: string) => (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: `${title} body` } })).json()).id as string;
  const A = await mk(`FarA ${stamp}`), B = await mk(`FarB ${stamp}`);
  const cv = await (await page.request.post("/api/canvases", { ...H, data: { title: `C02b ${stamp}` } })).json();
  await seedLayout(page.request, cv.id, { ...H, data: { data: { nodes: [{ nodeId: A, x: 0, y: 0, width: 200 }, { nodeId: B, x: 1600, y: 1000, width: 200 }] } } });
  const placed = async () => ((await (await page.request.get(`/api/canvases/${cv.id}`)).json()).data.nodes as Array<{ nodeId: string }>);
  const reqs: string[] = [];
  page.on("request", (r) => { if (["POST", "PATCH"].includes(r.method()) && /\/api\/(nodes|canvases)/.test(r.url())) reqs.push(`${r.method()} ${r.url().replace(BASE, "").slice(0, 60)}`); });
  page.on("response", (r) => { if (["POST", "PATCH"].includes(r.request().method()) && /\/api\/(nodes|canvases)/.test(r.url())) reqs.push(`→ ${r.status()}`); });
  await ready(page, `/?view=notes&node=${cv.id}`);
  await page.locator(".react-flow__node").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2500);
  const pb = (await page.locator(".react-flow__pane").boundingBox())!;
  const cx = pb.x + pb.width / 2, cy = pb.y + pb.height / 2;
  out.centerHit = await page.evaluate(({ x, y }) => (document.elementFromPoint(x, y) as HTMLElement)?.className?.toString().slice(0, 50), { x: cx, y: cy });

  await page.route("**/api/nodes", (r) => r.request().method() === "POST" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  reqs.length = 0;
  await page.mouse.dblclick(cx, cy);
  await page.waitForTimeout(2500);
  out.create403 = { reqs: [...reqs], placed: (await placed()).length, cards: await page.locator(".react-flow__node").count(), toast: (await page.locator(".toast").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").slice(0, 140), recovery: (await page.locator(".failed-write-recovery").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 100) };
  await page.unroute("**/api/nodes");
  await page.reload(); await page.locator(".react-flow__node").first().waitFor({ timeout: 30_000 }); await page.waitForTimeout(2500);
  const min = page.getByRole("button", { name: "Minimize recovery panel" });
  if (await min.isVisible().catch(() => false)) await min.click();

  reqs.length = 0;
  await context.setOffline(true);
  await page.waitForTimeout(600);
  await page.mouse.dblclick(cx + 60, cy + 40);
  await page.waitForTimeout(1000);
  out.offlineEditing = await page.locator(".card-node--editing").count();
  await page.keyboard.type(`typed offline ${stamp}`);
  await page.waitForTimeout(500);
  await page.mouse.click(pb.x + 20, pb.y + pb.height - 20);
  await page.waitForTimeout(2000);
  out.offlineCardText = (await page.locator(".react-flow__node").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").slice(0, 60)).filter((t) => !/Far[AB]/.test(t));
  await context.setOffline(false);
  await page.waitForTimeout(12_000);
  out.reqsOfflineReplay = [...reqs];
  const pl = await placed();
  const boot = (await (await page.request.get("/api/bootstrap?slim=1")).json()).nodes as Array<{ id: string; title: string }>;
  const newIds = pl.map((p) => p.nodeId).filter((id) => id !== A && id !== B);
  out.afterReplay = { placed: pl.length, newNotes: await Promise.all(newIds.map(async (id) => { const n = await (await page.request.get(`/api/nodes/${id}`)).json(); return { title: n.title, md: n.markdown }; })), typedAnywhere: boot.filter((n) => n.title.includes(`typed offline ${stamp}`)).length };
  console.log("CAN02B " + JSON.stringify(out, null, 2));
});
