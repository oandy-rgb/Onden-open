import { test, expect } from "@playwright/test";
import { ready, H } from "./helpers";

// The whiteboard (白板) is a view module: a way of arranging notes that carries no data of
// its own, so it is always on (2026-10-28, workspaceModules `alwaysOn`). The owner cannot
// remove it; the board lens, its feature card and canvas notes stay.

test("the whiteboard cannot be removed: the server refuses and every board entry stays", async ({ page }) => {
  const stamp = Date.now();
  const tagId = (await (await page.request.post("/api/tags/resolve-path", { ...H, data: { path: `Board tag ${stamp}` } })).json()).leaf_id as string;
  const canvas = await (await page.request.post("/api/canvases", { ...H, data: { title: `Board ${stamp}` } })).json() as { id: string };
  try {
    const removal = await page.request.patch("/api/workspace/modules", { ...H, data: { module: "canvas", imported: false } });
    expect(removal.status()).toBe(400);

    await ready(page, `/?view=notes&node=${tagId}`);
    await expect(page.locator(".schema-lens-title")).toHaveText(`#Board tag ${stamp}`);
    await ready(page, `/?view=notes&node=${canvas.id}`);
    await expect(page.locator(".react-flow")).toBeVisible();
    await expect(page.getByText("“Canvas” is not imported")).toHaveCount(0);

  } finally {
    for (const id of [canvas.id, tagId]) await page.request.delete(`/api/nodes/${id}`, H);
  }
});
