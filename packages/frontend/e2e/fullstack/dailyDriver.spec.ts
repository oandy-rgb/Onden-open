import { test, expect, type Page } from "@playwright/test";
import { ready, openQuickCapture, saveQuickCapture, ensureInbox, openTasksTab, taskRow, pollBootstrap, H } from "./helpers";

// Behaviour-driven journeys over the daily-driver loop (capture → task →
// daily-note → link) — the retention core. Drive the real UI the way a person
// would and assert the felt result + that it persisted server-side.
//
// Every fixture title carries a per-test stamp so the suite is idempotent
// against the shared onden_test DB (no cleanup between runs) — exactly one row
// matches, so strict-mode locators and "count 0" assertions stay honest.
const SHOTS = "/tmp/pw-output/shots";

async function bootstrap(page: Page) {
  return (await page.request.get("/api/bootstrap")).json();
}

// 1 — Quick capture (⌘⇧N) files a fleeting note in the inbox (the place a
// capture goes when the person names none, modules/capture/captureDestination):
// a top-level note carrying the inbox tag. The box stays open for the next
// thought and says where the last one went.
test("quick capture files a note in the inbox", { tag: "@critical" }, async ({ page }) => {
  const stamp = Date.now();
  const text = `Buy milk ${stamp}`;
  await ready(page, "/?view=notes");

  await openQuickCapture(page); // polls until the capture listener is attached
  await expect(page.locator(".quick-capture-place")).toHaveText("Goes to: Inbox");
  await page.locator(".quick-capture-textarea").fill(text);
  await saveQuickCapture(page); // "Saved to …", emptied, then closed

  // Poll the server until the capture lands (no fixed sleep on the save round-trip).
  const captured = await pollBootstrap(page, (b) => b.nodes.find((n: { title: string }) => n.title === text));
  const inboxTag = await ensureInbox(page); // the tag the first capture made (idempotent)
  expect(captured.parent_id ?? null).toBeNull(); // in the inbox, not under a note
  expect([...(captured.class_tag_ids ?? []), ...(captured.label_tag_ids ?? [])]).toContain(inboxTag);
});

// 2 — Typing `[[` opens the note picker and selecting inserts a wikilink.
test("wikilink autocomplete inserts [[Title]]", { tag: "@critical" }, async ({ page }) => {
  const stamp = Date.now();
  const target = `ProjectApollo${stamp}`;
  await page.request.post("/api/nodes", { ...H, data: { title: target, markdown: "the moonshot\n" } });
  const scratch = await (await page.request.post("/api/nodes", { ...H, data: { title: `Scratch ${stamp}`, markdown: "" } })).json();
  await ready(page, `/?view=notes&node=${scratch.id}`);
  await expect(page.locator(".cm-content")).toBeVisible(); // editor mounted

  await page.locator(".cm-content").click();
  await page.keyboard.type(`link to [[${target}`); // full stamped title → single match
  await expect(page.locator(".slash-menu-title", { hasText: target })).toBeVisible();
  await page.keyboard.press("Enter");

  const text = await page.locator(".cm-content").innerText();
  expect(text).toContain(`[[${target}]]`);
  await page.screenshot({ path: `${SHOTS}/dd-wikilink.png`, fullPage: false });
});

// 3 — Checking a task off on the Tasks page marks it done and persists. A task
// with no day lives on 「Anytime」; a ticked row stays, struck through, until
// the page moves to another tab (modules/tasks/TasksMode, TasksPage.test).
test("task checkbox toggle persists as done", { tag: "@critical" }, async ({ page }) => {
  const stamp = Date.now();
  const title = `Ship ${stamp}`;
  const node = await (await page.request.post("/api/nodes", { ...H, data: { title: `Sprint ${stamp}`, markdown: "" } })).json();
  await page.request.post(`/api/nodes/${node.id}/tasks`, { ...H, data: { title } });

  await ready(page, "/?view=tasks");
  await openTasksTab(page, "Anytime");
  const row = taskRow(page, title);
  await expect(row).toBeVisible();
  await row.getByRole("checkbox", { name: `Mark ${title} done` }).click();
  await expect(row).toHaveClass(/tk-row--done/);

  // Persisted server-side, and gone from the page once it moves on.
  const task = await pollBootstrap(page, (b) =>
    b.tasks.find((t: { title: string; status: string }) => t.title === title && t.status === "done"));
  expect(task.status).toBe("done");
  await openTasksTab(page, "Today");
  await openTasksTab(page, "Anytime");
  await expect(row).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/dd-tasks.png`, fullPage: false });
});

// 4 — The page sorts tasks onto its tabs by their own fields: no day →
// Anytime, parked (`status: "later"` is todo + someday, backend tasks/update)
// → Someday, done → nowhere. An empty Today only OFFERS the Anytime ones
// (「Can do anytime」, modules/tasks/TasksMode emptyToday); they are not on its plan.
test("task tabs partition open, parked and done tasks", { tag: "@critical" }, async ({ page }) => {
  const stamp = Date.now();
  const pending = `PENDING ${stamp}`;
  const parked = `PARKED ${stamp}`;
  const finished = `FINISHED ${stamp}`;
  const node = await (await page.request.post("/api/nodes", { ...H, data: { title: `Board ${stamp}`, markdown: "" } })).json();
  await page.request.post(`/api/nodes/${node.id}/tasks`, { ...H, data: { title: pending } });
  await page.request.post(`/api/nodes/${node.id}/tasks`, { ...H, data: { title: parked } });
  await page.request.post(`/api/nodes/${node.id}/tasks`, { ...H, data: { title: finished } });
  const b0 = await bootstrap(page);
  const byTitle = (t: string) => b0.tasks.find((x: { title: string }) => x.title === t);
  expect((await page.request.patch(`/api/tasks/${byTitle(parked).id}`, { ...H, data: { status: "later" } })).ok()).toBeTruthy();
  expect((await page.request.patch(`/api/tasks/${byTitle(finished).id}`, { ...H, data: { status: "done" } })).ok()).toBeTruthy();

  await ready(page, "/?view=tasks");
  for (const [tab, shown] of [["Today", []], ["Coming up", []], ["Anytime", [pending]], ["Someday", [parked]]] as const) {
    await openTasksTab(page, tab);
    for (const title of [pending, parked, finished]) {
      // An empty Today offers the open no-day tasks under 「Can do anytime」 (an offer, not a plan: TasksMode
      // `emptyToday`), so a row inside that section does not count as being on Today.
      const offered = tab === "Today" ? page.getByRole("region", { name: /^Can do anytime/ }).locator(".tk-row", { hasText: title }) : null;
      await expect.poll(async () => (await taskRow(page, title).count()) - (offered ? await offered.count() : 0), { message: `${title} on ${tab}` })
        .toBe((shown as readonly string[]).includes(title) ? 1 : 0);
    }
  }
});
