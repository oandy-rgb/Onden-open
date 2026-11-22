import { test, expect } from "@playwright/test";
import { ready, renderSettled, titleTags, applyTagFromTitle, moduleTag, giveTagFunction, tagFunctionEntry, phoneNotesHome, BASE, H } from "./helpers";


test("configure a tag, apply it without losing the note, and remove only this note's membership", async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(new URL(BASE).hostname);
  expect(["5099", "5100"]).toContain(new URL(BASE).port);
  const name = `功能課程-${Date.now()}`;
  const response = await page.request.post("/api/tags/resolve-path", { ...H, data: { path: name } });
  expect(response.ok()).toBe(true);
  const { leaf_id: tagId } = await response.json();
  const create = async (title: string) => {
    const result = await page.request.post("/api/nodes", { ...H, data: { title, markdown: "Preserve this note." } });
    expect(result.ok()).toBe(true);
    return result.json();
  };
  const note = await create(`Tagged ${name}`);
  const other = await create(`Other ${name}`);
  const route = `**/api/nodes/${note.id}/tags/${tagId}`;
  try {
    const skillsTag = await moduleTag(page, "skills");
    await ready(page, "/?view=tags");
    await page.getByRole("button", { name: `Open #${name}`, exact: true }).click();
    await expect(page.locator(".schema-lens-title")).toHaveText(`#${name}`);
    // The tag gets Skills from the server (it extends its module tag). Review is no longer a tag
    // function: cards are a note's or paragraph's own reference since migration 195.
    await giveTagFunction(page, tagId, "skills", "Skills");
    expect((await page.request.put(`/api/nodes/${other.id}/tags/${tagId}`, { ...H, data: {} })).ok()).toBe(true);

    await ready(page, `/?view=notes&node=${note.id}`);
    const sources = titleTags(page);
    await applyTagFromTitle(page, name);
    await expect(sources.getByRole("button", { name: `#${name}`, exact: true })).toHaveCount(1);
    await expect(page.locator(".obsidian-sidebar").getByText(note.title, { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const boot = await (await page.request.get("/api/bootstrap")).json();
      const stored = boot.nodes.find((row: { id: string }) => row.id === note.id);
      return [...(stored.class_tag_ids ?? []), ...(stored.label_tag_ids ?? [])].includes(tagId);
    }).toBe(true);
    await page.reload();
    await expect(sources.getByRole("button", { name: `#${name}`, exact: true })).toBeVisible();
    await expect(page.locator(".obsidian-sidebar").getByText(note.title, { exact: true })).toBeVisible();

    let refused = false;
    await page.route(route, async request => {
      if (request.request().method() === "DELETE" && !refused) {
        refused = true;
        await request.fulfill({ status: 403, contentType: "application/json", body: '{"error":"forbidden"}' });
      } else await request.continue();
    });
    await sources.getByRole("button", { name: `Remove #${name} from this note`, exact: true }).click();
    await expect(sources.getByText(`Remove #${name}? This note will stop receiving Skills.`)).toBeVisible();
    await sources.getByRole("button", { name: "Remove tag", exact: true }).click();
    await expect(page.locator(".toast-message").filter({ hasText: "You don't have permission to do that." })).toBeVisible();
    await expect(sources.getByRole("button", { name: `#${name}`, exact: true })).toBeVisible();
    // A refused membership change has nothing the user typed, so the toast is the whole
    // outcome: no recovery copy (writeRecovery.ts preserveDirectRejection, since 2026-10-24).
    // The confirmation stays open for a retry.
    await expect(page.locator(".failed-write-recovery")).toHaveCount(0);
    await sources.getByRole("button", { name: "Remove tag", exact: true }).click();
    await expect(sources.getByRole("group", { name: `Remove #${name} from this note`, exact: true })).toHaveCount(0);
    // The chip leaves at once (optimistic); reload only after the server has
    // the removal, or the reload interrupts the request.
    await expect.poll(async () => {
      const boot = await (await page.request.get("/api/bootstrap")).json();
      const stored = boot.nodes.find((row: { id: string }) => row.id === note.id);
      return [...(stored.class_tag_ids ?? []), ...(stored.label_tag_ids ?? [])].includes(tagId);
    }).toBe(false);
    await page.reload();
    // Without tags the row folds to nothing on a wide screen until the title is pointed at.
    await expect(sources).toHaveCount(1);
    await expect(sources.getByRole("button", { name: `#${name}`, exact: true })).toHaveCount(0);
    const bootstrap = await (await page.request.get("/api/bootstrap")).json();
    for (const id of [note.id, other.id]) {
      const saved = bootstrap.nodes.find((row: { id: string }) => row.id === id);
      expect(saved.markdown).toBe("Preserve this note.");
      expect([...(saved.class_tag_ids ?? []), ...(saved.label_tag_ids ?? [])].includes(tagId)).toBe(id === other.id);
    }
    // Removing the tag from one note leaves what the tag extends alone.
    const storedTag = await (await page.request.get(`/api/tags/${tagId}`)).json();
    expect(storedTag.extends).toEqual([skillsTag.id]);

    // The refusal left nothing behind to acknowledge.
    await expect(page.locator(".failed-write-recovery")).toHaveCount(0);
    await page.evaluate(() => localStorage.setItem("onden.locale", "zh-TW"));
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      // ?view=tags is no view any more (useUrlLocation parseLocation): tags are listed in the
      // sidebar — on a phone in its 標籤 tab, one step back from the landing note.
      if (width > 900) await ready(page, "/?view=notes");
      else {
        await phoneNotesHome(page);
        await page.locator(".obsidian-sidebar .sidebar-tab", { hasText: "標籤" }).click();
      }
      const card = page.getByRole("button", { name: `打開 #${name}`, exact: true });
      await expect(card).toBeVisible();
      await renderSettled(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
      await page.screenshot({ path: `/tmp/pw-output/tag-overview-${width}.png` });
      await card.click();
      await expect(tagFunctionEntry(page, "技能")).toBeVisible();
      await ready(page, `/?view=notes&node=${other.id}`);
      // Tags are removed under the title at every width. On a phone a chip
      // shows its remove x only while its card is open (OverviewEditor.css,
      // f1c0fd4); on desktop the x is always there, so open the chip first
      // wherever it is closed.
      const noteTags = titleTags(page);
      const chip = noteTags.getByRole("button", { name: `#${name}`, exact: true });
      await expect(chip).toBeVisible();
      if ((await chip.getAttribute("aria-expanded")) !== "true") await chip.click();
      await noteTags.getByRole("button", { name: `從此筆記移除 #${name}`, exact: true }).click();
      await renderSettled(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
      await page.screenshot({ path: `/tmp/pw-output/note-tags-${width}.png` });
      await noteTags.getByRole("button", { name: "取消", exact: true }).click();
    }
  } finally {
    await page.unroute(route);
    for (const id of [note.id, other.id, tagId]) expect((await page.request.delete(`/api/nodes/${id}`, H)).ok()).toBe(true);
  }
});
