// P2 safe-delete: the schema lens's Delete-tag flow shows the blast radius
// before acting; the delete is the reversible node soft-delete (junction
// rows survive → Trash undelete restores memberships).
import { test, expect } from "@playwright/test";
import { ready, tagMenuAction, H } from "./helpers";


test("delete-tag flow: impact preview → delete → trash undelete restores membership", async ({ page }) => {
  const stamp = Date.now();
  const tag = await (await page.request.post("/api/tags/import", {
    ...H, data: { name: `Del${stamp}`, fields: [{ name: "status", type: "select", options: ["a", "b"], default: "a" }] },
  })).json();
  const note = await (await page.request.post("/api/nodes", { ...H, data: { title: `Del note ${stamp}`, markdown: "x" } })).json();
  await page.request.put(`/api/nodes/${note.id}/tags/${tag.id}`, { ...H, data: {} });

  // preview names the impact
  const preview = await (await page.request.get(`/api/tags/${tag.id}/delete-preview`)).json();
  expect(preview.members).toBe(1);
  expect(preview.sample_titles).toContain(`Del note ${stamp}`);
  expect(preview.fields.find((f: { name: string }) => f.name === "status")?.values_count).toBe(1); // the seeded default
  expect(preview.reversible).toBe(true);

  // the lens flow: open → Delete tag → confirm panel shows numbers → confirm
  await ready(page, `/?view=notes&node=${tag.id}`);
  await tagMenuAction(page, "Delete tag");
  // The confirm is a dialog now (TagDeleteConfirm: a Modal alertdialog named after the tag).
  const panel = page.getByRole("alertdialog", { name: `Delete #Del${stamp}?` });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("1 tagged note(s) lose the tag");
  await page.screenshot({ path: "/tmp/pw-output/tag-delete-confirm.png" });
  await panel.locator(".schema-lens-delete-go").click();

  // gone from the live tag list; note keeps its (now plain) attribute
  await expect.poll(async () => {
    const tags = await (await page.request.get("/api/tags")).json();
    return tags.some((x: { id: string }) => x.id === tag.id);
  }, { timeout: 10_000 }).toBe(false);
  const attrs = await (await page.request.get(`/api/nodes/${note.id}/attributes`)).json();
  expect(attrs.find((a: { key: string }) => a.key === "status")?.value).toBe("a");

  // undelete from trash restores tag + membership
  await page.request.post(`/api/nodes/${tag.id}/undelete`, { ...H, data: {} });
  const tagsAfter = await (await page.request.get("/api/tags")).json();
  expect(tagsAfter.some((x: { id: string }) => x.id === tag.id)).toBe(true);
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const n = boot.nodes.find((x: { id: string }) => x.id === note.id);
  expect((n.class_tag_ids ?? [])).toContain(tag.id); // membership survived the round-trip
});
