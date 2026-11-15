import { test, expect } from "@playwright/test";
import { ready, H } from "./helpers";

// JOURNEY [spaces] — a note's space decides who can see it
// (docs/architecture/spaces.md): a new note lands in your personal space
// ("Only me"), the chip next to the title names who can see it, and "Move to another space…"
// previews the audience before moving.


test.describe.configure({ mode: "serial" });

test("a new note is private to you, and moving it previews who will see it", async ({ page }) => {
  const stamp = Date.now();
  const note = await (await page.request.post("/api/nodes", { ...H, data: { title: `Private draft ${stamp}`, markdown: "only mine" } })).json();
  const lab = await (await page.request.post("/api/spaces", { ...H, data: { name: `Lab ${stamp}` } })).json();

  await ready(page, `/?view=notes&node=${note.id}`);
  const chip = page.locator(".space-chip").filter({ visible: true }).first();
  await expect(chip).toHaveText(/Only me/);
  await chip.click();
  const dialog = page.getByRole("dialog", { name: "Who can see this note" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox").selectOption(lab.id);
  await expect(dialog.getByText("The same people can see it.")).toBeVisible();
  await expect(dialog.getByText(/version history moves with it/i)).toBeVisible();
  await dialog.getByRole("button", { name: "Move" }).click();
  await expect(dialog).toBeHidden();

  // Server truth: the note is in the lab now.
  await expect.poll(async () => {
    const row = await (await page.request.get(`/api/nodes/${note.id}`)).json();
    return row.space_id;
  }).toBe(lab.id);
  await expect(chip).toHaveText(new RegExp(`Lab ${stamp}`));
});
