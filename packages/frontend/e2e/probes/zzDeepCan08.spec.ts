// Feature-audit deepening (2026-10-08): CAN-08 — the Links lens (local graph)
// and the Graph place (everything): relation list vs. graph threshold, opening
// a neighbour and coming back, refresh after a neighbour is deleted or its
// read access is revoked (second human), the whole-workspace graph's cost,
// and a phone rotated between portrait and landscape.
import { test, expect, type Page } from "@playwright/test";
import { ready, defaultSpaceId, hideFromOthers, addToDefaultSpace, BASE, H, PAGE } from "../fullstack/helpers";


test("CAN-08: local/global graph — list, navigation, refresh, revoke, scale, rotation", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const out: Record<string, string> = {};
  // Root notes in the default space so the second human can read them.
  const shared = await defaultSpaceId(page.request);
  const mk = async (title: string, extra: Record<string, unknown> = {}) => (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: `${title} body`, ...(extra.parent_id ? {} : { space_id: shared }), ...extra } })).json()).id as string;
  const link = (s: string, t: string) => page.request.post("/api/edges", { ...H, data: { source_node_id: s, target_node_id: t, edge_type: "knowledge_link" } });
  const openLinks = async (p: Page, id: string) => {
    // A note's own connections are the info panel's 「Relations」 tab.
    await ready(p, `/?view=notes&node=${id}`);
    await p.getByRole("tab", { name: "Relations", exact: true }).click({ timeout: 30_000 });
    await p.waitForTimeout(800);
  };
  const rows = (p: Page) => p.locator(".links-relation-row").allInnerTexts().then((a) => a.map((t) => t.replace(/\s+/g, " ").trim()));
  try {
  const N = await mk(`GN ${stamp}`);
  const A = await mk(`GA ${stamp}`), B = await mk(`GB ${stamp}`);
  const C = await mk(`GC ${stamp}`, { parent_id: N });
  await link(N, A); await link(B, N);
  await openLinks(page, N);
  out.list3 = JSON.stringify({ rows: await rows(page) });
  // Open a neighbour from the list, then browser Back.
  await page.locator(".links-relation-row", { hasText: `GA ${stamp}` }).click();
  await page.waitForTimeout(1200);
  out.openNeighbour = page.url().replace(BASE, "");
  await page.goBack();
  await page.waitForTimeout(1500);
  out.afterBack = JSON.stringify({ url: page.url().replace(BASE, ""), tabVisible: await page.getByRole("tab", { name: "Relations", exact: true }).isVisible().catch(() => false) });

  // Delete a neighbour elsewhere: the list should drop it without a reload.
  await openLinks(page, N);
  await page.request.delete(`/api/nodes/${B}`, { headers: PAGE });
  await page.waitForTimeout(6000);
  out.afterDeleteNoReload = JSON.stringify(await rows(page));
  await page.request.post(`/api/nodes/${B}/undelete`, { ...H, data: {} });
  await page.waitForTimeout(6000);
  out.afterUndeleteNoReload = JSON.stringify(await rows(page));

  // A fourth connection is still a list row (the tab never draws a graph); 「Full relations」 opens the graph page on this note.
  const D = await mk(`GD ${stamp}`);
  await link(N, D);
  await page.waitForTimeout(6000);
  out.fourConnections = JSON.stringify({ rows: (await rows(page)).length, canvasInTab: await page.locator("#info-panel-body canvas").count() });
  await page.getByRole("button", { name: "Full relations" }).click();
  await page.waitForTimeout(1500);
  out.fullRelations = JSON.stringify({ url: page.url().replace(BASE, ""), canvas: await page.locator(".all-cards-graph-wrap canvas").count() });
  await page.getByRole("button", { name: "Back to note" }).click();
  await page.waitForTimeout(1200);
  await openLinks(page, N);

  // Second human (editor) watching N's links; owner restricts A.
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const signup = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `C08g ${stamp}`, email: `c08g-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  const editorActor = await (await page.request.post("/api/actors", { ...H, data: { name: `C08g ${stamp}`, type: "human", external_id: signup.user.id } })).json();
  await addToDefaultSpace(page.request, editorActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
  const hp = await human.newPage();
  // Remove D again so the editor sees the same short list.
  const edges = (await (await page.request.get("/api/bootstrap?slim=1")).json()).edges as Array<{ id: string; source_node_id: string; target_node_id: string }>;
  const nd = edges.find((e) => e.source_node_id === N && e.target_node_id === D);
  if (nd) await page.request.delete(`/api/edges/${nd.id}`, { headers: PAGE });
  await openLinks(hp, N);
  await hp.waitForTimeout(1500);
  out.editorBefore = JSON.stringify(await rows(hp));
  await hideFromOthers(page.request, A);
  const t0 = Date.now();
  let gone = false;
  while (Date.now() - t0 < 20_000) { if (!(await rows(hp)).some((r) => r.includes(`GA ${stamp}`))) { gone = true; break; } await hp.waitForTimeout(500); }
  out.editorAfterRevoke = JSON.stringify({ gone, ms: Date.now() - t0, rows: await rows(hp) });
  await human.close();

  // Graph place: whole workspace.
  const total = ((await (await page.request.get("/api/bootstrap?slim=1")).json()).nodes as unknown[]).length;
  await ready(page, "/?view=notes");
  await page.evaluate(() => { (window as unknown as { __lt: number[] }).__lt = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) (window as unknown as { __lt: number[] }).__lt.push(e.duration); }).observe({ entryTypes: ["longtask"] }); });
  const g0 = Date.now();
  await page.goto(`${BASE}/?view=graph`);
  await page.locator(".node-lens-graph-body canvas").first().waitFor({ timeout: 60_000 }).catch(() => {});
  const firstPaint = Date.now() - g0;
  await page.waitForTimeout(4000);
  const lt = await page.evaluate(() => (window as unknown as { __lt?: number[] }).__lt ?? []).catch(() => [] as number[]);
  out.globalGraph = JSON.stringify({ workspaceNodes: total, canvasMs: firstPaint, canvas: await page.locator(".node-lens-graph-body canvas").count(), title: await page.locator(".node-lens-title").innerText().catch(() => ""), longTasksAfterNav: lt.length, longestMs: Math.round(Math.max(0, ...lt)) });
  // Drag on the graph canvas (pan / node drag) must not throw.
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(e.message));
  const cv = page.locator(".node-lens-graph-body canvas").first();
  const bb = await cv.boundingBox();
  if (bb) { await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.mouse.down(); await page.mouse.move(bb.x + bb.width / 2 + 120, bb.y + bb.height / 2 + 60, { steps: 10 }); await page.mouse.up(); await page.mouse.wheel(0, -400); }
  await page.waitForTimeout(1000);
  out.dragErrors = JSON.stringify(errs);

  // Phone portrait → landscape on the Links lens and the Graph place.
  const phone = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await phone.newPage();
  await ready(pp, "/?view=graph");
  await pp.locator(".node-lens-graph-body canvas").first().waitFor({ timeout: 60_000 }).catch(() => {});
  const dims = async () => pp.evaluate(() => { const c = document.querySelector(".node-lens-graph-body canvas") as HTMLCanvasElement | null; const b = document.querySelector(".node-lens-graph-body") as HTMLElement | null; return { canvas: c ? `${c.clientWidth}x${c.clientHeight}` : null, body: b ? `${b.clientWidth}x${b.clientHeight}` : null, sw: document.documentElement.scrollWidth, vw: innerWidth }; });
  out.phonePortrait = JSON.stringify(await dims());
  await pp.setViewportSize({ width: 844, height: 390 });
  await pp.waitForTimeout(1500);
  out.phoneLandscape = JSON.stringify(await dims());
  await pp.setViewportSize({ width: 390, height: 844 });
  await pp.waitForTimeout(1500);
  out.phoneBack = JSON.stringify(await dims());
  await phone.close();
  } finally {
    console.log("CAN08 " + JSON.stringify(out, null, 2));
  }
});
