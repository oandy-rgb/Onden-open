import { test, expect } from "@playwright/test";
import { openQuickCapture, H, saveQuickCapture, ensureInbox, scrollToSidebarRow } from "./helpers";

// User-behaviour flows driven through the real UI against the wired stack.

async function makeNode(page: import("@playwright/test").Page, title: string, markdown = "seed") {
  const r = await page.request.post("/api/nodes", { ...H, data: { title, markdown } });
  expect(r.status()).toBe(201);
  return r.json();
}

test.describe("user interactions", () => {
  test("per-node lens + places switching drive the URL (surface A)", async ({ page }) => {
    // A note shows a tab row only when it has a view besides 內容 (ViewTabs:
    // "a note with only 內容 shows no row"); a board's note has its whiteboard
    // tab (#812 #823) and opens on it. The Table lens is gone (#486): a
    // note's sub-notes are a section of its content page.
    const stamp = Date.now();
    const parent = await (await page.request.post("/api/canvases", { ...H, data: { title: `Lens parent ${stamp}` } })).json() as { id: string };
    await page.request.post("/api/nodes", { ...H, data: { title: `Lens child ${stamp}`, markdown: "c", parent_id: parent.id } });
    await page.goto(`/?view=notes&node=${parent.id}`, { waitUntil: "load" });
    const tab = (name: string) => page.locator(`.view-tabs [role=tab]:has-text("${name}")`);
    await expect(tab("Canvas")).toHaveAttribute("aria-selected", "true");
    await expect(tab("Table")).toHaveCount(0);
    await tab("Content").click();
    await expect(page).toHaveURL(/lens=editor/);
    await tab("Canvas").click();
    await expect(page).toHaveURL(/lens=canvas/);
    await expect(tab("Canvas")).toHaveAttribute("aria-selected", "true");
    await tab("Content").click();
    await expect(page).toHaveURL(/lens=editor/);
    const tasks = page.locator(".app-topbar").getByRole("button", { name: "Tasks", exact: true });
    await tasks.click();
    await expect(page).toHaveURL(/view=tasks/);
    await expect(tasks).toHaveAttribute("aria-current", "page");
  });

  test("command palette opens from the topbar and accepts a query", async ({ page }) => {
    await page.goto("/?view=notes", { waitUntil: "load" });
    await page.locator(".palette-trigger").click();
    const palette = page.locator('input[placeholder*="earch"], [role="dialog"] input').first();
    await expect(palette).toBeVisible();
    await palette.fill("E2E");
    await page.keyboard.press("Escape");
  });

  test("Today opens a daily note", async ({ page }) => {
    await page.goto("/?view=notes", { waitUntil: "load" });
    await page.keyboard.press("ControlOrMeta+Shift+D"); // the topbar Today button is gone (daily-notes module)
    // A node is now focused (daily note) — URL carries ?node= or the editor
    // shows a date heading. Poll the disjunction instead of sleeping.
    await expect.poll(async () => {
      if (/node=/.test(page.url())) return true;
      const heading = (await page.locator("h1, h2").first().textContent().catch(() => "")) || "";
      return /\d{4}-\d{2}-\d{2}/.test(heading);
    }).toBe(true);
  });

  test("clicking a node in the sidebar opens it (selection → URL + editor)", async ({ page }) => {
    const node = await makeNode(page, `Nav target ${Date.now()}`, "nav body");
    await page.goto("/?view=notes", { waitUntil: "load" });
    // New notes list after older ones and a long list is windowed: scroll to its row.
    await (await scrollToSidebarRow(page, node.id)).locator(".obsidian-page-button").click();
    await expect(page).toHaveURL(new RegExp(`node=${node.id}`));
    // The title isn't a semantic heading; assert the editor opened THIS node by
    // its body content instead.
    await expect(page.locator(".cm-content").first()).toContainText("nav body");
  });

  test("quick capture mints a real node in the inbox (D4 — not appended body text)", async ({ page }) => {
    await page.goto("/?view=notes", { waitUntil: "load" });
    const body = `e2e capture ${Date.now()}`;
    // Open the capture sheet via its global shortcut channel (the FAB is mobile-first).
    await openQuickCapture(page);
    const ta = page.locator(".quick-capture-textarea");
    await expect(ta).toBeVisible();
    await ta.fill(body);
    await saveQuickCapture(page);
    // It lands as a real node (title = first line) carrying the inbox tag (the
    // usual place, modules/capture/captureDestination), with the captured text
    // as its body — taggable/linkable, not appended into a daily-note blob.
    const inboxTag = await ensureInbox(page);
    await expect.poll(async () => {
      const r = await page.request.get("/api/bootstrap");
      const b = r.ok() ? await r.json() : {};
      const n = (b.nodes ?? []).find((x: { title?: string }) => x.title === body);
      return n ? { inInbox: [...(n.class_tag_ids ?? []), ...(n.label_tag_ids ?? [])].includes(inboxTag), bodyOk: (n.markdown || "").includes(body) } : null;
    }, { timeout: 10_000 }).toEqual({ inInbox: true, bodyOk: true });
  });

  test("editing a node body in the editor persists through the stack", async ({ page }) => {
    const node = await makeNode(page, `Edit target ${Date.now()}`, "original");
    await page.goto(`/?view=notes&node=${node.id}`, { waitUntil: "load" });
    const editor = page.locator(".cm-content").first();
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press("End");
    const stamp = `edited-${Date.now()}`;
    await page.keyboard.type(`\n${stamp}`);
    const save = page.locator('button:has-text("Save")').first();
    if (await save.isEnabled().catch(() => false)) await save.click();
    // Confirm the edit persisted through the stack: a new body_hash version
    // carrying the stamp must appear (the version-history endpoint is the
    // reliable read path; it's what surfaces NODE_UPDATED bodies).
    await expect.poll(async () => {
      const r = await page.request.get(`/api/nodes/${node.id}/versions`);
      const list = r.ok() ? await r.json() : [];
      return Array.isArray(list) && list.some((v: { markdown?: string }) => (v.markdown || "").includes(stamp));
    }, { timeout: 15_000 }).toBeTruthy();
  });
});
