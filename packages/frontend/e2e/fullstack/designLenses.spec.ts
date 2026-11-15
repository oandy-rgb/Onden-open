import { test, expect } from "@playwright/test";
import { ready, openSavedViewTab, H } from "./helpers";

// D3 node lenses — timeline (History), local-graph (Links), table (Table) as
// per-node center-pane lenses on the strip. Contracts pinned here:
//   • History + Links are universal (any focused node has the tabs);
//   • Table appears ONLY for a node with children, and renders the subtree as
//     rows with schema-field columns from the children's shared class tag;
//   • lens choice is URL-addressable (?lens=…), like editor/canvas.
const SHOTS = "/tmp/pw-output/shots";

test("lenses: history + links are universal; table is subtree-gated", async ({ page }) => {
  const stamp = Date.now();
  const leaf = await (await page.request.post("/api/nodes", {
    ...H, data: { title: `Leaf ${stamp}`, markdown: "no children here" },
  })).json();

  await ready(page, `/?view=notes&node=${leaf.id}`);
  // 2026-09-29 (7795c3e): History left the lens strip; since 2026-10-18 the
  // versions open from the note header and the full event feed stays
  // URL-addressable. A
  // childless note's strip carries no gated lenses.
  await expect(page.getByRole("tab", { name: "History" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Links" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Table" })).toHaveCount(0);
  await expect(page.locator(".note-history-link")).toBeVisible();

  // The History lens is gone (a note's history is its time slider): an old
  // ?lens=timeline link opens the same note's editor.
  await ready(page, `/?view=notes&node=${leaf.id}&lens=timeline`);
  await expect(page).not.toHaveURL(/lens=timeline/);
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await expect(page.locator(".note-history-link")).toBeVisible();

  // Retired-lens alias (P4): ?lens=local-graph now lands on the editor of
  // the same node — the graph surface lives in Places → Graph.
  await ready(page, `/?view=notes&node=${leaf.id}&lens=local-graph`);
  await expect(page).toHaveURL(/lens=editor/);
  await expect(page.locator(".cm-content").first()).toBeVisible(); // editor lens mounted
  await page.screenshot({ path: `${SHOTS}/lens-local-graph.png` });
});

test("a note's sub-notes list as rows with the fields they share (the old table lens)", async ({ page }) => {
  const stamp = Date.now();
  // A class tag whose field default is status=todo on apply → the table's
  // schema column has a real value without driving the attribute editor.
  const tag = await (await page.request.post("/api/tags/import", {
    ...H,
    data: {
      name: `Sprint${stamp}`,
      fields: [{ key: "status", type: "select", label: "Status", options: ["todo", "done"], default: "todo" }],
    },
  })).json();

  const parent = await (await page.request.post("/api/nodes", {
    ...H, data: { title: `Project ${stamp}`, markdown: "the subtree root" },
  })).json();
  const childA = await (await page.request.post("/api/nodes", {
    ...H, data: { title: `Child A ${stamp}`, markdown: "a", parent_id: parent.id },
  })).json();
  const childB = await (await page.request.post("/api/nodes", {
    ...H, data: { title: `Child B ${stamp}`, markdown: "b", parent_id: parent.id },
  })).json();
  // Both carry the tag, so its field is one they share (a column).
  await page.request.put(`/api/nodes/${childA.id}/tags/${tag.id}`, { ...H });
  await page.request.put(`/api/nodes/${childB.id}/tags/${tag.id}`, { ...H });

  // The Table lens is gone: a note's sub-notes are a plain list under its
  // text, and their table/calendar/board/cards are tabs above the note
  // (views-as-modules.md 「檢視的來源」). An old ?lens=table link opens the content.
  await ready(page, `/?view=notes&node=${parent.id}&lens=table`);
  await expect(page).toHaveURL(/lens=editor/);

  const section = page.getByRole("region", { name: /Sub-notes/ });
  // With 內容 its only view, the note's tab row holds just 內容 (and ＋ beside it): since 2026-11-03 the row is the
  // page's title strip and shows even then (ViewTabs.test "a note with only 內容 still shows its row"). No Table tab.
  const views = page.getByRole("tablist", { name: `Views of Project ${stamp}` });
  await expect(views.getByRole("tab")).toHaveText(["Content"]);
  await expect(page.getByRole("tab", { name: /^Table/ })).toHaveCount(0);
  await expect(section.getByRole("tab")).toHaveCount(0); // no view menu in the section
  const table = section.locator(".tag-member-table");
  await expect(table.locator("th", { hasText: "Status" })).toBeVisible(); // the sub-notes' tag field
  await expect(table.locator("tr", { hasText: `Child A ${stamp}` }).locator("td", { hasText: "todo" })).toBeVisible();
  await expect(table.getByRole("button", { name: `Child A ${stamp}` })).toBeVisible();
  await expect(table.getByRole("button", { name: `Child B ${stamp}` })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/lens-table.png` });

  // A row is a door: clicking opens that child (focus moves, URL follows).
  await table.getByRole("button", { name: `Child A ${stamp}` }).click();
  await expect(page).toHaveURL(new RegExp(`node=${childA.id}`));
});

// Tana supertag-page: opening a class tag leads with WHAT CARRIES IT — a live
// instances table with schema-field columns — alongside its configuration.
test("tag page lists tagged notes with schema-field values", async ({ page }) => {
  const stamp = Date.now();
  const tag = await (await page.request.post("/api/tags/import", {
    ...H,
    data: {
      name: `Reading${stamp}`,
      fields: [{ key: "status", type: "select", label: "Status", options: ["todo", "done"], default: "todo" }],
    },
  })).json();
  const note = await (await page.request.post("/api/nodes", {
    ...H, data: { title: `Tagged ${stamp}`, markdown: "x" },
  })).json();
  await page.request.put(`/api/nodes/${note.id}/tags/${tag.id}`, { ...H });
  // The field default (status=todo) is seeded in the same transaction;
  // wait for it to show before snapshotting the page.
  await expect.poll(async () => {
    const attrs = (await (await page.request.get(`/api/nodes/${note.id}/attributes`)).json()) as Array<{ key: string; value: string }>;
    return attrs.find((a) => a.key === "status")?.value ?? "";
  }, { timeout: 10_000 }).toBe("todo");

  const view = await page.request.post(`/api/tags/${tag.id}/views`, {
    ...H, data: { name: `Tagged ${stamp} table`, layout: "table", visible_fields: ["title", "status"] },
  });
  expect(view.ok(), await view.text()).toBeTruthy();

  // The tag's page has its saved views as tabs after 「全部」.
  await ready(page, `/?view=notes&node=${tag.id}`);
  await openSavedViewTab(page, new RegExp(`Tagged ${stamp} table`));
  const table = page.locator(".cv-table");
  await expect(table).toBeVisible({ timeout: 15_000 });
  await expect(table.locator("td", { hasText: `Tagged ${stamp}` })).toBeVisible();
  await expect(table.locator("th", { hasText: "status" })).toBeVisible();
  await expect(table.locator("tr", { hasText: `Tagged ${stamp}` }).locator("td", { hasText: "todo" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/tag-page-instances.png` });
});
