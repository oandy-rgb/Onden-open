// Tags in the grey line under the note title: "＋" creates a new tag and applies it in one
// step, an existing tag is found while typing, and the chip's ✕ removes it.
// Memberships are checked against the server, not just the screen.
import { test, expect, type Page } from "@playwright/test";
import { ready, titleTagAdd, titleTagOption, PAGE } from "./helpers";

async function memberships(page: Page, nodeId: string): Promise<string[]> {
  const res = await page.request.get(`/api/nodes/${nodeId}`);
  const node = await res.json() as { class_tag_ids?: string[]; label_tag_ids?: string[] };
  return [...(node.class_tag_ids ?? []), ...(node.label_tag_ids ?? [])];
}
async function tagId(page: Page, name: string): Promise<string | undefined> {
  const { tags = [] } = await (await page.request.get("/api/bootstrap")).json() as { tags?: Array<{ id: string; name: string }> };
  return tags.find((tag) => tag.name === name)?.id;
}

test("add a new tag, add an existing one, then remove it — all from under the title", async ({ page }) => {
  const stamp = Date.now();
  const created = await page.request.post("/api/nodes", {
    headers: PAGE,
    data: { title: `Title tags ${stamp}`, markdown: "Body" },
  });
  expect(created.status()).toBe(201);
  const { id } = await created.json();

  await ready(page, `/?view=notes&node=${id}`);
  // The one tag row under the title (the sidebar no longer has a picker). On a wide screen a
  // note without tags folds it to nothing until the title area is pointed at (titleTagAdd).
  const row = page.locator(".note-document .title-tag-row");
  await expect(row).toHaveCount(1);

  // 1) A brand-new name: created and applied in one Enter.
  const fresh = `thesis${stamp}`;
  await (await titleTagAdd(page)).click();
  await expect(row).toBeVisible();
  const input = row.getByRole("combobox", { name: "Add a tag" });
  await input.fill(`#${fresh}`);
  await expect(titleTagOption(page, `Create #${fresh}`)).toBeVisible();
  await input.press("Enter");
  await expect(row.getByRole("button", { name: `#${fresh}`, exact: true })).toBeVisible();
  await expect.poll(async () => {
    const tid = await tagId(page, fresh);
    return !!tid && (await memberships(page, id)).includes(tid);
  }, { timeout: 15_000 }).toBe(true);

  // 2) An existing tag, found by typing part of its name.
  const existingName = `paper${stamp}`;
  const made = await page.request.post("/api/tags/resolve-path", {
    headers: PAGE,
    data: { path: existingName },
  });
  expect(made.ok()).toBeTruthy();
  const existingId = (await made.json()).leaf_id as string;
  await ready(page, `/?view=notes&node=${id}`);
  await (await titleTagAdd(page)).click();
  await input.fill(existingName.slice(0, 8));
  await expect(titleTagOption(page, `#${existingName}`)).toBeVisible();
  await titleTagOption(page, `#${existingName}`).click();
  await expect.poll(async () => (await memberships(page, id)).includes(existingId), { timeout: 15_000 }).toBe(true);
  await expect(row.getByRole("button", { name: `#${existingName}`, exact: true })).toBeVisible();

  // 3) Remove it with the chip's ✕ (a plain tag: no confirmation).
  await row.getByRole("button", { name: `Remove #${existingName} from this note` }).click();
  await expect.poll(async () => (await memberships(page, id)).includes(existingId), { timeout: 15_000 }).toBe(false);
  await expect(row.getByRole("button", { name: `#${existingName}`, exact: true })).toHaveCount(0);
});
