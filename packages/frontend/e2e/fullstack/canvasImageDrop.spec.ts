// ⑨ drop a picture on the board — dropping an image file onto a canvas
// uploads it (/api/media), mints a single-image note, and places it as a
// filled image card (the Heptabase gesture). Previously the drop handler only
// understood notes dragged from the sidebar and ignored files.
import { test, expect } from "@playwright/test";
import { ready, H, PNG_1X1_B64 } from "./helpers";

const PNG_B64 = PNG_1X1_B64; // a real image: the server decodes uploads

test("dropping an image file on the board creates an image card", async ({ page }) => {
  const stamp = Date.now();
  const canvas = await (await page.request.post("/api/canvases", { ...H, data: { title: `Drop board ${stamp}` } })).json();
  await ready(page, `/?view=notes&node=${canvas.id}`);
  const panel = page.locator(".graph-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".card-node-image")).toHaveCount(0); // empty board

  // Build a real DataTransfer carrying a PNG File and fire the drop.
  const dt = await page.evaluateHandle((b64) => {
    const bin = atob(b64);
    const arr = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const file = new File([arr], "dropped.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    return dt;
  }, PNG_B64);
  await panel.dispatchEvent("drop", { dataTransfer: dt, clientX: 520, clientY: 340 });

  // An image card lands on the board…
  await expect(page.locator(".card-node-image img")).toBeVisible({ timeout: 15_000 });
  // …and it's a real persisted note on the canvas (placement saved).
  await expect.poll(async () => {
    const saved = await (await page.request.get(`/api/canvases/${canvas.id}`, H)).json();
    return (saved.data.nodes as unknown[]).length;
  }, { timeout: 10_000 }).toBe(1);
});
