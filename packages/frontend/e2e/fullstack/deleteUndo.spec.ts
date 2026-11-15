import { test, expect } from "@playwright/test";
import { ready, seedNodes } from "./helpers";

// REGRESSION [delete-undo] — deleting a node shows a toast with an Undo button;
// tapping it must POST /undelete and bring the node back. User reports the Undo
// button "does nothing" on the phone — reproduce the click path deterministically.

test("delete toast Undo restores the node", async ({ page }) => {
  const undeleteCalls: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/api\/nodes\/[^/]+\/undelete/.test(r.url())) undeleteCalls.push(r.url());
  });

  const token = `delundo-${Date.now()}`;
  const [nodeId] = await seedNodes(page, 1, { token, title: () => `${token} note` });
  await ready(page, `/?view=notes&node=${nodeId}`);
  await expect(page.locator(".obsidian-title-input")).toHaveValue(`${token} note`);

  // Delete from the opened note's action menu. API-seeded nodes need not have
  // reached the sidebar's local search index before this user path is ready.
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();

  // Toast with the Undo action appears.
  const undo = page.locator(".toast-action");
  await expect(undo).toBeVisible({ timeout: 10_000 });
  await undo.click();

  // The undelete endpoint must have been hit, and the node must come back.
  await expect.poll(() => undeleteCalls.length, { timeout: 10_000 }).toBeGreaterThan(0);

  // Server truth: the node is no longer soft-deleted.
  await expect.poll(async () => {
    const r = await page.request.get("/api/bootstrap?bodies=none");
    const b = await r.json();
    return (b.nodes as Array<{ title: string }>).some((n) => n.title === `${token} note`);
  }, { timeout: 10_000 }).toBe(true);
});
