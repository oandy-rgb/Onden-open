import { test, expect } from "@playwright/test";
import { ready, BASE, H } from "./helpers";

// The phone's Info screen = the inspector. The note page has no Info *tab* since
// 2026-10-18: its tags are the one row under the title (chips + "+ Tag"), and a
// chip opens that tag's card right below the row. There is no separate "Tags"
// toggle. The one way to Info is the Info button beside ⋯ in the note's header
// (docs/agents/decisions-ui.md 2026-10-27, 「手機（≤ 900px）不變（B 版）」).


test.describe("mobile info tab", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the note page has no Info tab or Tags toggle (one Info button); a tag chip opens its card", async ({ page }, testInfo) => {
    const stamp = Date.now();
    const node = await (await page.request.post("/api/nodes", {
      ...H, data: { title: `Info probe ${stamp}`, markdown: "hello info" },
    })).json() as { id: string };
    const tagName = `infoprobe${stamp}`;
    const tagId = (await (await page.request.post("/api/tags/resolve-path", { ...H, data: { path: tagName } })).json()).leaf_id as string;
    expect((await page.request.put(`/api/nodes/${node.id}/tags/${tagId}`, H)).ok()).toBe(true);
    try {
      await page.addInitScript(() => {
        window.localStorage.setItem("onden.inspectorOpen", "0");
        window.localStorage.setItem("onden.inspectorCollapsed", "1");
      });
      await ready(page, `/?view=notes&node=${node.id}`);
      // No Info tab among the note's tabs; the one Info button sits beside ⋯.
      await expect(page.getByRole("tab", { name: "Info", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Info", exact: true })).toHaveCount(1);
      const row = page.locator(".note-document .title-tag-row");
      await expect(row.locator(".prop-tag--add")).toHaveCount(1);
      const chip = row.getByRole("button", { name: `#${tagName}`, exact: true });
      await expect(chip).toHaveAttribute("aria-expanded", "false");
      await chip.click();
      await expect(chip).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator(".note-meta-cards").getByRole("region", { name: `#${tagName}` })).toBeVisible({ timeout: 15_000 });
      await page.screenshot({ path: testInfo.outputPath("note-tags-block.png") });
      await chip.click();
      await expect(page.locator(".note-meta-cards")).toHaveCount(0);
    } finally {
      await page.request.delete(`/api/nodes/${node.id}`, H).catch(() => {});
      await page.request.delete(`/api/nodes/${tagId}`, H).catch(() => {});
    }
  });
});
