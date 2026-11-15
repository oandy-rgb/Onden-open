// ⑨ image cards on the board — a note whose whole body is a single image now
// renders as a FILLED image card (Heptabase/Miro-style), not a markdown
// preview clamped to three lines with the picture cut off.
import { test, expect } from "@playwright/test";
import { ready, seedLayout, H } from "./helpers";

// A 1×1 transparent PNG as a self-contained data URL (no upload needed).
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("a single-image note renders as a filled image card", async ({ page }) => {
  const stamp = Date.now();
  const imgNote = await (await page.request.post("/api/nodes", { ...H, data: { title: `Pic ${stamp}`, markdown: `![a pic](${PNG})` } })).json();
  const textNote = await (await page.request.post("/api/nodes", { ...H, data: { title: `Txt ${stamp}`, markdown: "just some prose, not an image" } })).json();
  const canvas = await (await page.request.post("/api/canvases", { ...H, data: { title: `Img board ${stamp}` } })).json();
  await seedLayout(page.request, canvas.id, { ...H, data: { data: {
    nodes: [
      { nodeId: imgNote.id, x: 100, y: 100, width: 240 },
      { nodeId: textNote.id, x: 420, y: 100, width: 240 },
    ], edges: [],
  } } });

  await ready(page, `/?view=notes&node=${canvas.id}`);
  await expect(page.locator(".react-flow__node")).toHaveCount(2, { timeout: 30_000 });

  // The image note is a filled image card, not a clamped markdown preview.
  const img = page.locator(".card-node-image img");
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("src", PNG);

  // Exactly one image card; the prose note still renders as a markdown preview.
  await expect(page.locator(".card-node-image")).toHaveCount(1);
  await expect(page.locator('.card-node-preview:has-text("just some prose")')).toBeVisible();
});
