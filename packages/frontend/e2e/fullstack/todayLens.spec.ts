import { test, expect } from "@playwright/test";
import { ready, openQuickCapture, saveQuickCapture, openNavDestination, pollBootstrap } from "./helpers";

// Today lens — the day's activity, drawn on the Journal page (one day at a
// time since 2026-10-31, modules/daily/day/DayPage + DaySections): a note
// captured today lists under 「Happened this day」 as Created, and the row
// opens it. Drive the real loop a person would: capture via the UI, open the
// Journal, click the row.
//
// Rerun-safe: every fixture title carries a per-test stamp (the shared
// onden_test DB persists across runs). The section shows the newest few and
// folds the rest behind 「N more notes」, so unfold it when it is there.

test("today lens: a note captured today lists under Happened this day and navigates", async ({ page }) => {
  const stamp = Date.now();
  const title = `Lens probe ${stamp}`;
  await ready(page, "/?view=notes");

  // Capture a note through the UI (quick capture — the daily-driver entry).
  await openQuickCapture(page); // polls until the capture listener is attached
  await page.locator(".quick-capture-textarea").fill(title);
  await saveQuickCapture(page);

  // Poll the server until the capture lands (no fixed sleep on the round-trip).
  const captured = await pollBootstrap(page, (b) => b.nodes.find((n: { title: string }) => n.title === title));
  expect(captured, "the capture landed server-side").toBeTruthy();

  // Open the Journal: it shows today.
  await openNavDestination(page, "Daily notes");
  const day = page.locator(".day-page");
  await expect(day).toBeVisible();
  const dayTitle = await day.getAttribute("data-date");
  expect(dayTitle).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  // The capture lists under Happened this day, marked Created.
  const happened = page.getByRole("region", { name: "Happened this day" });
  const more = happened.getByRole("button", { name: /more notes$/ });
  const row = happened.locator(".day-happened-row").filter({ hasText: title });
  await expect(row.or(more).first()).toBeVisible();
  if (await more.isVisible()) await more.click();
  await expect(row).toBeVisible();
  await expect(row.locator(".day-happened-kind")).toHaveText("Created");

  // The day node itself never lists in its own lens (assert via the endpoint —
  // rows render titles, and the day note's title is the date itself).
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const dayNode = boot.nodes.find((n: { title: string; node_type: string }) => n.title === dayTitle);
  const lensData = await (await page.request.get(`/api/day/${dayTitle}/lens`)).json();
  for (const key of ["created", "edited", "agent"] as const) {
    expect(
      (lensData.buckets[key]?.items ?? []).some((n: { id: string }) => n.id === dayNode?.id),
      `day node must not appear in its own ${key} bucket`,
    ).toBe(false);
  }

  // Clicking the row navigates to the captured note.
  await row.click();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("node"), { timeout: 10_000 })
    .toBe(captured.id);
});
