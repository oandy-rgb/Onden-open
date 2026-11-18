// Feature-audit deepening (2026-10-07): NAV-02 — lens availability, deep links,
// refresh and history navigation across Content / Canvas / History. The
// Table lens was removed (#486); an old ?lens=table link opens Content, and
// the deep-link loop below still visits it to log that redirect.
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
  const out: Record<string, string> = {};

  // Availability: a leaf has only Content; a parent shows the Canvas tab it was given.
  await ready(page, `/?view=notes&node=${leaf}`);
  out.leafTabs = JSON.stringify(await tabs(page));
  await ready(page, `/?view=notes&node=${parent}`);
  out.parentTabs = JSON.stringify(await tabs(page));
  expect(out.leafTabs).toBe(JSON.stringify(["Content"]));
  expect(out.parentTabs).toBe(JSON.stringify(["Content", "Canvas"]));

  // Deep links land on the right pane and survive refresh.
  for (const lens of ["table", "timeline", "canvas", "editor", "local-graph"]) {
    await ready(page, `/?view=notes&node=${parent}&lens=${lens}`);
    await page.waitForTimeout(800);
    const first = `${lensParam(page)}/${await pane(page)}`;
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(1500);
    out[`deep:${lens}`] = `${first} → reload ${lensParam(page)}/${await pane(page)}`;
    if (lens === "canvas") expect(out[`deep:${lens}`]).toBe("canvas/canvas → reload canvas/canvas");
    if (lens === "canvas") await page.screenshot({ path: "/tmp/pw-output/nav02-canvas.png" });
  }
  // A gated lens on a node that cannot fill it.
  await ready(page, `/?view=notes&node=${leaf}&lens=table`);
  await page.waitForTimeout(800);
  out["deep:table-on-leaf"] = `${lensParam(page)}/${await pane(page)}`;
  await page.screenshot({ path: "/tmp/pw-output/nav02-table-leaf.png" });

  // Back / forward across lens switches made in the strip.
  await ready(page, `/?view=notes&node=${parent}&lens=editor`);
  await page.locator('.view-tabs [role=tab]:has-text("Canvas")').click();
  await expect(page).toHaveURL(/lens=canvas/);
  await page.locator('.view-tabs [role=tab]:has-text("Content")').click();
  await expect(page).toHaveURL(/lens=editor/);
  const seq: string[] = [];
  await page.goBack(); await page.waitForTimeout(1500); seq.push(`${lensParam(page)}/${await pane(page)}`);
  await page.goBack(); await page.waitForTimeout(600); seq.push(`${lensParam(page)}/${await pane(page)}`);
  await page.goForward(); await page.waitForTimeout(1500); seq.push(`${lensParam(page)}/${await pane(page)}`);
  out.backForward = seq.join(" → ");

  // History: inspector entry vs History lens show the same node's versions.
  await ready(page, `/?view=notes&node=${parent}`);
  await page.locator(".note-history-link").click();
  const dialog = page.locator("[role='dialog']").filter({ hasText: /version|Version|版本/ }).first();
  out.inspectorHistory = `dialog=${await dialog.isVisible({ timeout: 5000 }).catch(() => false)} anyDialog=${await page.locator("[role='dialog'], dialog[open], .history-view, .version-dialog").count()}`;
  await page.screenshot({ path: "/tmp/pw-output/nav02-history.png" });
  await page.keyboard.press("Escape");
  out.afterEscape = `lens=${lensParam(page)} pane=${await pane(page)}`;
  console.log(`AUDIT NAV-02 ${JSON.stringify(out)}`);
});
