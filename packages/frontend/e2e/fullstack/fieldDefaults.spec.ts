// P2 field defaults, end to end through the UI: declare a default on the
// schema lens → tag a note → the default appears as its attribute; a bad
// write against a declared field is rejected with the readable reason.
import { test, expect } from "@playwright/test";
import { ready, openFieldEditor, H } from "./helpers";


test("schema default set in the lens seeds newly tagged notes", async ({ page }) => {
  const stamp = Date.now();
  const tag = await (await page.request.post("/api/tags/import", {
    ...H, data: { name: `Dft${stamp}`, fields: [{ name: "status", type: "select", options: ["todo", "doing", "done"], label: "Status" }] },
  })).json();

  // Open the field's settings on the tag page and pick a default from the select's options.
  await ready(page, `/?view=notes&node=${tag.id}`);
  const field = await openFieldEditor(page, "status");
  await field.locator(".schema-field-default select").selectOption("todo");

  // server has the default — poll past the debounced (600ms) schema PATCH
  await expect
    .poll(async () => {
      const tags = await (await page.request.get("/api/tags")).json();
      const t = tags.find((x: { id: string }) => x.id === tag.id);
      return (t?.schema_fields ?? []).find((f: { name?: string }) => f.name === "status")?.default;
    }, { message: "debounced schema PATCH never landed the default" })
    .toBe("todo");

  // tag a fresh note → the default is seeded (derived, visible as an attr)
  const note = await (await page.request.post("/api/nodes", { ...H, data: { title: `Dft note ${stamp}`, markdown: "x" } })).json();
  await page.request.put(`/api/nodes/${note.id}/tags/${tag.id}`, { ...H, data: {} });
  const attrs = await (await page.request.get(`/api/nodes/${note.id}/attributes`)).json();
  const status = attrs.find((a: { key: string }) => a.key === "status");
  expect(status).toMatchObject({ value: "todo", source: "derived" });

  // …and the declared constraint bites with a readable reason
  const bad = await page.request.put(`/api/nodes/${note.id}/attributes/status`, { ...H, data: { value: "bogus" } });
  expect(bad.status()).toBe(422);
  expect(await bad.text()).toContain("todo, doing, done");

  // P2 migration preview: reopening the field's settings shows it is in use.
  await ready(page, `/?view=notes&node=${tag.id}`);
  const reopened = await openFieldEditor(page, "status");
  await expect(reopened.locator(".schema-field-usage")).toHaveText("1 in use");
});
