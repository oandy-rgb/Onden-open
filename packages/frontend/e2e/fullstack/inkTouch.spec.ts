import { test, expect, type Page, type CDPSession } from "@playwright/test";
import { ready, H } from "./helpers";

// Handwriting page on a touch device (T1-1): the finger / pen split and the
// page zoom, end to end against the real stack.
//
//   1. phone, no pen: one finger draws a stroke that is saved;
//   2. with the Hand tool selected, a one-finger drag scrolls the page instead
//      (the full tools model is in inkFingerTools.spec.ts);
//   3. a two-finger pinch zooms; the seeded stroke is untouched and a stroke
//      drawn while zoomed is stored in page (document) coordinates.
//
// Touch input: Chromium gets real touches through CDP Input.dispatchTouchEvent
// (exercising touch-action and the browser's touch → pointer conversion);
// WebKit (mobile-safari project) has no CDP, so it gets synthetic
// PointerEvents with pointerType "touch" on the ink surface. The pen is always
// a synthetic PointerEvent with pointerType "pen" (no engine emulates one).
//
// Since the pagebook (012fcd496, 2026-11-08) the finger is NOT handled by the engine on this page: one finger
// scrolls natively (the browser's own scroll), two fingers pinch from TouchEvents (lib/ink/touchSplit.ts). Neither can
// be produced by synthetic PointerEvents, so on engines without CDP (WebKit) the scroll and pinch tests check what a
// pointer-only finger can show — it must neither draw nor zoom, and the surface must leave the finger to the browser
// (touch-action) — and the real scroll / pinch run in Chromium only. Real iPad Safari scroll and pinch are NOT
// covered by any automated test here (no multi-touch driver for WebKit); that stays a device check.
//
// Every test seeds its own note through the API, so reruns never collide.

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });


type InkStroke = { id: string; points: number[][] };
type InkDoc = { strokes: InkStroke[] };
type Pt = [number, number];

const SEEDED: InkStroke = {
  id: "seed-1",
  points: [[200, 200], [300, 260], [400, 220]],
};

async function seedNote(page: Page, title: string, strokes: InkStroke[]): Promise<string> {
  const node = await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: "" } })).json() as { id: string };
  const doc = {
    version: 1,
    page: { width: 1000 },
    erased: {},
    strokes: strokes.map((s) => ({ ...s, color: "#15130d", size: 4, toolId: "pen" })),
  };
  const res = await page.request.put(`/api/nodes/${node.id}/attributes/ink_data`, {
    ...H, data: { value: JSON.stringify(doc), value_type: "text", is_inheritable: false },
  });
  expect(res.ok()).toBeTruthy();
  return node.id;
}

async function fetchInkDoc(page: Page, nodeId: string): Promise<InkDoc | null> {
  const res = await page.request.get(`/api/nodes/${nodeId}/attributes`);
  if (!res.ok()) return null;
  const attrs = (await res.json()) as Array<{ key: string; value: string }>;
  const raw = attrs.find((a) => a.key === "ink_data")?.value;
  if (!raw) return null;
  try { return JSON.parse(raw) as InkDoc; } catch { return null; }
}

async function openInk(page: Page, nodeId: string) {
  await ready(page, `/?view=notes&node=${nodeId}`);
  await expect(page.locator(".page-ink-surface")).toBeVisible({ timeout: 20_000 });
}

/** Viewport point of a document coordinate, from the page sheet's box. */
async function docToScreen(page: Page, x: number, y: number): Promise<Pt> {
  const box = (await page.locator(".pagebook-page").boundingBox())!;
  const scale = box.width / 1000;
  return [box.x + x * scale, box.y + y * scale];
}

/** Synthetic pointer events on the ink surface (pen everywhere; touch on
 *  engines without CDP). */
async function synthPointers(
  page: Page, type: "pointerdown" | "pointermove" | "pointerup",
  pointerType: "pen" | "touch", points: Array<{ id: number; x: number; y: number }>,
) {
  await page.evaluate(({ type, pointerType, points }) => {
    const stage = document.querySelector(".page-ink-surface");
    if (!stage) throw new Error("no ink surface");
    for (const p of points) {
      stage.dispatchEvent(new PointerEvent(type, {
        pointerId: p.id, pointerType, isPrimary: p.id === points[0].id,
        clientX: p.x, clientY: p.y,
        button: type === "pointermove" ? -1 : 0,
        buttons: type === "pointerup" ? 0 : 1,
        pressure: type === "pointerup" ? 0 : 0.5,
        bubbles: true, cancelable: true, composed: true,
      }));
    }
  }, { type, pointerType, points });
}

/** One gesture: each finger moves from its start to its end in `steps`. */
type Finger = { from: Pt; to: Pt };

async function touchGesture(page: Page, cdp: CDPSession | null, fingers: Finger[], steps = 12) {
  const at = (i: number) => fingers.map((f, id) => ({
    id,
    x: f.from[0] + ((f.to[0] - f.from[0]) * i) / steps,
    y: f.from[1] + ((f.to[1] - f.from[1]) * i) / steps,
  }));
  if (cdp) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(0) });
    for (let i = 1; i <= steps; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(i) });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    return;
  }
  const ids = (pts: Array<{ id: number; x: number; y: number }>) => pts.map((p) => ({ ...p, id: p.id + 100 }));
  await synthPointers(page, "pointerdown", "touch", ids(at(0)));
  for (let i = 1; i <= steps; i++) await synthPointers(page, "pointermove", "touch", ids(at(i)));
  await synthPointers(page, "pointerup", "touch", ids(at(steps)));
}

async function touchDriver(page: Page, browserName: string): Promise<CDPSession | null> {
  return browserName === "chromium" ? page.context().newCDPSession(page) : null;
}

test.describe("handwriting page on touch", () => {
  test.skip(({ browserName }) => browserName === "firefox", "Firefox has no touch emulation");

  test("phone without a pen: a finger draws a stroke that is saved", async ({ page, browserName }) => {
    const nodeId = await seedNote(page, `InkTouch draw ${Date.now()}`, []);
    await openInk(page, nodeId);
    const cdp = await touchDriver(page, browserName);

    const from = await docToScreen(page, 150, 150);
    const to = await docToScreen(page, 600, 300);
    await touchGesture(page, cdp, [{ from, to }]);

    await expect.poll(async () => (await fetchInkDoc(page, nodeId))?.strokes.length, { timeout: 10_000 }).toBe(1);
    const stroke = (await fetchInkDoc(page, nodeId))!.strokes[0];
    expect(stroke.points.length).toBeGreaterThan(2);
    // Stored in document units: the stroke spans ~150 → ~600 on the 1000-wide page.
    expect(stroke.points[0][0]).toBeGreaterThan(130);
    expect(stroke.points[0][0]).toBeLessThan(170);
    expect(stroke.points.at(-1)![0]).toBeGreaterThan(580);
  });

  test("with the Hand tool, a one-finger drag scrolls instead of drawing", async ({ page, browserName }) => {
    // A tall page (seeded ink near the bottom) so there is room to scroll.
    const nodeId = await seedNote(page, `InkTouch scroll ${Date.now()}`, [
      { id: "low", points: [[100, 2600], [300, 2650]] },
    ]);
    await openInk(page, nodeId);
    const cdp = await touchDriver(page, browserName);

    await page.locator('[data-ink-tool="hand"]').click();
    await expect(page.locator('[data-ink-tool="hand"]')).toHaveAttribute("aria-pressed", "true");
    // The note page around the drawing takes a drag at the paper's edge
    // first; bring it to its end so this test sees the drawing scroll.
    await page.evaluate(() => {
      for (let n = document.querySelector(".pagebook-scroll")?.parentElement ?? null; n; n = n.parentElement) {
        if (n.scrollHeight > n.clientHeight && /auto|scroll/.test(getComputedStyle(n).overflowY)) { n.scrollTop = n.scrollHeight; break; }
      }
    });
    const scroller = page.locator(".pagebook-scroll");
    const before = await scroller.evaluate((el) => el.scrollTop);
    const box = (await scroller.boundingBox())!;
    const x = box.x + box.width / 2;
    // On a phone the ink area runs past the bottom of the screen (the note
    // page scrolls too) and the bottom navigation covers part of it: start
    // the drag at the lowest on-screen point that actually hits the ink
    // surface, or the browser scrolls the page / the nav takes the touch.
    const startY = await page.evaluate(({ x, top }) => {
      for (let y = window.innerHeight - 1; y > top; y -= 4) {
        if (document.elementFromPoint(x, y)?.closest(".page-ink-surface")) return y - 8;
      }
      return top;
    }, { x, top: box.y });
    expect(startY - box.y).toBeGreaterThan(200);
    await touchGesture(page, cdp, [{ from: [x, startY], to: [x, box.y + 20] }]);

    if (cdp) {
      await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(before + 100);
    } else {
      // No real touch: a synthetic finger cannot scroll natively. What is checkable: the surface leaves one finger to the
      // browser (touch-action allows panning; the root's `manipulation` never takes that away), and the finger drew nothing.
      expect(await page.locator(".page-ink-surface").evaluate((el) => getComputedStyle(el).touchAction)).toMatch(/pan-y|pan-x pan-y/);
    }
    // Still just the seeded stroke: the drag drew nothing.
    await page.waitForTimeout(1500);
    expect((await fetchInkDoc(page, nodeId))?.strokes.length).toBe(1);
  });

  test("a two-finger pinch zooms; saved strokes keep their coordinates", async ({ page, browserName }) => {
    const nodeId = await seedNote(page, `InkTouch pinch ${Date.now()}`, [SEEDED]);
    await openInk(page, nodeId);
    const cdp = await touchDriver(page, browserName);
    const zoomHost = page.locator(".pagebook");
    await expect(zoomHost).toHaveAttribute("data-pagebook-zoom", "1");
    const widthBefore = (await page.locator(".pagebook-page").boundingBox())!.width;

    // Spread two fingers apart around a point on the page.
    const [cx, cy] = await docToScreen(page, 500, 400);
    await touchGesture(page, cdp, [
      { from: [cx - 40, cy], to: [cx - 120, cy] },
      { from: [cx + 40, cy], to: [cx + 120, cy] },
    ], 16);

    if (!cdp) {
      // Pointer-only fingers: no pinch (that is TouchEvents, touchSplit.ts) and no stroke (the engine ignores fingers here).
      await page.waitForTimeout(1000);
      await expect(zoomHost).toHaveAttribute("data-pagebook-zoom", "1");
      expect((await fetchInkDoc(page, nodeId))?.strokes.length).toBe(1);
      return;
    }
    await expect.poll(async () => Number(await zoomHost.getAttribute("data-pagebook-zoom"))).toBeGreaterThan(1.5);
    const widthAfter = (await page.locator(".pagebook-page").boundingBox())!.width;
    expect(widthAfter).toBeGreaterThan(widthBefore * 1.5);
    await expect(page.locator(".pagebook-zoom")).not.toHaveText("100%");

    // A stroke drawn while zoomed lands on page coordinates (no zoom baked in).
    const a = await docToScreen(page, 480, 380);
    const b = await docToScreen(page, 540, 420);
    await touchGesture(page, cdp, [{ from: a, to: b }], 8);

    await expect.poll(async () => (await fetchInkDoc(page, nodeId))?.strokes.length, { timeout: 10_000 }).toBe(2);
    const doc = (await fetchInkDoc(page, nodeId))!;
    const seeded = doc.strokes.find((s) => s.id === SEEDED.id)!;
    expect(seeded.points).toEqual(SEEDED.points);
    const drawn = doc.strokes.find((s) => s.id !== SEEDED.id)!;
    expect(drawn.points[0][0]).toBeGreaterThan(470);
    expect(drawn.points[0][0]).toBeLessThan(490);
    expect(drawn.points[0][1]).toBeGreaterThan(370);
    expect(drawn.points[0][1]).toBeLessThan(390);

    // Fit width resets the zoom.
    await page.locator(".pagebook-zoom").click();
    await expect(zoomHost).toHaveAttribute("data-pagebook-zoom", "1");
  });
});
