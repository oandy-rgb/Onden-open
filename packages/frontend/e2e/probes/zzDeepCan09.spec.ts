// Feature-audit deepening (2026-10-08): CAN-09 — .canvas import/export edges
// through the real toolbar input: invalid files write nothing, an edge API
// failure mid-import (partial creation), importing the same file twice,
// export after a refused card edit, explicit heights, and the phone toolbar.
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { ready, seedLayout, boardMoreItem, BASE, H } from "../fullstack/helpers";


test("CAN-09: .canvas import/export — invalid, partial, repeat, refused edit, phone", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const out: Record<string, string> = {};
  const counts = async () => {
    const boot = await (await page.request.get("/api/bootstrap?slim=1")).json();
    const boards = (await (await page.request.get("/api/canvases")).json()) as Array<{ id: string; title: string }>;
    return { nodes: (boot.nodes as unknown[]).length, edges: (boot.edges as unknown[]).length, boards: boards.length, boardList: boards };
  };
  const toasts = async (p: Page = page) => (await p.locator(".toast").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").slice(0, 200);
  const fixture = (tag: string) => ({
    nodes: [
      { id: "a", type: "text", x: 0, y: 0, width: 260, height: 270, text: `# ${tag} A\n\nalpha body ${tag}` },
      { id: "b", type: "text", x: 400, y: 0, width: 260, height: 140, text: `beta body ${tag}` },
      { id: "g", type: "group", x: -40, y: -60, width: 800, height: 500, label: `Grp ${tag}` },
    ],
    edges: [{ id: "e", fromNode: "a", toNode: "b" }],
  });
  const importFile = async (name: string, content: string) => {
    await page.locator(".canvas-import-input").setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(content) });
    await page.waitForTimeout(3000);
  };
  try {
  const seedNote = await (await page.request.post("/api/nodes", { ...H, data: { title: `C09Seed ${stamp}`, markdown: "seed" } })).json();
  const seed = await (await page.request.post("/api/canvases", { ...H, data: { title: `C09Seed board ${stamp}` } })).json();
  await seedLayout(page.request, seed.id, { ...H, data: { data: { nodes: [{ nodeId: seedNote.id, x: 10, y: 10, width: 240 }] } } });
  const openSeed = async () => { await ready(page, `/?view=notes&node=${seed.id}`); await page.locator(".react-flow__node").first().waitFor({ timeout: 30_000 }); await page.waitForTimeout(600); };
  await openSeed();

  // Invalid inputs write nothing.
  const invalid: Record<string, string> = {
    notJson: "this is not json",
    dupIds: JSON.stringify({ nodes: [{ id: "x", type: "text", x: 0, y: 0, width: 100, height: 100, text: "one" }, { id: "x", type: "text", x: 0, y: 0, width: 100, height: 100, text: "two" }], edges: [] }),
    badSize: JSON.stringify({ nodes: [{ id: "x", type: "text", x: 0, y: 0, width: -5, height: 100, text: "neg" }], edges: [] }),
    danglingEdge: JSON.stringify({ nodes: [{ id: "x", type: "text", x: 0, y: 0, width: 100, height: 100, text: "one" }], edges: [{ id: "e", fromNode: "x", toNode: "nope" }] }),
    empty: JSON.stringify({ nodes: [], edges: [] }),
  };
  for (const [k, content] of Object.entries(invalid)) {
    const before = await counts();
    await importFile(`${k}.canvas`, content);
    const after = await counts();
    out[`invalid_${k}`] = JSON.stringify({ dNodes: after.nodes - before.nodes, dBoards: after.boards - before.boards, toast: await toasts(), url: page.url().includes(seed.id) });
    await openSeed();
  }

  // Valid import, explicit height 270, then export round-trip.
  let before = await counts();
  await importFile(`Plan ${stamp}.canvas`, JSON.stringify(fixture(`P${stamp}`)));
  let after = await counts();
  const plan = after.boardList.find((b) => b.title === `Plan ${stamp}`);
  out.validImport = JSON.stringify({ dNodes: after.nodes - before.nodes, dEdges: after.edges - before.edges, dBoards: after.boards - before.boards, opened: plan ? page.url().includes(plan.id) : false });
  if (plan) {
    await ready(page, `/?view=notes&node=${plan.id}`);
    await page.locator(".react-flow__node").first().waitFor({ timeout: 30_000 });
    const [dl] = await Promise.all([page.waitForEvent("download"), boardMoreItem(page, "Export board (.canvas)").then((b) => b.click())]);
    const exp = JSON.parse(readFileSync((await dl.path())!, "utf8"));
    out.export = JSON.stringify({ file: dl.suggestedFilename(), nodes: (exp.nodes as Array<{ type: string; height: number; text?: string; label?: string }>).map((n) => `${n.type}:${n.height}:${(n.text ?? n.label ?? "").replace(/\s+/g, " ").slice(0, 24)}`), edges: (exp.edges as unknown[]).length });
  }

  // Import the same file again: duplicates?
  await openSeed();
  before = await counts();
  await importFile(`Plan ${stamp}.canvas`, JSON.stringify(fixture(`P${stamp}`)));
  after = await counts();
  out.repeatImport = JSON.stringify({ dNodes: after.nodes - before.nodes, dBoards: after.boards - before.boards, sameTitleBoards: after.boardList.filter((b) => b.title === `Plan ${stamp}`).length, toast: await toasts() });

  // Edge API failure mid-import: partial creation.
  await openSeed();
  before = await counts();
  await page.route("**/api/edges", (r) => r.request().method() === "POST" ? r.fulfill({ status: 503, body: "{}" }) : r.continue());
  await importFile(`Partial ${stamp}.canvas`, JSON.stringify(fixture(`Q${stamp}`)));
  await page.unroute("**/api/edges");
  after = await counts();
  out.edge503Import = JSON.stringify({ dNodes: after.nodes - before.nodes, dEdges: after.edges - before.edges, dBoards: after.boards - before.boards, board: after.boardList.some((b) => b.title === `Partial ${stamp}`), toast: await toasts(), url: page.url().includes(seed.id) });

  // Export right after a refused card edit (403).
  const r1 = await (await page.request.post("/api/nodes", { ...H, data: { title: `C09Ref ${stamp}`, markdown: "server text" } })).json();
  const rb = await (await page.request.post("/api/canvases", { ...H, data: { title: `C09Ref board ${stamp}` } })).json();
  await seedLayout(page.request, rb.id, { ...H, data: { data: { nodes: [{ nodeId: r1.id, x: 40, y: 40, width: 260 }] } } });
  await ready(page, `/?view=notes&node=${rb.id}`);
  await page.locator(".react-flow__node").first().waitFor({ timeout: 30_000 });
  await page.route(`**/api/nodes/${r1.id}`, (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  await page.locator(`.react-flow__node[data-id="${r1.id}"]`).dblclick({ position: { x: 130, y: 50 } });
  await page.waitForTimeout(400);
  await page.keyboard.press("Control+End"); await page.keyboard.type(" REFUSED");
  await page.locator(".react-flow__pane").click({ position: { x: 700, y: 400 }, force: true });
  await page.waitForTimeout(2000);
  const [dl2] = await Promise.all([page.waitForEvent("download", { timeout: 15_000 }).catch(() => null), boardMoreItem(page, "Export board (.canvas)").then((b) => b.click())]);
  if (dl2) {
    const e2 = JSON.parse(readFileSync((await dl2.path())!, "utf8"));
    out.exportAfterRefusal = JSON.stringify({ texts: (e2.nodes as Array<{ text?: string }>).map((n) => n.text ?? ""), cardShows: (await page.locator(`.react-flow__node[data-id="${r1.id}"]`).innerText()).replace(/\s+/g, " ").slice(0, 80) });
  } else out.exportAfterRefusal = `no download; toast=${await toasts()}`;
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // Phone: toolbar import/export reachable.
  const phone = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
  const pp = await phone.newPage();
  await ready(pp, `/?view=notes&node=${seed.id}`);
  await pp.waitForTimeout(2500);
  const exp = await boardMoreItem(pp, "Export board (.canvas)");
  const imp = pp.getByRole("menuitem", { name: "Import .canvas file", exact: true });
  const eb = await exp.boundingBox().catch(() => null);
  out.phoneToolbar = JSON.stringify({ exportVisible: await exp.isVisible().catch(() => false), importVisible: await imp.isVisible().catch(() => false), exportBox: eb ? `${Math.round(eb.x)},${Math.round(eb.y)} ${Math.round(eb.width)}x${Math.round(eb.height)}` : null, sw: await pp.evaluate(() => document.documentElement.scrollWidth) });
  if (await exp.isVisible().catch(() => false)) {
    const d = await Promise.all([pp.waitForEvent("download", { timeout: 15_000 }).catch(() => null), exp.click()]).then(([x]) => x);
    out.phoneExport = d ? d.suggestedFilename() : "no download";
  }
  await phone.close();
  } finally {
    console.log("CAN09 " + JSON.stringify(out, null, 2));
  }
});
