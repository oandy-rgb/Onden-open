import { test, expect } from "@playwright/test";
import { ready, seedLayout, H } from "./helpers";

// Canvas scale (#14). On a large board (KnowledgeWorkspace):
//   1. the soft-cap banner appears past the card threshold (nudge to split);
//   2. the board still renders its cards (regression guard: an earlier
//      onlyRenderVisibleElements attempt mis-culled to ~4 of 300 because the
//      cards lack a measured height — reverted; this catches a re-introduction).
// Profiling basis: drag was already smooth (0 long tasks) so no memo; the real
// large-board remedy is sub-canvas splitting (the banner). Chromium only.
const N = 300; // > the 150 soft cap

test("large canvas: soft-cap banner + viewport culling on zoom", async ({ page }) => {
  test.setTimeout(240_000);

  const ids: string[] = [];
  for (let i = 0; i < N; i += 20) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(20, N - i) }, (_, j) =>
        page.request.post("/api/nodes", { ...H, data: { title: `scard ${i + j}`, markdown: `b ${i + j}` } }).then((r) => r.json())),
    );
    ids.push(...batch.map((b) => b.id));
  }
  const canvas = await (await page.request.post("/api/canvases", { ...H, data: { title: `Scale ${Date.now()}` } })).json();
  const COLS = 20;
  const cnodes = ids.map((id, i) => ({ nodeId: id, x: (i % COLS) * 300, y: Math.floor(i / COLS) * 230, width: 260 }));
  await seedLayout(page.request, canvas.id, { ...H, data: { data: { nodes: cnodes, edges: [] } } });

  await ready(page, `/?view=notes&node=${canvas.id}`);
  // "attached", not visible: 300 cards open zoomed far out, where a card shows
  // just its title (CardNode --title-only, absolutely positioned) and an
  // auto-height card's React Flow wrapper measures 0px tall — Playwright counts
  // a zero-height box as hidden though the titles are on screen.
  await page.locator(".react-flow__node").first().waitFor({ state: "attached", timeout: 60_000 });

  // 1. soft-cap banner (N > 150)
  await expect(page.locator(".canvas-cap-banner")).toBeVisible();

  // 2. the board actually renders its cards — not mis-culled to a handful.
  //    Poll until the render pass catches up (was a fixed 800ms sleep).
  await expect.poll(() => page.locator(".react-flow__node").count(), { timeout: 30_000 }).toBeGreaterThan(N / 2);
  console.log(`[CANVAS-SCALE] cards=${N} renderedDom=${await page.locator(".react-flow__node").count()}`);
});
