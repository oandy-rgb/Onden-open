import { test, expect } from "@playwright/test";
import { ready, seedLayout, H } from "./helpers";

// Canvas liveliness regression: excerpt cards render their quote as a
// quotation block, edges stay quiet until a connected card is selected, and
// relation names are reader-facing words — never schema identifiers.

test("canvas excerpts: quote cards, quiet edges, human relation names", async ({ page }) => {
  const stamp = Date.now();
  const src = (await (await page.request.post("/api/nodes", { ...H, data: { title: `JIT Paper ${stamp}`, markdown: "the source pdf" } })).json()) as { id: string };
  const childIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const child = (await (await page.request.post("/api/nodes", {
      ...H,
      data: {
        title: `Excerpt ${i} ${stamp}`,
        markdown: `> Dynamic languages such as JavaScript are more difficult to compile than statically typed ones (${i}).\n\n— page ${i + 2}`,
        parent_id: src.id,
      },
    })).json()) as { id: string };
    await page.request.post("/api/edges", { ...H, data: { source_node_id: child.id, target_node_id: src.id, edge_type: "highlight_source" } });
    childIds.push(child.id);
  }

  // A named canvas with POSITIONLESS members (programmatic add) — the path
  // that used to stack/grid cards mechanically; now they fan around the
  // source card.
  const canvas = (await (await page.request.post("/api/canvases", { ...H, data: { title: `Study ${stamp}` } })).json()) as { id: string };
  const members = [
    { nodeId: src.id, x: 480, y: 80 },
    ...childIds.map((id, i) => ({ nodeId: id, x: 120 + (i % 3) * 380, y: 360 + Math.floor(i / 3) * 300 })),
  ];
  await seedLayout(page.request, canvas.id, { ...H, data: { data: { nodes: members } } });

  await ready(page, `/?view=notes&node=${canvas.id}`);

  // Excerpt cards render their quote BODY as a quotation block.
  const excerpt = page.locator(".card-node", { hasText: "Dynamic languages such as JavaScript" }).first();
  await expect(excerpt).toBeVisible();
  await expect(excerpt.locator(".card-md-preview blockquote").first()).toBeVisible();

  // fitView is a JS-driven (d3-zoom) animation, not CSS — wait until the
  // viewport transform stops changing between samples instead of sleeping.
  const viewport = page.locator(".react-flow__viewport");
  let prevTransform = "";
  await expect
    .poll(async () => {
      const cur = (await viewport.getAttribute("style")) ?? "";
      const settled = cur === prevTransform;
      prevTransform = cur;
      return settled;
    }, { intervals: [250, 250, 250, 250, 500, 500, 1000], message: "canvas fitView never settled" })
    .toBe(true);
  await page.screenshot({ path: "/tmp/pw-output/shots/canvas-vibe-board.png", fullPage: false });

  await excerpt.click();
  // Selecting a connected card reveals the HUMAN relation name — the edge
  // manifest's label (backend edgeManifest, D39 one vocabulary)… (this IS the
  // post-click render wait)
  await expect(page.getByText("excerpt of", { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: "/tmp/pw-output/shots/canvas-vibe-selected.png", fullPage: false });
  // …and the schema name never renders anywhere on the board.
  await expect(page.getByText("highlight_source", { exact: true })).toHaveCount(0);
});
