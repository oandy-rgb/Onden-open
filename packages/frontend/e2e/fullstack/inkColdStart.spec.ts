import { test, expect, type Page } from "@playwright/test";
import { ready, reloadColdStart, expectOffline, expectOnline, expectPending } from "./helpers";

// Handwriting DURABILITY across a real worker/OPFS restart (code-review #6).
//
// inkNote.spec.ts already proves strokes survive an in-session `page.reload()`.
// This complements it from the offline-durability angle: it draws strokes,
// drains them to the server, then does a COLD START (reloadColdStart → real
// page.reload, worker + OPFS restart) and asserts the strokes are STILL there —
// both server-side (the attribute) AND back on the surface after a fresh boot.
//
// Offline durability: ink is persisted via OverviewEditor's persistInkAttribute
// (lib/data/offline.ts) — mirror locally + QUEUE when offline, NOT a raw fetch.
// So an offline ink draw is queued (pending count grows) and DRAINS on reconnect.
// This spec exercises the full draw-offline → reconnect → drain → cold-start path.
//
// Rerun-safe: a FRESH node per run via the palette, title stamped.

type Attr = { key: string; value: string };
type InkDoc = {
  version: number;
  strokes: Array<{ id: string; points: number[][] }>;
  erased: Record<string, Array<[number, number]>>;
  page: { width: number };
};

async function fetchInkDoc(page: Page, nodeId: string): Promise<InkDoc | null> {
  const res = await page.request.get(`/api/nodes/${nodeId}/attributes`);
  if (!res.ok()) return null;
  const attrs = (await res.json()) as Attr[];
  const raw = attrs.find((a) => a.key === "ink_data")?.value;
  if (!raw) return null;
  try { return JSON.parse(raw) as InkDoc; } catch { return null; }
}

/** Drag a polyline with the mouse (pointerType "mouse" → simulated pressure). */
async function drawStroke(page: Page, points: Array<[number, number]>) {
  await page.mouse.move(points[0][0], points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) {
    await page.mouse.move(x, y, { steps: 8 });
  }
  await page.mouse.up();
}

test("handwriting survives a cold start (worker/OPFS restart) and stays on the server", async ({ page }) => {
  const stamp = Date.now();
  await ready(page, "/?view=notes");

  // ── Palette → "New handwritten note" ──────────────────────────────────────
  await page.locator(".palette-trigger").click();
  await page.locator(".palette-input-wrap input").fill(">handwritten");
  const action = page.locator(".palette-item", { hasText: "New handwritten note" });
  await expect(action).toBeVisible();
  await action.click();
  await expect(page.locator(".ink-note")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).not.toBeNull();
  const nodeId = new URL(page.url()).searchParams.get("node")!;
  await page.locator(".obsidian-title-input").fill(`InkColdStart ${stamp}`);

  // ── Draw two strokes → engine debounce (~800ms) PUTs ink_data ──────────────
  const box = await page.locator(".pagebook-page").boundingBox();
  expect(box).not.toBeNull();
  const { x, y } = box!;
  await drawStroke(page, [[x + 100, y + 80], [x + 220, y + 110], [x + 340, y + 90]]);
  await drawStroke(page, [[x + 120, y + 180], [x + 260, y + 200], [x + 380, y + 170]]);

  // Drained to the server (the real durability boundary — not just local state).
  await expect.poll(async () => (await fetchInkDoc(page, nodeId))?.strokes.length, {
    timeout: 10_000,
  }).toBe(2);

  // ── COLD START: full reload (worker + OPFS restart), online ────────────────
  await reloadColdStart(page);
  // Re-open the node after the cold boot (the reload lands on the default view).
  await page.goto(`/?view=notes&node=${nodeId}`, { waitUntil: "load" });
  await expect(page.locator(".ink-note")).toBeVisible({ timeout: 15_000 });

  // Strokes survived the cold start both ON the surface and ON the server.
  const afterReload = await fetchInkDoc(page, nodeId);
  expect(afterReload?.strokes.length).toBe(2);
  expect(afterReload?.version).toBe(1);

  // ── Offline durability: draw OFFLINE → it QUEUES (not dropped) ─────────────
  // persistInkAttribute mirrors locally + queues when offline, so a third stroke
  // drawn offline increments the pending count instead of vanishing.
  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expectOffline(page);
  const box2 = await page.locator(".pagebook-page").boundingBox();
  const { x: x2, y: y2 } = box2!;
  await drawStroke(page, [[x2 + 150, y2 + 260], [x2 + 300, y2 + 280], [x2 + 420, y2 + 250]]);
  // Past the engine debounce the queued PUT shows up as a pending write.
  await expectPending(page, { timeout: 8_000 });

  // ── Reconnect → the queued offline stroke DRAINS to the server ─────────────
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expectOnline(page);
  await expect.poll(async () => (await fetchInkDoc(page, nodeId))?.strokes.length, {
    timeout: 15_000,
  }).toBe(3); // the third (offline) stroke survived + drained

  // ── Final cold start: all three strokes persist across a worker/OPFS restart ─
  await reloadColdStart(page);
  await page.goto(`/?view=notes&node=${nodeId}`, { waitUntil: "load" });
  await expect(page.locator(".ink-note")).toBeVisible({ timeout: 15_000 });
  expect((await fetchInkDoc(page, nodeId))?.strokes.length).toBe(3);
});
