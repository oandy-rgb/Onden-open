import { test, expect, type Page } from "@playwright/test";
import { ready, openNoteHistory, openNoteEditor, H } from "./helpers";

// Edge & interaction journeys for the expanded history view — the corners where
// compare / split / restore / navigation meet. Drive the real UI and assert the
// felt result.
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

// Session-coalesced history (shipped 2026-06-12) collapses rapid SAME-actor
// saves into ONE timeline row, so three quick edits yield only two versions —
// not enough for the multi-version compare/nav edge cases below. A RESTORE is a
// session boundary, so interleaving one forces genuinely distinct version rows.
// Yields these timeline rows (newest → oldest); the newest version is "now", with no
// separate "Now" row (changes/2026-11-02-no-empty-history-points.md):
//   0 "V3 gamma" (now) · 1 "V1 alpha" (restored) · 2 "V2 beta" · 3 "V1 alpha" (created)
async function seedDistinctVersions(page: Page, title: string): Promise<{ id: string }> {
  const node = await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: "V1 alpha\n" } })).json() as { id: string };
  await page.request.patch(`/api/nodes/${node.id}`, { ...H, data: { title, markdown: "V2 beta\n" } });
  await page.waitForTimeout(150);
  const raw = await (await page.request.get(`/api/nodes/${node.id}/versions?raw=1`)).json() as Array<{ id: number; markdown: string }>;
  const createV = raw.find((v) => v.markdown.trim() === "V1 alpha")!;
  await page.request.post(`/api/nodes/${node.id}/versions/${createV.id}/restore`, { ...H, data: {} }); // session boundary
  await page.waitForTimeout(150);
  await page.request.patch(`/api/nodes/${node.id}`, { ...H, data: { title, markdown: "V3 gamma\n" } });
  await page.waitForTimeout(150);
  return node;
}

async function openHistory(page: Page, nodeId: string) {
  await ready(page, `/?view=notes&node=${nodeId}`);
  await openNoteHistory(page);
  await page.locator(".note-history-link").click(); // 「Edited …」 under the title opens history (a586de1a)
  await expect(page.locator(".nh")).toBeVisible();
}

// The history screen is a time slider (NoteHistory): the comparison-baseline,
// split-layout and authorship views of the old dialog no longer exist. The
// slider is a role="slider" track (HistorySlider), moved with its keys:
// Home = oldest, End = now, ← → one version.
const slider = (page: Page) => page.locator(".nh").getByRole("slider");
const goBack = (page: Page) => page.locator(".nh-actions .ui-btn--primary");

// 1 — the arrow keys walk the slider and the shown version follows.
test("arrow keys move through the versions", async ({ page }) => {
  const node = await seedDistinctVersions(page, "Keys demo");
  await openHistory(page, node.id);
  await slider(page).focus();
  const before = await page.locator(".nh-paper").innerText();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => page.locator(".nh-paper").innerText()).not.toBe(before);
  await page.keyboard.press("End");
  await expect(page.locator(".nh-now-note")).toBeVisible();
});

// 2 — holding the "see now" button shows the present without marks; releasing returns.
test("holding 'see now' shows the present unmarked and releases back", async ({ page }) => {
  const node = await seed(page, "Hold demo", ["a\n", "a\n\nb\n"]);
  // The newest version is "now" (no separate Now point since 2026-11-02), so the version
  // that added "b" needs a later present: go back to the first text (a restore is its own point).
  const raw = await (await page.request.get(`/api/nodes/${node.id}/versions?raw=1`)).json() as Array<{ id: number; markdown: string }>;
  const first = raw.find((v) => v.markdown === "a\n")!;
  await page.request.post(`/api/nodes/${node.id}/versions/${first.id}/restore`, { ...H, data: {} });
  await expect.poll(async () => (await (await page.request.get(`/api/nodes/${node.id}`)).json()).markdown).toBe("a\n");
  await openHistory(page, node.id);
  await slider(page).press("Home");
  await slider(page).press("ArrowRight");
  await expect(page.locator(".nh-p--added").first()).toBeVisible();
  const hold = page.getByRole("button", { name: /^(Hold to see now|按住看現在)$/ });
  await hold.dispatchEvent("pointerdown");
  await expect(page.locator(".nh-p--added, .nh-p--changed")).toHaveCount(0);
  await hold.dispatchEvent("pointerup");
  await expect(page.locator(".nh-p--added").first()).toBeVisible();
});

// 3 — "go back to this version" restores the shown version, not another one.
test("going back restores the shown version", async ({ page }) => {
  const node = await seedDistinctVersions(page, "Restore demo");
  await openHistory(page, node.id);
  // rows: 0 = "V3 gamma" (now), 1 = "V1 alpha" (restored), 2 = "V2 beta", 3 = "V1 alpha" (oldest)
  await page.locator(".nh-versions .nh-row").nth(2).click();
  await expect(page.locator(".nh-paper")).toContainText("V2 beta");
  await goBack(page).click();
  await expect(page.locator(".nh-notice")).toBeVisible();
  await page.getByRole("button", { name: /^(Back|返回)$/ }).click();
  await openNoteEditor(page);
  const body = page.locator(".cm-content").first();
  await expect(body).toContainText("V2 beta");
  await expect(body).not.toContainText("V3 gamma");
});

// 4 — "take back this paragraph" changes only that paragraph of the note.
test("taking back one paragraph leaves the rest of the note alone", async ({ page }) => {
  const node = await seed(page, "Paragraph demo", ["keep\n\nold wording\n", "keep\n\nnew wording\n\nlater line\n"]);
  await openHistory(page, node.id);
  await slider(page).press("Home");
  await page.locator(".nh-p--pick", { hasText: "old wording" }).click();
  await page.getByRole("button", { name: /^(Take back this paragraph|拿回這段)$/ }).click();
  await expect(page.locator(".nh-notice")).toBeVisible();
  await expect.poll(async () => (await (await page.request.get(`/api/nodes/${node.id}`)).json()).markdown).toBe("keep\n\nold wording\n\nlater line\n");
});
