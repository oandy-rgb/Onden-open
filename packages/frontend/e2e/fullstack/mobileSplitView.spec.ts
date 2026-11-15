// A phone has no side by side (owner, 2026-11-08): an address with right= shows only the left note,
// and the phone neither opens nor writes the account's pane. Not run in the authoring session
// (needs the full stack): run with the other fullstack specs.
import { test, expect } from "@playwright/test";
import { ready, H } from "./helpers";

test.describe("phone: one note, no right side", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("right= is ignored and nothing of side by side is drawn", async ({ page }) => {
    const stamp = Date.now();
    const a = (await (await page.request.post("/api/nodes", { ...H, data: { title: `Phone left ${stamp}`, markdown: "left" } })).json()).id as string;
    const b = (await (await page.request.post("/api/nodes", { ...H, data: { title: `Phone right ${stamp}`, markdown: "right" } })).json()).id as string;
    await ready(page, `/?view=notes&node=${a}&right=${encodeURIComponent(`note:${b}:content`)}`);
    await expect(page.locator(".split-pane, .split-drop")).toHaveCount(0);
    await expect(page).not.toHaveURL(/right=/);
  });
});
