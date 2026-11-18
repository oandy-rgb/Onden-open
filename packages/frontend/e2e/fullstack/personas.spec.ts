import { makeReviewCard } from "./reviewFixtures";
import { test, expect, type Page } from "@playwright/test";
import { createAgent, ready, openNoteDecisions, openInfoFunctions, openPublishRow, defaultSpaceId, createPublishingSpace, seedLayout, publishSite, H } from "./helpers";

// PERSONA INTENT journeys — the same primitives the feature specs cover, but
// chained the way a given OCCUPATION actually works, asserting the FELT end
// state of that profession's intent (the student's facts come back as cards;
// the writer's post is publicly readable; the researcher's question is answered
// from their own notes; the PM's work is partitioned by urgency; the editor's
// words survive an agent rewrite; the designer's ideas cluster on a board).
// Stamped titles keep every run idempotent on the shared onden_test stack.
const SHOTS = "/tmp/pw-output/shots";

// Cold start runs a membership reconcile that briefly raises the fail-closed
// gate (an inert scrim). Wait it out before driving the workspace, or an early
// click/keypress lands on the scrim and is swallowed (flaky — see agenda).
async function settled(page: Page, url: string): Promise<void> {
  await ready(page, url);
  await expect(page.locator(".membership-gate")).toHaveCount(0, { timeout: 15_000 });
}

const mkNote = async (page: Page, title: string, markdown: string, space_id?: string): Promise<{ id: string; slug: string }> =>
  (await (await page.request.post("/api/nodes", { ...H, data: { space_id: space_id ?? await defaultSpaceId(page.request), title, markdown } })).json());

// 1 — STUDENT: capture a lecture fact, mark it for review, recall+grade it, and
//     it leaves today's queue — the retention loop a student lives in.
test("student: a captured fact becomes a review card, graded, and leaves the queue", async ({ page }) => {
  const stamp = Date.now();
  const title = `Mitochondria ${stamp}`;
  const note = await mkNote(page, title, "# Lecture\n\nThe mitochondrion is the powerhouse of the cell.");

  // Enrol the #review capability: the tag's review function must be enabled
  // since tags became a module center (358f3f7); the shared fixture does both.
  await makeReviewCard(page.request, note.id);

  // The review line lives on the HOME node's start strip; pin a home + land on it.
  const home = await mkNote(page, `Home ${stamp}`, "# Home");
  await page.request.patch("/api/workspace", { ...H, data: { home_node_id: home.id } });

  await settled(page, `/?view=notes&node=${home.id}`);
  // Home surfaces the due line; open the review drawer and grade our card.
  const line = page.locator(".home-start-review");
  await expect(line).toBeVisible({ timeout: 15_000 });
  await line.locator("button").first().click();
  const panel = page.locator(".review-panel");
  await expect(panel).toBeVisible();

  let graded = false;
  for (let i = 0; i < 12 && !graded; i++) {
    if (await panel.getByText(/Done — \d+ reviewed/).isVisible().catch(() => false)) break;
    graded = (await panel.locator(".review-card-title").textContent().catch(() => "")) === title;
    await panel.locator(".review-reveal").click();            // recall gate before grading
    await panel.getByRole("button", { name: /Good/ }).click();
  }
  expect(graded).toBe(true);
  // Server truth: FSRS scheduled the card (a real spaced-repetition state landed).
  await expect.poll(async () => {
    const { state } = await (await page.request.get(`/api/review/${note.id}/state`)).json();
    return state !== null;
  }).toBe(true);
  await page.screenshot({ path: `${SHOTS}/persona-student.png` });
});

// 2 — WRITER / BLOGGER: draft a post that links a reference note, publish it,
//     and read it back on the public site — draft → publish → live.
test("writer: a drafted post with a wikilink publishes and is publicly readable", async ({ page }) => {
  const stamp = Date.now();
  const marker = `PUBPOST${stamp}`;
  // A space that publishes puts its notes on the site (owner 2026-11-10, 211dda77): no per-note opt-in any more.
  // The default space does not publish, so the post lives in one that does.
  const site = await createPublishingSpace(page.request);
  await mkNote(page, `About ${stamp}`, "I write about gardens.", site);
  const post = await mkNote(page, `Field notes ${stamp}`, `# Field notes\n\n${marker} — see [[About ${stamp}]] for who I am.`, site);

  await settled(page, `/?view=notes&node=${post.id}`);
  // 功能 › 網站: the row says the note goes live with the next site publish.
  await openInfoFunctions(page);
  const { unpublish, status } = await openPublishRow(page);
  await expect(unpublish).toBeVisible({ timeout: 10_000 });
  await expect(status).toHaveText(/^Goes (on the site|live with the next site publish)$/);

  // Snapshot model B (docs/architecture/site-render-model.md): the note is only
  // on the next snapshot; /api/site serves the last PUBLISHED snapshot, so publish.
  await publishSite(page.request);

  // The served site now carries the post, and its body renders at /site.
  await expect
    .poll(async () => (await (await page.request.get("/api/site")).json()).payload?.nodes?.some((n: { id: string }) => n.id === post.id))
    .toBe(true);
  const html = await (await page.request.get(`/site/${post.slug}`)).text();
  expect(html).toContain(marker);
  await page.goto(`/site/${post.slug}`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOTS}/persona-writer-site.png`, fullPage: true });
});

// 4 — PROJECT MANAGER: see the plan partitioned by urgency (overdue / today /
//     unscheduled) — the at-a-glance triage a PM opens the day with.
test("project manager: tasks partition into overdue, today, and unscheduled buckets", async ({ page }) => {
  const stamp = Date.now();
  const host = await mkNote(page, `Sprint ${stamp}`, "# Sprint board");
  const day = (offset: number): string => {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const mkTask = (title: string, due?: string) =>
    page.request.post(`/api/nodes/${host.id}/tasks`, { ...H, data: due ? { title, due_date: due } : { title } });
  await mkTask(`Ship release ${stamp}`, day(-3)); // overdue
  await mkTask(`Standup ${stamp}`, day(0));       // today
  await mkTask(`Backlog grooming ${stamp}`);      // unscheduled

  await settled(page, "/?view=tasks");
  // Tasks page since 2026-11-09 (changes/2026-11-09-tasks-today.md): 今天 lists what is late or
  // due by tomorrow in its own card at the top, 「可以排進今天的」, each row saying which day it was
  // left over from; the day's tasks without a slot are under 「還沒排時間」; a task with no date is in 隨時.
  const today = page.getByRole("tabpanel", { name: /^Today/ });
  const candidates = today.getByRole("region", { name: /^Can go on today/ });
  const notScheduled = today.getByRole("region", { name: "Not scheduled yet" });
  const row = (scope: typeof page | typeof today, title: string) => scope.locator(".tk-row", { hasText: title });
  await expect(row(candidates, `Ship release ${stamp}`)).toBeVisible({ timeout: 15_000 });
  await expect(row(candidates, `Ship release ${stamp}`)).toContainText(/Left over from/);
  await expect(row(notScheduled, `Ship release ${stamp}`)).toHaveCount(0);
  await expect(row(notScheduled, `Standup ${stamp}`)).toBeVisible();
  await expect(row(candidates, `Standup ${stamp}`)).toHaveCount(0);
  await expect(row(today, `Backlog grooming ${stamp}`)).toHaveCount(0);
  await page.getByRole("tab", { name: /^Anytime/ }).click();
  const anytime = page.getByRole("tabpanel", { name: /^Anytime/ });
  await expect(row(anytime, `Backlog grooming ${stamp}`)).toBeVisible();
  await expect(row(anytime, `Ship release ${stamp}`)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/persona-pm-agenda.png`, fullPage: true });
});

// 5 — EDITOR governing an AI: an agent rewrites a note; the editor rejects it in
//     the inbox and their original words come back (the governance differentiator).
test("editor: rejecting an agent's rewrite restores the original words", async ({ page }) => {
  const stamp = Date.now();
  const original = `MYWORDS${stamp} — the careful original draft.`;
  const note = await mkNote(page, `Briefing ${stamp}`, original);

  // An agent (bearer token, MCP-only) rewrites the note wholesale.
  // An AI role that edits directly (「直接編輯」); a new agent would only suggest (2026-10-30).
  const agentH = { headers: (await createAgent(page.request, `Ghostwriter ${stamp}`, { reviewRule: "apply" })).headers };
  const upd = await page.request.post("/api/mcp/tools/updateNode", { ...agentH, data: { args: { id: note.id, title: `Briefing ${stamp}`, markdown: "The agent replaced everything. Your words are gone.", base_markdown: original } } });
  expect(upd.ok()).toBeTruthy();

  await settled(page, "/?view=notes");
  // The inbox's 「等你決定」 lists the note; its review card is decided in the note itself
  // (review → inbox, 2026-10-30; helper openNoteDecisions).
  const listed = await openNoteDecisions(page, `Briefing ${stamp}`);
  const item = page.locator(".inbox-review-item").first();
  await page.screenshot({ path: `${SHOTS}/persona-editor-inbox.png` });
  await item.locator(".inbox-review-reject").click();
  await expect(page.locator(".inbox-review-item")).toHaveCount(0);
  await page.locator('.sidebar-tab:has-text("Inbox")').click();
  await expect(listed).toHaveCount(0);

  // Inverse-undo: the latest version is the editor's original again.
  await expect
    .poll(async () => (await (await page.request.get(`/api/nodes/${note.id}/versions`)).json())[0]?.markdown)
    .toContain(`MYWORDS${stamp}`);
});

// 6 — DESIGNER: ideate on the canvas — cards on a board, colour-code one, and
//     the layout persists (the visual-thinking surface a designer works in).
test("designer: cards on a canvas can be colour-coded and the board persists", async ({ page }) => {
  const stamp = Date.now();
  // Canvas cards reference real content nodes by nodeId (not inline cards).
  const a = await mkNote(page, `Hero ${stamp}`, "Hero concept");
  const b = await mkNote(page, `Type ${stamp}`, "Typography");
  const canvas = await (await page.request.post("/api/canvases", { ...H, data: { title: `Moodboard ${stamp}` } })).json();
  await seedLayout(page.request, canvas.id, {
    ...H,
    data: { data: {
      nodes: [
        { nodeId: a.id, x: 80, y: 80, width: 240 },
        { nodeId: b.id, x: 360, y: 80, width: 240 },
      ],
      edges: [],
    } },
  });

  await settled(page, `/?view=notes&node=${canvas.id}`);
  await expect(page.locator(".react-flow__node")).toHaveCount(2, { timeout: 30_000 });

  // Select the cards (titles render as input values, so select by position) →
  // the align bar's swatches colour them in one write.
  await page.locator(".react-flow__node").first().click();
  await page.locator(".react-flow__node").nth(1).click({ modifiers: ["Meta"] });
  const bar = page.locator(".canvas-align-bar");
  await expect(bar).toBeVisible();
  await bar.locator('button[title="Red"]').click();
  await expect.poll(async () => {
    const saved = await (await page.request.get(`/api/canvases/${canvas.id}`)).json();
    return (saved.data?.nodes ?? []).some((n: { color?: string }) => !!n.color);
  }, { timeout: 10_000 }).toBe(true); // colour persisted server-side = the board is durable
  await page.screenshot({ path: `${SHOTS}/persona-designer-canvas.png` });
});
