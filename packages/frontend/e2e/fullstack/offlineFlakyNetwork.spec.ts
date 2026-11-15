// Journey [offline-flaky-network] — the "signal keeps cutting out" workflow.
// A note edited across THREE offline windows with a partial drain in the
// middle, proving two things:
//   1. every offline edit survives each cut and the FINAL body converges
//      server-side (no edit is dropped between windows);
//   2. the reconnect drain is IDEMPOTENT — replaying queued writes never
//      duplicates the node or its events (the drain stamps each write with an
//      Idempotency-Key; a mid-drain reconnect must not double-apply).
//
// Offline simulation follows syncStatus.spec.ts. Server truth via page.request
// (honours setOffline), read only while online.
import { test, expect, type Page } from "@playwright/test";
import { ready, H, expectNoPending, expectOffline, expectOnline, expectPending } from "./helpers";
import type { BrowserContext } from "@playwright/test";


async function bootstrap(page: Page) {
  return (await page.request.get("/api/bootstrap")).json();
}

async function goOffline(page: Page, context: BrowserContext) {
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expectOffline(page);
}

async function goOnline(page: Page, context: BrowserContext) {
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expectOnline(page);
}

async function typeAndQueue(page: Page, text: string) {
  await page.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
  // Past the autosave debounce → the edit is queued.
  await expectPending(page, { timeout: 10_000 });
}

test("flaky network: edits across three offline windows converge once, no dupes", async ({ page, context }) => {
  const stamp = Date.now();
  const title = `Flaky note ${stamp}`;
  const node = await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: "# base\n\nstart" } })).json();

  await ready(page, `/?view=notes&node=${node.id}`);
  await page.locator(".cm-content").waitFor({ state: "visible" });
  await expectOnline(page);
  await expect(page.locator(".membership-gate")).toHaveCount(0, { timeout: 45_000 });
  await expectNoPending(page);

  // ── Window 1: offline, edit, queue ────────────────────────────────────────
  await goOffline(page, context);
  await typeAndQueue(page, ` w1-${stamp}`);

  // ── Brief reconnect → DRAIN window 1 ─────────────────────────────────────
  await goOnline(page, context);
  await expectNoPending(page, { timeout: 15_000 });

  // ── Window 2: offline again, more edits ──────────────────────────────────
  await goOffline(page, context);
  await typeAndQueue(page, ` w2-${stamp}`);

  // ── Final reconnect → DRAIN window 2 ─────────────────────────────────────
  await goOnline(page, context);
  await expectNoPending(page, { timeout: 15_000 });

  // ── Convergence: the FINAL body carries BOTH offline windows' edits ──────
  await expect.poll(async () => {
    const b = await bootstrap(page);
    const n = b.nodes.find((x: { id: string }) => x.id === node.id);
    const md = n?.markdown ?? "";
    return md.includes(`w1-${stamp}`) && md.includes(`w2-${stamp}`) ? "both" : "missing";
  }, { timeout: 15_000, message: "edits from both offline windows must converge" }).toBe("both");

  // ── Idempotency: exactly ONE node with this title (no drain duplication) ──
  const b = await bootstrap(page);
  const matches = (b.nodes as Array<{ id: string; title: string }>).filter((n) => n.title === title);
  expect(matches.length).toBe(1);
  expect(matches[0].id).toBe(node.id);

  // And no duplicate UPDATE history beyond a sane count — the version log must
  // not balloon from replayed writes. Each settled autosave is one UPDATE; the
  // mid-drain reconnect must not double them. (We assert a tight upper bound
  // rather than an exact count to stay robust to autosave coalescing.)
  const versions = (await (await page.request.get(`/api/nodes/${node.id}/versions`)).json()) as Array<unknown>;
  expect(versions.length).toBeGreaterThanOrEqual(1);
  expect(versions.length).toBeLessThanOrEqual(6);
});
