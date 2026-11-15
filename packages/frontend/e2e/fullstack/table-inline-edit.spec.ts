import { test, expect, type Page } from "@playwright/test";
import { ready, H } from "./helpers";

// Inline-edit-a-cell journey through the REAL UI.
//
// A class tag carries a schema; its fields render as compact, editable cells
// pinned ON the node (FeaturedFields / `.ff-cell` — Anytype "featured
// relations" / Trilium "promoted attributes"). Editing a cell is the same
// node_attributes write path as the inspector: click a text/number cell →
// input → blur or Enter commits → PUT /api/nodes/:id/attributes/:key.
//
// The felt promise this guards: a typed cell value PERSISTS (re-query the
// server's attribute, not just the optimistic local echo) and SURVIVES a full
// reload (it re-hydrates from bootstrap into the cell).
//
// Robustness against the shared onden_test DB + parallel workers:
//  - every fixture title/field carries a per-test stamp, so the cell locator
//    (scoped by label text) matches exactly one element under strict mode;
//  - we reach the node by URL (?node=<id>), never by scrolling a sidebar list
//    that other workers are mutating (virtSidebar / lazyBody lessons);
//  - persistence is asserted by polling the server attribute endpoint, never
//    by trusting the in-cell optimistic value.
const SHOTS = "/tmp/pw-output/shots";

type Attr = { key: string; value: string };

// Read the server's stored value for one attribute key — the source of truth
// behind the cell. Polled (not a single GET) to wait out the debounced /
// optimistic write round-trip without a fixed sleep.
async function attrValue(page: Page, nodeId: string, key: string): Promise<string | undefined> {
  const res = await page.request.get(`/api/nodes/${nodeId}/attributes`);
  if (!res.ok()) return undefined;
  const attrs = (await res.json()) as Attr[];
  return attrs.find((a) => a.key === key)?.value;
}

// Create a class tag with a text + number schema field, a fresh note, and
// apply the tag — so the note renders FeaturedFields cells for both fields.
async function seedTaggedNote(page: Page, stamp: number) {
  const textKey = `city_${stamp}`;
  const numKey = `score_${stamp}`;
  const tag = await (await page.request.post("/api/tags/import", {
    ...H,
    data: {
      name: `Place${stamp}`,
      fields: [
        { name: textKey, type: "text", label: `City ${stamp}` },
        { name: numKey, type: "number", label: `Score ${stamp}` },
      ],
    },
  })).json();
  const note = await (await page.request.post("/api/nodes", {
    ...H, data: { title: `Place note ${stamp}`, markdown: "x" },
  })).json();
  // Apply the class tag (same endpoint the UI uses) so the schema fields pin
  // as editable cells on the node.
  await page.request.put(`/api/nodes/${note.id}/tags/${tag.id}`, { ...H, data: {} });
  return { note, textKey, numKey, textLabel: `City ${stamp}`, numLabel: `Score ${stamp}` };
}

// 1 — Editing a TEXT cell and blurring commits the value: it persists server
// side (re-query) and survives a full reload (re-hydrates into the cell).
test("text cell: edit + blur persists and survives reload", { tag: "@critical" }, async ({ page }) => {
  const stamp = Date.now();
  const { note, textKey, textLabel } = await seedTaggedNote(page, stamp);
  const value = `Kyoto-${stamp}`;

  await ready(page, `/?view=notes&node=${note.id}`);
  await expect(page.locator(".cm-content").first()).toBeVisible(); // editor lens mounted

  // The featured cell for this field — scoped by its unique stamped label.
  const cell = page.locator(".ff-cell", { hasText: textLabel });
  await expect(cell).toBeVisible();
  await expect(cell.locator(".ff-value")).toHaveText("Empty"); // no value yet

  // Click the cell → it swaps to an autofocused input.
  await cell.click();
  const input = page.locator(".ff-cell--editing input");
  await expect(input).toBeFocused();
  await input.fill(value);

  // Blur commits (not Enter) — click the title bar to move focus out.
  await page.locator(".obsidian-title-input, .cm-content").first().click();

  // Optimistic echo: the cell shows the new value immediately.
  await expect(cell.locator(".ff-value")).toHaveText(value);

  // Server truth: poll the attribute endpoint past the write round-trip.
  await expect.poll(() => attrValue(page, note.id, textKey),
    { message: "text cell value never persisted server-side" }).toBe(value);

  await page.screenshot({ path: `${SHOTS}/table-inline-text.png`, fullPage: false });

  // Survives a full reload — re-hydrates from bootstrap, not from the dead
  // optimistic state.
  await ready(page, `/?view=notes&node=${note.id}`);
  await expect(page.locator(".ff-cell", { hasText: textLabel }).locator(".ff-value"))
    .toHaveText(value);
});

// 2 — Editing a NUMBER cell and pressing Enter commits the value: same
// persistence + reload contract via the Enter keypath.
test("number cell: edit + Enter persists and survives reload", { tag: "@critical" }, async ({ page }) => {
  const stamp = Date.now();
  const { note, numKey, numLabel } = await seedTaggedNote(page, stamp);
  const value = "42";

  await ready(page, `/?view=notes&node=${note.id}`);
  await expect(page.locator(".cm-content").first()).toBeVisible();

  const cell = page.locator(".ff-cell", { hasText: numLabel });
  await expect(cell).toBeVisible();

  await cell.click();
  const input = page.locator(".ff-cell--editing input");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("type", "number"); // numeric field → number input
  await input.fill(value);
  await input.press("Enter"); // Enter commits

  await expect(cell.locator(".ff-value")).toHaveText(value); // optimistic echo

  await expect.poll(() => attrValue(page, note.id, numKey),
    { message: "number cell value never persisted server-side" }).toBe(value);

  await page.screenshot({ path: `${SHOTS}/table-inline-number.png`, fullPage: false });

  // Reload → value re-hydrates into the cell.
  await ready(page, `/?view=notes&node=${note.id}`);
  await expect(page.locator(".ff-cell", { hasText: numLabel }).locator(".ff-value"))
    .toHaveText(value);
});

// 3 — Escape ABANDONS an in-progress edit: nothing is written and the cell
// keeps its prior value (the guardrail that makes editing feel safe).
test("Escape abandons the edit without writing", async ({ page }) => {
  const stamp = Date.now();
  const { note, textKey, textLabel } = await seedTaggedNote(page, stamp);

  await ready(page, `/?view=notes&node=${note.id}`);
  await expect(page.locator(".cm-content").first()).toBeVisible();

  const cell = page.locator(".ff-cell", { hasText: textLabel });
  await cell.click();
  const input = page.locator(".ff-cell--editing input");
  await expect(input).toBeFocused();
  await input.fill(`discarded-${stamp}`);
  await input.press("Escape"); // abandon

  // Cell reverts to empty (its prior value) — the typed text is gone.
  await expect(cell.locator(".ff-value")).toHaveText("Empty");

  // And nothing was written: the server has no value for this key. Give the
  // (non-)write a beat by polling a stable condition — the attribute stays
  // unset/empty.
  await expect.poll(async () => (await attrValue(page, note.id, textKey)) ?? "",
    { message: "Escape must not write the attribute" }).toBe("");
});
