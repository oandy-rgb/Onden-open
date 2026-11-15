import { test, expect, type Page } from "@playwright/test";
import { ready, openNoteHistory, openNoteEditor, H } from "./helpers";

// Behaviour-driven journeys over the time-travel / editor surface — drive the
// real UI (click, type, keypress) the way a person would and assert the felt
// result, not just that it compiled. Screenshots go to SHOTS for eyeballing.
const SHOTS = "/tmp/pw-output/shots";

async function seed(page: Page, title: string, bodies: string[]) {
  const create = await page.request.post("/api/nodes", { ...H, data: { title, markdown: bodies[0] } });
  const node = await create.json();
  // raw=1: the LIST endpoint session-coalesces rapid same-actor saves, so its
  // length does NOT grow per PATCH — the raw (per-save) feed does.
  const count = async () => (await (await page.request.get(`/api/nodes/${node.id}/versions?raw=1`)).json()).length as number;
  for (const b of bodies.slice(1)) {
    const before = await count();
    await page.request.patch(`/api/nodes/${node.id}`, { ...H, data: { title, markdown: b } });
    // Wait for the version to actually be captured before the next edit (was a
    // fixed 150ms sleep) — each PATCH snapshots a new version.
    await expect.poll(count).toBeGreaterThan(before);
  }
  return node as { id: string };
}

// The editor surface for a node URL is mounted and interactive.
async function editorReady(page: Page, nodeId: string) {
  await ready(page, `/?view=notes&node=${nodeId}`);
  await expect(page.locator(".cm-content").first()).toBeVisible();
}

// A — REGRESSION GUARD: real typing must still autosave a new version. If the
// ExternalSync onChange-skip is too broad it would swallow real edits → silent
// data loss. This is the most important journey.
test("typing in the editor still autosaves a new version", async ({ page }) => {
  const node = await seed(page, "Typing demo", ["seed body\n"]);
  await editorReady(page, node.id);
  const before = (await (await page.request.get(`/api/nodes/${node.id}/versions`)).json()).length;

  await page.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type("\na line typed by a real keypress");

  // Poll /versions until the debounced (1.5s) autosave lands — no fixed sleep.
  // Read back via /versions (there is no GET /api/nodes/:id). Autosave captures a
  // new version, newest-first, so [0] is the just-typed body.
  await expect
    .poll(async () => {
      const versions = await (await page.request.get(`/api/nodes/${node.id}/versions`)).json();
      return versions.length > before && versions[0].markdown.includes("typed by a real keypress");
    }, { timeout: 15_000, message: "autosave never captured the typed body as a version" })
    .toBe(true);
});

// B — keyboard navigation on the slider: ←/→ move through the versions, Esc closes.
test("history screen supports arrow-key navigation and Esc", async ({ page }) => {
  // Distinct bodies so each version's text is visibly different.
  const node = await seed(page, "Keys demo", ["alpha\n", "alpha\nbeta\n", "alpha\nbeta\ngamma\n"]);
  await editorReady(page, node.id);
  await openNoteHistory(page);
  await page.locator(".note-history-link").click();
  await expect(page.locator(".nh")).toBeVisible();

  const before = await page.locator(".nh-paper").innerText();
  await page.locator(".nh").getByRole("slider").focus();
  await page.keyboard.press("ArrowLeft");
  // ← selected an earlier version → the text changed (auto-retrying poll, no sleep)
  await expect.poll(() => page.locator(".nh-paper").innerText()).not.toBe(before);

  await page.keyboard.press("Escape");
  await expect(page.locator(".nh")).toHaveCount(0); // Esc closed it
});

// C — choosing a version in the floating history opens that exact version,
// and restoring it (after a refused first try) restores the editor. The
// inspector's recent-version rows were folded into the header's 「Version
// history」 link (c38ff179): one dialog, opened from the note header.
test("version history opens the chosen version and restores the editor", async ({ page }) => {
  const node = await seed(page, "Inline demo", ["FIRST body\n", "SECOND body changed\n"]);
  await editorReady(page, node.id);

  await openNoteHistory(page);
  await page.locator(".note-history-link").click();
  await expect(page.locator(".nh")).toBeVisible();
  // The version list shows Now, then the versions newest-first; the LAST
  // row is the oldest (FIRST body).
  await page.locator(".nh-versions .nh-row").last().click();
  await expect(page.locator(".nh-paper")).toContainText("FIRST body");
  const restoreKeys: string[] = [];
  await page.route(`**/api/nodes/${node.id}/versions/*/restore`, async (route) => {
    restoreKeys.push(route.request().headers()["idempotency-key"] ?? "");
    if (restoreKeys.length === 1) await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporarily unavailable" }) });
    else await route.continue();
  });
  await page.locator(".nh-actions .ui-btn--primary").click();
  await expect(page.locator(".nh-notice")).toBeVisible(); // the refusal's reason
  await expect(page.locator(".nh-paper")).toContainText("FIRST body");
  expect((await (await page.request.get(`/api/nodes/${node.id}`)).json()).markdown).toContain("SECOND body");
  await page.locator(".nh-actions .ui-btn--primary").click();
  await expect(page.locator(".nh-notice", { hasText: /Went back|已回到/ })).toBeVisible();
  expect(restoreKeys).toHaveLength(2);
  expect(restoreKeys[0]).not.toBe("");
  expect(restoreKeys[1]).toBe(restoreKeys[0]);
  await expect.poll(async () => (await (await page.request.get(`/api/nodes/${node.id}`)).json()).markdown).toContain("FIRST body");
  await page.getByRole("button", { name: /^(Back|返回)$/ }).click();
  await openNoteEditor(page);

  // The restore round-trips through the API and re-syncs the editor; the
  // auto-retrying assertion IS the wait.
  await expect(page.locator(".cm-content").first()).toContainText("FIRST body");
});

// D — single-version node: the modal must render (its one stored version, which IS
// now: no extra "Now" identical to the newest version since 2026-11-02,
// changes/2026-11-02-no-empty-history-points.md), not crash on the
// oldest-diff-against-empty path.
test("history view renders for a brand-new single-version node", async ({ page }) => {
  const node = await seed(page, "Single demo", ["just one version\n"]);
  await editorReady(page, node.id);
  await openNoteHistory(page);
  await page.locator(".note-history-link").click();
  await expect(page.locator(".nh")).toBeVisible();
  // Exactly one stored version, shown as the version being edited.
  await expect(page.locator(".nh-versions .nh-row")).toHaveCount(1);
  await expect(page.locator(".nh-paper")).toContainText("just one version");
  await expect(page.locator(".nh-now-note")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/jr-single-version.png`, fullPage: false });
});

// E — slider on Now → no restore button, "this is the current version" note shown.
test("landing on Now shows no restore action", async ({ page }) => {
  const node = await seed(page, "Current demo", ["v1\n", "v2\n"]);
  await editorReady(page, node.id);
  await openNoteHistory(page);
  await page.locator(".note-history-link").click();
  await page.locator(".nh").getByRole("slider").press("End");
  await expect(page.locator(".nh-now-note")).toBeVisible();
  await expect(page.locator(".nh-actions .ui-btn--primary")).toHaveCount(0);
});
