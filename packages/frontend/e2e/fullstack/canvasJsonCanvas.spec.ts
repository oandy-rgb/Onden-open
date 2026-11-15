// ⑦ JSON Canvas (jsoncanvas.org) interchange: import a .canvas file → notes
// are created through the normal API and a new board carries their
// placements + groups + edges; export the board → a valid JSON Canvas file
// round-trips the same structure.
import { test, expect } from "@playwright/test";
import { ready, seedLayout, boardMoreItem, H } from "./helpers";

const FIXTURE = {
  nodes: [
    // n1 carries a hex colour; n2 a preset index "2" (→ Onden orange) — both
    // must survive the round-trip, which was the colour-dropping bug.
    { id: "n1", type: "text", x: 0, y: 0, width: 260, height: 140, text: "# Alpha note\n\nbody of alpha", color: "#3b82f6" },
    { id: "n2", type: "text", x: 400, y: 200, width: 260, height: 140, text: "plain second card", color: "2" },
    { id: "n3", type: "link", x: 0, y: 400, width: 260, height: 80, url: "https://example.com/ref" },
    { id: "g1", type: "group", x: -40, y: -60, width: 800, height: 700, label: "Research", color: "#22c55e" },
  ],
  edges: [{ id: "e1", fromNode: "n1", toNode: "n2" }],
};

test("import .canvas → board with cards/group/edge; export round-trips", async ({ page }) => {
  await ready(page);

  // reach a board surface so the canvas toolbar exists: create empty canvas via UI? use API + URL
  const seedNote = await (await page.request.post("/api/nodes", { ...H, data: { title: `JcSeed ${Date.now()}`, markdown: "x" } })).json();
  const seed = await (await page.request.post("/api/canvases", { ...H, data: { title: "JcSeed board" } })).json();
  await seedLayout(page.request, seed.id, { ...H, data: { data: { nodes: [{ nodeId: seedNote.id, x: 10, y: 10, width: 240 }], edges: [] } } });
  await ready(page, `/?view=notes&node=${seed.id}`);
  await page.locator(".react-flow__node").first().waitFor({ timeout: 30_000 });

  // import the fixture through the toolbar input
  await page.locator(".canvas-import-input").setInputFiles({
    name: "Imported Plan.canvas",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(FIXTURE)),
  });

  // the new board opens with 3 cards + 1 group. NB: card TITLES render as
  // input values (not text nodes), so has-text must target the BODY text.
  await expect(page.locator(".react-flow__node")).toHaveCount(4, { timeout: 20_000 });
  await expect(page.locator('.react-flow__node:has-text("body of alpha")')).toBeVisible();
  await expect(page.locator('.react-flow__node:has-text("plain second card")')).toBeVisible();
  await expect(page.locator('.react-flow__node:has-text("example.com")')).toBeVisible();
  await page.screenshot({ path: "/tmp/pw-output/jc-board.png" });

  // persisted: canvas has 3 entries + 1 section; the knowledge edge exists
  const canvases = await (await page.request.get("/api/canvases", H)).json() as Array<{ id: string; title: string }>;
  const imported = canvases.find((c) => c.title === "Imported Plan")!;
  expect(imported).toBeTruthy();
  const saved = await (await page.request.get(`/api/canvases/${imported.id}`, H)).json();
  expect((saved.data.nodes as unknown[]).length).toBe(3);
  expect((saved.data.sections as Array<{ title: string }>)[0].title).toBe("Research");
  // Colours survived import (hex passes through, preset "2" → Onden orange).
  const savedColors = (saved.data.nodes as Array<{ color?: string }>).map((n) => n.color).filter(Boolean).sort();
  expect(savedColors).toEqual(["#3b82f6", "#f97316"]);
  expect((saved.data.sections as Array<{ color?: string }>)[0].color).toBe("#22c55e");

  // export: toolbar download produces a valid JSON Canvas with the same shape
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    boardMoreItem(page, "Export board (.canvas)").then((b) => b.click()),
  ]);
  const path = await download.path();
  const exported = JSON.parse(require("node:fs").readFileSync(path!, "utf8"));
  const types = (exported.nodes as Array<{ type: string }>).map((n) => n.type).sort();
  expect(types).toEqual(["group", "text", "text", "text"]); // link imported as a note → exports as text
  expect((exported.edges as unknown[]).length).toBe(1);
  const alpha = (exported.nodes as Array<{ type: string; text?: string; color?: string }>).find((n) => n.text?.includes("Alpha note"))!;
  expect(alpha.text).toContain("body of alpha");
  // Colours export too — the round-trip is closed end to end.
  expect(alpha.color).toBe("#3b82f6");
  const grp = (exported.nodes as Array<{ type: string; color?: string }>).find((n) => n.type === "group")!;
  expect(grp.color).toBe("#22c55e");
});
