import { test, expect, type Locator, type Page } from "@playwright/test";
import { ready, openSettingsFromAvatar, requireAdmin, openSidebarSearch, tagMenuAction, showAdvancedSettings, tagFieldLine, tagFunctionLine, H } from "./helpers";

// D6 — no JSON, no form-style data-modeling in the everyday path. TagsMode is
// retired; the contracts live on its rehomed surfaces:
//   • a tag is created by NAMING it in the sidebar tag panel ("+"), then
//     shaped on its own node (the schema lens);
//   • the tag node's page opens on its notes; the WHOLE tag sits on the page
//     in plain language — a row of field chips, a row of functions with
//     the title and the ⋯ menu (move, export, merge,
//     delete) — plus pin-to-topbar;
//   • the import escape hatch survives in Settings → Data and backup → Import a tag pack
//     (files, not paste).

test("a new tag is born from a name in the sidebar tag panel and shaped on its node", async ({ page }) => {
  const stamp = Date.now();
  await ready(page, "/?view=notes&lens=table");

  // The quiet "+" in the sidebar's "# Tags" panel opens an inline name input.
  await page.locator(".sidebar-tag-new").click();
  await page.locator(".sidebar-tag-new-input").fill(`Standup${stamp}`);
  await page.locator(".sidebar-tag-new-input").press("Enter");

  // New tags open on their notes; the fields and the functions are rows
  // under the title, ready to add to.
  await expect(page.locator(".schema-lens-title")).toHaveText(`#Standup${stamp}`);
  await expect(page).toHaveURL(/view=notes/);
  await expect(tagFunctionLine(page)).toHaveCount(0);
  // No raw-JSON paste box anywhere on the tag's own surface.
  await expect(page.locator(".schema-lens textarea")).toHaveCount(0);
  await expect(tagFieldLine(page).getByRole("button", { name: "Add field", exact: true })).toBeVisible();
  // No 「加功能」 by the title any more (2026-11-12): fields and views are the tag's structure.
  await expect(page.getByRole("button", { name: "Add function" })).toHaveCount(0);
  // The rehomed per-tag actions: pin-to-topbar + TagPack export.
  await expect(page.locator(".schema-lens-pin")).toBeVisible();
  // Export, merge and delete sit in the ⋯ menu by the title (V1.5).
  await expect(page.getByRole("button", { name: "Tag actions", exact: true })).toBeVisible();
  // Tag automation is gone: the ⋯ menu has no 「Remove old automation」 item.
  await page.getByRole("button", { name: "Tag actions", exact: true }).click();
  await expect(page.getByRole("menu", { name: "Tag actions", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Remove old automation", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: "/tmp/pw-output/shots/d6-schema-lens-full.png", fullPage: false });
});

// Spaces replaced tag access rules (docs/architecture/spaces.md): a policy
// sent on import is dropped. (The tag page's note pointing to spaces went with
// the structure panel's 「進階」.)
test("tags carry no access rules: a policy sent on import is dropped", async ({ page }) => {
  const stamp = Date.now();
  const tag = await (await page.request.post("/api/tags/import", {
    ...H, data: { name: `Locked${stamp}`, fields: [], policy: { operations: { read: "admin" } } },
  })).json();
  requireAdmin(!!tag.id, "tag import failed (needs the owner; reset the stack)");
  const rows = await (await page.request.get("/api/tags")).json();
  const row = rows.find((t: { id: string }) => t.id === tag.id);
  expect(row).toBeTruthy();
  expect(row.schema_policy ?? null).toBeNull();
});

test("the escape hatch: Settings imports TagPack files; export lives on the tag node", async ({ page }) => {
  const stamp = Date.now();
  const tag = await (await page.request.post("/api/tags/import", {
    ...H, data: { name: `Exportable${stamp}`, fields: [] },
  })).json();
  requireAdmin(!!tag.id, "tag import failed (needs the owner; reset the stack)");

  // Import — Settings → Data and backup → Import a tag pack, a FILE input (no paste box),
  // round-tripping through the same POST /api/tags/import.
  await ready(page, "/?view=notes");
  await openSettingsFromAvatar(page, "Data and backup");
  await showAdvancedSettings(page);
  const widget = page.locator(".settings-tagpacks");
  await expect(widget).toBeVisible();
  await expect(widget.locator(".settings-tagpack-import")).toBeVisible();
  await widget.locator('input[type="file"]').setInputFiles({
    name: `roundtrip${stamp}.tagpack.json`,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ name: `Roundtrip${stamp}`, fields: [] })),
  });
  await expect(widget.locator(".settings-tagpack-results")).toContainText(`installed as #Roundtrip${stamp}`);
  const rows = await (await page.request.get("/api/tags")).json();
  expect(rows.some((t: { name: string }) => t.name === `Roundtrip${stamp}`)).toBeTruthy();

  // The starter templates are picked in the new-tag form, not installed here.
  await expect(widget.getByRole("button", { name: "Install" })).toHaveCount(0);

  // Export — the tag travels as a .tagpack.json file, downloaded from the
  // tag's own node.
  await ready(page, `/?view=notes&node=${tag.id}`);
  const downloadP = page.waitForEvent("download");
  await tagMenuAction(page, "Export tag");
  const download = await downloadP;
  expect(download.suggestedFilename()).toMatch(/\.tagpack\.json$/);
});

// The desktop sidebar's 「標籤」 section (SidebarTagTree placement="section"): the tag tree,
// each row's name a button "Open #name". It is the tags' home since ?view=tags stopped
// being a place (useUrlLocation parseLocation). Opens the section if it was folded and,
// past a dozen tags, narrows it with its own filter box.
const sidebarTagTree = (page: Page) => page.locator(".obsidian-sidebar .sb-tagtree");
async function sidebarTagRow(page: Page, name: string): Promise<Locator> {
  const tree = sidebarTagTree(page);
  await expect(tree).toBeVisible();
  const toggle = tree.locator(".sb-tagtree-section-toggle");
  if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  const filter = tree.getByRole("searchbox", { name: "Search tags…" });
  if (await filter.isVisible()) await filter.fill(name);
  return tree.getByRole("button", { name: `Open #${name}`, exact: true });
}

test("the tag node opens from the sidebar tree (tags stay reachable without a tags place)", async ({ page }) => {
  const stamp = Date.now();
  const tag = await (await page.request.post("/api/tags/import", {
    ...H, data: { name: `Clickme${stamp}`, fields: [] },
  })).json();
  requireAdmin(!!tag.id, "tag import failed (needs the owner; reset the stack)");
  // The sidebar lists tags that notes use (unused ones stay on the Tags page).
  const note = await (await page.request.post("/api/nodes", { ...H, data: { title: `Uses Clickme ${stamp}`, markdown: "" } })).json();
  expect((await page.request.put(`/api/nodes/${note.id}/tags/${tag.id}`, { ...H, data: {} })).ok()).toBe(true);

  await ready(page, "/?view=notes&lens=table");
  // A big workspace virtualizes the tree (only a scroll window is in the
  // DOM), so reach the row the way a person would: filter with the sidebar
  // search — result rows carry the same .sb-tag-node markup.
  // The tag is a row of the sidebar's tag tree, and its row opens its page.
  await expect(await sidebarTagRow(page, `Clickme${stamp}`)).toHaveCount(1);
  await (await sidebarTagRow(page, `Clickme${stamp}`)).click();
  await expect(page).toHaveURL(new RegExp(`view=notes&node=${tag.id}`));
  await expect(page.locator(".schema-lens-title")).toHaveText(`#Clickme${stamp}`);

  // The sidebar search finds the tag node too.
  await ready(page, "/?view=notes&lens=table");
  const search = await openSidebarSearch(page);
  await search.click();
  await search.pressSequentially(`Clickme${stamp}`);
  await expect(search).toHaveValue(`Clickme${stamp}`);
  await page.locator(".obsidian-page-button.sb-tag-node", { hasText: `Clickme${stamp}` }).first().click();
  await expect(page).toHaveURL(new RegExp(`view=notes&node=${tag.id}`));
  await expect(page.locator(".schema-lens-title")).toHaveText(`#Clickme${stamp}`);
});

test("the sidebar tag tree opens the functions page even after a table lens", async ({ page }) => {
  const name = `Overview-functions-${Date.now()}`;
  const response = await page.request.post("/api/tags/import", { ...H, data: { name, fields: [] } });
  expect(response.ok()).toBe(true);
  const tag = await response.json() as { id: string };
  try {
    // The tags' overview is the sidebar's tag tree (no ?view=tags place any more); an old
    // ?lens=table link must not stop its row from opening the tag's page with its functions.
    await ready(page, "/?view=notes&lens=table");
    await (await sidebarTagRow(page, name)).click();
    await expect(page.locator(".schema-lens-title")).toHaveText(`#${name}`);
    await expect(tagFieldLine(page)).toBeVisible();
  } finally { expect((await page.request.delete(`/api/nodes/${tag.id}`, H)).ok()).toBe(true); }
});

test("an old ?view=tags link falls back to notes, with the tag tree in the sidebar", async ({ page }) => {
  // ?view=tags was once a Place of its own (the tag overview). It is no view any more:
  // the sidebar lists the tags (useUrlLocation parseLocation: an old ?view=tags link
  // falls back like any unknown view). An old link still lands on a working screen
  // with the tag tree in reach, not on a blank or broken page.
  await ready(page, "/?view=tags");
  await expect(page).not.toHaveURL(/view=tags/);
  await expect(page).toHaveURL(/view=notes/);
  await expect(sidebarTagTree(page)).toBeVisible();
});
