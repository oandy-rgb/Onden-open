// Feature-audit deepening (2026-10-07): NAV-02 — lens availability, deep links,
// refresh and history navigation across Content / Canvas / History. The
// Table lens was removed (#486), and the Timeline and local-graph lenses are
// gone too: an old ?lens=table|timeline|local-graph link opens Content
// (hooks/useUrlLocation.ts parseLocation). History is a window opened from
// the note's header (c38ff179), not a lens; switching a tab inside one note
// is a history `replace` (the table at the top of useUrlLocation.ts).
import { test, expect, type Page } from "@playwright/test";
import { ready, H } from "./helpers";

const lensParam = (page: Page) => new URL(page.url()).searchParams.get("lens");
const tabs = async (page: Page) => (await page.locator(".view-tabs [role='tab']").allInnerTexts()).map((t) => t.trim()).filter(Boolean);
const pane = async (page: Page) => {
  if (await page.locator(".react-flow").first().isVisible().catch(() => false)) return "canvas";
  if (await page.locator(".node-lens-pane .wh-tabs").first().isVisible().catch(() => false)) return "history";
  if (await page.locator(".cm-content").first().isVisible().catch(() => false)) return "editor";
  const txt = (await page.locator(".workspace-grid main, .workspace-grid").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 120);
  return `unknown[${txt}]`;
};

test("NAV-02: lens availability, deep links, refresh and back/forward", async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const mk = async (title: string, extra: Record<string, unknown> = {}) =>
    (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: `${title} body`, ...extra } })).json()).id as string;
  const leaf = await mk(`Leaf ${stamp}`);
  const parent = await mk(`Parent ${stamp}`);
  await mk(`Child1 ${stamp}`, { parent_id: parent });
  await mk(`Child2 ${stamp}`, { parent_id: parent });
  // The whiteboard is a view tab a note has (added from the tab row's ＋; docs/architecture/canvas-as-view.md, 2026-11-02 title-bar tabs):
  // having children no longer earns one. Give the parent that tab; the leaf keeps only Content.
  const canvasTab = await page.request.post(`/api/nodes/${parent}/views`, { ...H, data: { name: "Canvas", layout: "canvas", visible_fields: [] } });
  expect(canvasTab.ok(), await canvasTab.text()).toBeTruthy();

  // Availability: a leaf has only Content; a parent shows the Canvas tab it was given.
  await ready(page, `/?view=notes&node=${leaf}`);
  expect(await tabs(page)).toEqual(["Content"]);
  await ready(page, `/?view=notes&node=${parent}`);
  expect(await tabs(page)).toEqual(["Content", "Canvas"]);

  // Deep links land on the right pane and survive refresh. The lenses that were removed open Content
  // (hooks/useUrlLocation.ts parseLocation: local-graph, table and timeline read as the editor lens).
  const expected: Record<string, string> = { table: "editor/editor", timeline: "editor/editor", canvas: "canvas/canvas", editor: "editor/editor", "local-graph": "editor/editor" };
  for (const lens of ["table", "timeline", "canvas", "editor", "local-graph"]) {
    await ready(page, `/?view=notes&node=${parent}&lens=${lens}`);
    await expect.poll(async () => `${lensParam(page)}/${await pane(page)}`).toBe(expected[lens]);
    await page.reload({ waitUntil: "load" });
    await expect.poll(async () => `${lensParam(page)}/${await pane(page)}`, { message: `?lens=${lens} survives a reload` }).toBe(expected[lens]);
  }
  // A lens the note cannot fill (the Table link on a note with nothing to show) opens Content too.
  await ready(page, `/?view=notes&node=${leaf}&lens=table`);
  await expect.poll(async () => `${lensParam(page)}/${await pane(page)}`).toBe("editor/editor");

  // Switching tabs inside one note is a history `replace`, so Back leaves the note instead of undoing a tab switch
  // (hooks/useUrlLocation.ts, the history table: "switch tab / lens inside one note → replace").
  await ready(page, `/?view=notes&node=${parent}&lens=editor`);
  const entries = await page.evaluate(() => history.length);
  await page.locator('.view-tabs [role=tab]:has-text("Canvas")').click();
  await expect(page).toHaveURL(/lens=canvas/);
  await page.locator('.view-tabs [role=tab]:has-text("Content")').click();
  await expect(page).toHaveURL(/lens=editor/);
  expect(await page.evaluate(() => history.length), "tab switches add no history entry").toBe(entries);
  await page.goBack();
  await expect(page, "Back leaves the note for the page before it").toHaveURL(new RegExp(`node=${leaf}`));
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`node=${parent}.*lens=editor`));
  await expect.poll(() => pane(page)).toBe("editor");

  // History is a window opened from the note's header (not a lens); Escape closes it and leaves the page where it was.
  await ready(page, `/?view=notes&node=${parent}`);
  await page.locator(".note-history-link").click();
  await expect(page.locator(".nh")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".nh")).toBeHidden();
  expect(lensParam(page)).toBe("editor");
  expect(await pane(page)).toBe("editor");
});
