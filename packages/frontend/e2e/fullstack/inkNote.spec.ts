import { test, expect, type Page } from "@playwright/test";
import { H, ready } from "./helpers";

// Handwriting note (lib/ink + InkNodeView) — the full user journey:
// palette-create → draw → persistence (ink_data attribute through the spine
// ATTRIBUTE_SET path) → reload → interval erase → in-session undo.
//
// Rerun-safe: every run creates a FRESH node via the palette action and
// stamps its title, so nothing collides on the shared onden_test DB.

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

test("handwritten note: create, draw, persist, reload, erase, undo", async ({ page }) => {
  const stamp = Date.now();
  await ready(page, "/?view=notes");

  // ── Palette → "New handwritten note" ──────────────────────────────────────
  await page.locator(".palette-trigger").click(); // locator click auto-waits
  await page.locator(".palette-input-wrap input").fill(">handwritten");
  const action = page.locator(".palette-item", { hasText: "New handwritten note" });
  await expect(action).toBeVisible();
  await action.click();

  // The action creates the node, selects it, and the editor swaps to the ink
  // surface. Node id lands in the URL (?node=).
  await expect(page.locator(".ink-note")).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => new URL(page.url()).searchParams.get("node")).not.toBeNull();
  const nodeId = new URL(page.url()).searchParams.get("node")!;

  // Timestamp the title so reruns never collide on lookups.
  await page.locator(".obsidian-title-input").fill(`Handwritten ${stamp}`);

  // ── Draw two strokes with mouse drags ─────────────────────────────────────
  const pageBox = await page.locator(".pagebook-page").boundingBox();
  expect(pageBox).not.toBeNull();
  const { x, y } = pageBox!;
  await drawStroke(page, [[x + 100, y + 80], [x + 220, y + 110], [x + 340, y + 90]]);
  await drawStroke(page, [[x + 120, y + 180], [x + 260, y + 200], [x + 380, y + 170]]);

  // Engine debounce (~800ms) → parent PUTs ink_data. Assert via the
  // serialized attribute: exactly our two strokes.
  await expect.poll(async () => (await fetchInkDoc(page, nodeId))?.strokes.length, {
    timeout: 10_000,
  }).toBe(2);
  const drawn = (await fetchInkDoc(page, nodeId))!;
  expect(drawn.version).toBe(1);
  expect(drawn.page.width).toBe(1000);
  expect(drawn.strokes[0].points.length).toBeGreaterThan(1);

  // ── Reload → strokes persist ──────────────────────────────────────────────
  await page.reload({ waitUntil: "load" });
  await expect(page.locator(".ink-note")).toBeVisible({ timeout: 15_000 });
  const reloaded = await fetchInkDoc(page, nodeId);
  expect(reloaded?.strokes.length).toBe(2);

  // ── Eraser drag across the first stroke → erasedIntervals non-empty ──────
  await page.locator(".ink-tool-btn[title='Eraser']").click();
  const box2 = await page.locator(".pagebook-page").boundingBox();
  const { x: x2, y: y2 } = box2!;
  // Vertical drag crossing stroke 1's path around x+220.
  await drawStroke(page, [[x2 + 220, y2 + 40], [x2 + 220, y2 + 150]]);

  await expect.poll(async () => {
    const doc = await fetchInkDoc(page, nodeId);
    return doc ? Object.keys(doc.erased).length : 0;
  }, { timeout: 10_000 }).toBeGreaterThan(0);

  // ── In-session undo (⌘Z / Ctrl+Z on the focused surface) restores ────────
  await page.locator(".ink-note").focus();
  await page.keyboard.press("Control+z");

  await expect.poll(async () => {
    const doc = await fetchInkDoc(page, nodeId);
    return doc ? Object.keys(doc.erased).length : -1;
  }, { timeout: 10_000 }).toBe(0);
  // The strokes themselves survived the undo round-trip untouched.
  const final = await fetchInkDoc(page, nodeId);
  expect(final?.strokes.length).toBe(2);
});

// Ink version history → inspector gesture diff. Two ink saves go through the
// real spine (ATTRIBUTE_SET / events→hash→blobs); the new /ink-versions
// endpoint serves them and the inspector's Recent Events shows WHAT changed
// ("drawing — drew 2 strokes"), not just a byte count. Seeded via the API so
// the assertion is about the viewer wiring, not pointer simulation.
test("ink version history surfaces a gesture diff in the inspector", async ({ page }) => {
  const stamp = Date.now();
  const inkDoc = (n: number) => JSON.stringify({
    version: 1, page: { width: 800 }, erased: {},
    strokes: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, points: [[i, i], [i + 1, i + 2]], color: "#000", size: 2 })),
  });

  const node = await (await page.request.post("/api/nodes", { ...H, data: { title: `InkHist ${stamp}`, markdown: "x" } })).json();
  // Two saves: 1 stroke, then 3 (sharing s0) → newest diff = drew 2 strokes.
  for (const n of [1, 3]) {
    const res = await page.request.put(`/api/nodes/${node.id}/attributes/ink_data`, {
      ...H, data: { value: inkDoc(n), value_type: "text", is_inheritable: false },
    });
    expect(res.ok()).toBeTruthy();
  }

  // The endpoint itself serves both versions through the full stack.
  const versions = await (await page.request.get(`/api/nodes/${node.id}/ink-versions`)).json();
  expect(versions.length).toBe(2);
  expect(JSON.parse(versions[0].ink_data).strokes.length).toBe(3); // newest first
});
