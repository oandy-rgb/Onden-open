import { test, expect } from "@playwright/test";
import { ready, H, pollBootstrap } from "./helpers";

// JOURNEY [spaces] — a new user makes a space and has to be able to put the first note in it.
// An empty space shows in the sidebar ("No notes yet" and a ＋), the ＋ makes the first note at its top level,
// and the place list (放在 / Move to…) finds the space by its name.

test.describe.configure({ mode: "serial" });

test("a new space shows in the sidebar, takes the first note, and is found by name in the place list", async ({ page }) => {
  const stamp = Date.now();
  const name = `Year3 ${stamp}`;
  // The sidebar groups by space only once there is more than one: the personal space already has a note.
  await page.request.post("/api/nodes", { ...H, data: { title: `Mine ${stamp}`, markdown: "x" } });
  const space = await (await page.request.post("/api/spaces", { ...H, data: { name } })).json();

  await ready(page, "/?view=notes");
  await page.evaluate(() => localStorage.setItem("onden.locale", "en"));
  await page.reload();

  const heading = page.getByRole("heading", { name: new RegExp(name) }).filter({ visible: true }).first();
  await expect(heading).toBeVisible();
  const row = page.locator(`[data-sb-space-none="${space.id}"]`).filter({ visible: true });
  await expect(row.getByText("No notes yet")).toBeVisible();

  await row.getByRole("button", { name: `New note in ${name}` }).click();
  // (There is no GET /api/nodes list; the bootstrap payload is where the server lists the notes.)
  await pollBootstrap(page, (b: { nodes?: Array<{ space_id?: string; parent_id?: string | null; node_type?: string }> }) =>
    (b.nodes ?? []).filter((n) => n.space_id === space.id && !n.parent_id && n.node_type !== "class_tag").length === 1 || undefined,
    { message: "exactly one note, at the new space's top level" });

  // The place list: typing the space's name finds its top level.
  await page.getByRole("button", { name: "Create" }).filter({ visible: true }).first().click();
  const sheet = page.getByRole("dialog", { name: "Create" });
  await sheet.getByRole("button", { name: /Put it in/ }).click();
  await sheet.getByRole("combobox").fill(name);
  await expect(sheet.getByRole("option", { name: new RegExp(`${name} › Top level`) })).toBeVisible();
  await expect(sheet.getByText("No places match")).toBeHidden();
});
