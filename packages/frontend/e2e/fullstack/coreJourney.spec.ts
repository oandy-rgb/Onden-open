// P0-6 core-journey integration test: ONE artifact braided through every
// station of the daily loop — 捕捉 → 閱讀/摘錄 → 整理 → 複習 → 發布 — driven
// like a user ([[verify-like-a-user]]), asserting state at every hop.
// Rerun-safe on the persistent e2e DB: stamped titles, find-or-create tags,
// delta-based assertions only.
import { test, expect, type Page } from "@playwright/test";
import { ready, openQuickCapture, saveQuickCapture, ensureInbox, openPublishRow, personalSpaceId, H } from "./helpers";
import { makeReviewCard } from "./reviewFixtures";



async function findNode(page: Page, title: string) {
  const b = await (await page.request.get("/api/bootstrap")).json();
  return (b.nodes ?? []).find((n: { title?: string }) => n.title === title);
}

test("core journey: capture → read/excerpt → organize → review → publish", async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const captureTitle = `旅程筆記 ${stamp}`;
  const sourceTitle = `Source essay ${stamp}`;

  // A long "reading material" note exists (the thing being read).
  const source = await (await page.request.post("/api/nodes", {
    ...H, data: { title: sourceTitle, markdown: `# ${sourceTitle}\n\nDeep work is the ability to focus without distraction.\n\n${"filler prose. ".repeat(40)}` },
  })).json();

  // ── 1. 捕捉 — quick capture through the UI lands a REAL note in the inbox
  //       (the usual place, modules/capture/captureDestination) ──────
  await ready(page, "/?view=notes");
  await openQuickCapture(page);
  await page.locator(".quick-capture-textarea").fill(captureTitle);
  await saveQuickCapture(page);
  let note: { id: string; parent_id?: string | null; class_tag_ids?: string[]; label_tag_ids?: string[] } | undefined;
  await expect.poll(async () => (note = await findNode(page, captureTitle)) ?? null, { timeout: 10_000 }).not.toBeNull();
  const inboxTag = await ensureInbox(page);
  expect([...(note!.class_tag_ids ?? []), ...(note!.label_tag_ids ?? [])], "capture is a note of its own in the inbox, not a blob append").toContain(inboxTag);

  // ── 2. 閱讀 + 摘錄 — open the source, then quote it INTO the captured
  //       note with a provenance wikilink (the excerpt carries its source) ──
  await ready(page, `/?view=notes&node=${source.id}`);
  await expect(page.locator(".cm-content")).toContainText("Deep work");
  await ready(page, `/?view=notes&node=${note!.id}`);
  const cm = page.locator(".cm-content");
  await cm.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(`\n\n> Deep work is the ability to focus without distraction.\n\n出處 [[${sourceTitle}]]`);
  // autosave (1.5s debounce) → server body carries the excerpt + the link
  await expect.poll(async () => ((await findNode(page, captureTitle))?.markdown ?? "") as string, { timeout: 15_000 })
    .toContain("出處");
  // the backlink edge materialized (wikilink → edge sync)
  await expect.poll(async () => {
    const b = await (await page.request.get("/api/bootstrap")).json();
    return (b.edges ?? []).some((e: { source_node_id: string; target_node_id: string }) =>
      e.source_node_id === note!.id && e.target_node_id === source.id);
  }, { timeout: 15_000 }).toBe(true);

  // ── 3. 發布 — the header Share popover's "Publish to site" toggle, like a user ─────
  // A capture lives in the personal space, which publishes
  // only once its owner switches publishing on (spaces.md); switch it on for
  // this journey and back off at the end.
  const personal = await personalSpaceId(page.request);
  const setPublish = (on: boolean) => page.request.patch(`/api/spaces/${personal}`, { ...H, data: { capabilities: { publish: on } } });
  expect((await setPublish(true)).ok()).toBe(true);
  try {
  await ready(page, `/?view=notes&node=${note!.id}`);
  // The personal space now publishes, so the note is on the site by default (no mark to set): the info panel's
  // 「網站」 row offers 「不發布」, and the note is not served until the owner's next publish.
  const { unpublish } = await openPublishRow(page);
  await expect(unpublish).toBeVisible({ timeout: 10_000 });
  // The site shows what was last PUBLISHED (snapshot model B,
  // docs/architecture/site-render-model.md): marking the note only opts it
  // in. Publish from the website page the way the owner does — the preview
  // lists the note, and confirming runs the real publish.
  await ready(page, "/?view=website");
  await page.locator(".pub-publish-button").click();
  const review = page.locator(".publish-preview-dialog");
  await expect(review.locator(".publish-preview-list li", { hasText: captureTitle })).toBeVisible();
  await review.locator(".publish-preview-confirm").click();
  await expect(review).toHaveCount(0);
  // serve-time: /api/site now carries the note, with the excerpt intact
  await expect.poll(async () => {
    const site = await (await page.request.get("/api/site")).json();
    const n = (site.payload?.nodes ?? []).find((x: { id: string }) => x.id === note!.id);
    return n ? (n.markdown as string).includes("Deep work") : false;
  }, { timeout: 15_000 }).toBe(true);

  // ── 4. 整理＋複習 — make it a review card (its own reference).
  //       PINNED CONTRACT: publishability is gated by the note's SPACE,
  //       never by its tags — making a PUBLISHED note a review card KEEPS it
  //       on the public site. Learning and publishing are no longer mutually exclusive.
  await makeReviewCard(page.request, note!.id);
  await expect.poll(async () => {
    const site = await (await page.request.get("/api/site")).json();
    return (site.payload?.nodes ?? []).some((x: { id: string }) => x.id === note!.id);
  }, { timeout: 15_000 }).toBe(true);

  // grading reschedules it out of the due window
  const graded = await page.request.post(`/api/review/${note!.id}/grade`, { ...H, data: { rating: 3 } });
  expect(graded.ok(), "grading the enrolled note succeeds").toBeTruthy();
  } finally {
    await setPublish(false);
  }
});
