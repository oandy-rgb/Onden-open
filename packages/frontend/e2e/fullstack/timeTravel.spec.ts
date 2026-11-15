import { test, expect, type Page } from "@playwright/test";
import { createAgent, ready, requireAdmin, openNoteHistory, openNoteEditor, H } from "./helpers";

// Self-verification screenshots for the note history "time travel" feature.
// Builds a node whose history mixes an AGENT author (via the MCP tool surface)
// and the human, so the actor-coloured diff + the Authorship ("who wrote what")
// view have real ai_agent lines to tint. Not an assertion suite.
const SHOTS = "/tmp/pw-output/shots";

async function agentHeaders(page: Page, name: string) {
  // An AI role that edits directly (「直接編輯」): a new agent may only suggest, and a suggest-only agent cannot apply tags or create notes (suggest_only, 2026-10-30).
  return { headers: (await createAgent(page.request, name, { reviewRule: "apply" })).headers };
}

test("time travel history view", async ({ page }) => {
  const stamp = Date.now();
  const agentH = await agentHeaders(page, `Drafting agent ${stamp}`);
  requireAdmin(!!agentH, "actor creation needs admin; skipped");

  // v1 — the AGENT drafts the note (bearer goes through the MCP tool surface).
  const created = await page.request.post("/api/mcp/tools/createNode", {
    ...agentH!,
    data: { args: {
      title: "Weekly plan",
      markdown: "# Weekly plan\nThe agent drafted this summary for you.\n- Ship the history view\n- Review the diff colours\n",
    } },
  });
  expect(created.ok()).toBeTruthy();
  const node = (await created.json()).result as { id: string };

  // v2 — the HUMAN appends a couple of lines (cookie auth → /api/nodes PATCH).
  await page.request.patch(`/api/nodes/${node.id}`, {
    ...H,
    data: { title: "Weekly plan", markdown: "# Weekly plan\nThe agent drafted this summary for you.\n- Ship the history view\n- Review the diff colours\nI added this line myself.\nAnd one more from me.\n" },
  });

  await ready(page, `/?view=notes&node=${node.id}`);

  await openNoteHistory(page);
  const open = page.locator(".note-history-link");
  await open.waitFor({ timeout: 15_000 });
  await open.click();
  await expect(page.locator(".nh")).toBeVisible();

  // Move the slider to the OLDEST (agent) version: its paragraphs are all new and tinted.
  await page.locator(".nh").getByRole("slider").press("Home");
  await expect(page.locator(".nh-p--added").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/tt-04-agent-changes.png`, fullPage: false });

  // Hold to see now: the live body, with no marks.
  await page.getByRole("button", { name: /^(Hold to see now|按住看現在)$/ }).dispatchEvent("pointerdown");
  await expect(page.locator(".nh-p--added, .nh-p--changed")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/tt-05-hold-now.png`, fullPage: false });
});

test("restore through the real UI updates the editor body", async ({ page }) => {
  // Setup (API) — a node with two clearly different bodies, so a restore is
  // unmistakable. The thing under test is the UI restore interaction, not seeding.
  const create = await page.request.post("/api/nodes", {
    ...H,
    data: { title: "Restore demo", markdown: "ORIGINAL BODY line one\nORIGINAL line two" },
  });
  const node = await create.json();
  await page.request.patch(`/api/nodes/${node.id}`, {
    ...H,
    data: { title: "Restore demo", markdown: "NEW BODY totally different\nsecond new line\nthird new line" },
  });

  await ready(page, `/?view=notes&node=${node.id}`);
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/rt-00-before.png`, fullPage: false });

  // Drive the real UI: open history → pick the oldest (ORIGINAL) version → Restore.
  await openNoteHistory(page);
  await page.locator(".note-history-link").click();
  await expect(page.locator(".nh")).toBeVisible();
  await page.locator(".nh").getByRole("slider").press("Home");
  await page.locator(".nh-actions .ui-btn--primary").click();
  await expect(page.locator(".nh-notice")).toBeVisible();
  await page.getByRole("button", { name: /^(Back|返回)$/ }).click();
  await openNoteEditor(page);

  // The restore round-trips through the API and re-syncs the editor — the
  // auto-retrying assertion IS the wait (was a fixed 1.5s sleep + console.log).
  await expect(page.locator(".cm-content").first()).toContainText("ORIGINAL BODY");
  await page.screenshot({ path: `${SHOTS}/rt-01-after-restore.png`, fullPage: false });
});

// The History page is the whole workspace and nothing else: no "this note / everything" switch and
// no subtitle repeating the title. One note's history is its time slider. Old links still open:
// ?view=timeline is this page, ?lens=timeline is the note's editor.
test("history page: whole workspace only, old links still open", async ({ page }) => {
  const stamp = Date.now();
  const node = (await (await page.request.post("/api/nodes", {
    ...H,
    data: { title: `Scoped ${stamp}`, markdown: "v1" },
  })).json()) as { id: string };
  await page.request.patch(`/api/nodes/${node.id}`, { ...H, data: { markdown: "v2 edited" } });

  await ready(page, "/?view=timeline");
  await expect(page.locator(".node-lens-title")).toHaveText("History");
  await expect(page.locator(".node-lens-sub")).toHaveCount(0);
  // The page's own chrome: the Changes / Recently deleted tabs.
  await expect(page.getByRole("tab", { name: "Changes", exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("tab", { name: "Recently deleted", exact: true })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/tt-06-history-page.png`, fullPage: false });

  // The old per-note History link opens that note's editor, not a dead page.
  await ready(page, `/?view=notes&node=${node.id}&lens=timeline`);
  await expect(page).not.toHaveURL(/lens=timeline/);
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
});
