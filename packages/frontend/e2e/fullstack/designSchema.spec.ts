import { test, expect, type Page } from "@playwright/test";
import { ready, requireAdmin, addTagField, tagFieldLine, H } from "./helpers";

// Screenshots for a design pass on the TAG / SUPERTAG-SCHEMA surface (where
// memory surface-no-programmer-ui says the design is weakest — "feels like
// programming the data model"). Not assertions.
const SHOTS = "/tmp/pw-output/shots";

test("design: schema lens + tags mode", async ({ page }) => {
  const stamp = Date.now();
  // A realistic supertag: a few typed fields + a behaviour.
  const tag = await (await page.request.post("/api/tags/import", {
    ...H,
    data: {
      name: `Task${stamp}`,
      color: "#7a2e33",
      fields: [
        { key: "status", type: "select", label: "Status", options: ["todo", "doing", "done"], default: "todo" },
        { key: "due", type: "date", label: "Due date" },
        { key: "priority", type: "number", label: "Priority" },
        { key: "owner", type: "text", label: "Owner" },
      ],
    },
  })).json();

  // Apply it to a real note so the schema lens has an instance context.
  const node = await (await page.request.post("/api/nodes", { ...H, data: { title: `Ship the editor ${stamp}`, markdown: "# Ship the editor\n\nblocked on sync." } })).json();
  await page.request.put(`/api/nodes/${node.id}/tags/${tag.id}`, { ...H });

  // 1) The SchemaLens — opening the class_tag as a node.
  if (tag.id) {
    await ready(page, `/?view=notes&node=${tag.id}`);
    await expect(page.locator(".schema-lens-title")).toBeVisible(); // schema lens mounted
    await page.screenshot({ path: `${SHOTS}/ds-schema-lens.png`, fullPage: false });
  }

  // 2) The notes sidebar tag panel — where tags now surface (TagsMode retired).
  await ready(page, "/?view=notes");
  await expect(page.locator(".cm-content").first()).toBeVisible(); // day note mounted
  await page.screenshot({ path: `${SHOTS}/ds-sidebar-tag-panel.png`, fullPage: false });

  // 3) The tagged note's inspector — how schema fields surface ON a node.
  await ready(page, `/?view=notes&node=${node.id}`);
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ds-tagged-node.png`, fullPage: false });
});

// Verify the hidden-key behaviour: adding a field and typing a NAME derives a
// stable snake_case key on blur (the user never authors the key).
test("schema: a new field's key is auto-derived from its name", async ({ page }) => {
  const stamp = Date.now();
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `Proj${stamp}`, fields: [{ key: "owner", type: "text", label: "Owner" }] } })).json();
  requireAdmin(!!tag.id, "tag import failed (needs the owner; reset the stack)");
  await ready(page, `/?view=notes&node=${tag.id}`);
  const chips = tagFieldLine(page).locator(".tag-field-item");
  await expect(chips.first()).toBeVisible();
  const before = await chips.count();
  await addTagField(page, "Estimate hours");
  await expect(chips).toHaveCount(before + 1); // the field exists once 「確定」 is pressed, not before

  type F = { name?: string; key?: string; label?: string };
  // Poll the API past the debounced (600ms) schema PATCH instead of sleeping.
  let t: { schema_fields?: F[] } = {};
  await expect
    .poll(async () => {
      const tags = await (await page.request.get("/api/tags")).json();
      t = tags.find((x: { id: string }) => x.id === tag.id);
      return (t.schema_fields ?? []).find((f: F) => f.label === "Estimate hours");
    }, { message: "debounced schema PATCH never landed the new field" })
    .toBeTruthy();
  const derived = (t.schema_fields ?? []).find((f: F) => f.label === "Estimate hours");
  expect(derived).toBeTruthy();
  expect(derived!.name).toBe("estimate_hours");        // key auto-derived from the typed name
  const owner = (t.schema_fields ?? []).find((f: F) => f.label === "Owner");
  expect(owner!.name).toBe("owner");                   // import's `key` normalized to `name`, value kept
  // ONE identifier convention: every field carries `name`; the TagPack-era
  // `key` never reaches the API anymore (write-boundary normalization + mig 056).
  for (const f of (t.schema_fields ?? []) as F[]) {
    expect(f.name, `field ${JSON.stringify(f)} should carry name`).toBeTruthy();
    expect(f.key).toBeUndefined();
  }
});
