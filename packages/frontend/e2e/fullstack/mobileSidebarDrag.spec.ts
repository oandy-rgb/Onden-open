// Mobile sidebar drag: a move-threshold drag start never survives on touch
// (the browser claims the gesture for scrolling and fires pointercancel) —
// useSidebarDrag now activates on LONG-PRESS for touch pointers. Pinned with
// synthetic touch-pointer events on Pixel-5 emulation: press-and-hold a row,
// move it onto another note, release → reparent ("into").
import { test, expect, devices, type Page } from "@playwright/test";
import { ready, H } from "./helpers";

test.use({ ...devices["Pixel 5"] });


async function makeNode(page: Page, title: string) {
  return (await page.request.post("/api/nodes", { ...H, data: { title, markdown: `${title} body` } })).json();
}

function firePointer(page: Page, opts: { type: string; sel?: string; x: number; y: number }) {
  return page.evaluate(({ type, sel, x, y }) => {
    const target = sel ? document.querySelector(sel)! : window;
    target.dispatchEvent(new PointerEvent(type, {
      pointerType: "touch", isPrimary: true, button: 0, buttons: 1,
      clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true,
    }));
  }, opts);
}

test("mobile: long-press a sidebar row, drop onto another note → reparents", async ({ page }) => {
  const stamp = Date.now();
  const child = await makeNode(page, `LpChild ${stamp}`);
  const host = await makeNode(page, `LpHost ${stamp}`);

  await ready(page);
  await expect(page.locator(".membership-gate")).toHaveCount(0, { timeout: 45_000 });
  await page.locator(".omt-back").click();
  const rowChild = page.locator(`[data-sb-id="${child.id}"]`);
  const rowHost = page.locator(`[data-sb-id="${host.id}"]`);
  // center the rows mid-viewport — near the list edges the drag's
  // auto-scroll kicks in and shifts rows out from under the synthetic
  // pointer. With the virtualized list (>300 rows) the row may not even be
  // in the DOM yet — scroll the container until it materializes.
  const list = page.locator(".obsidian-page-list");
  await list.evaluate((el) => { el.scrollTop = 0; });
  for (let i = 0; i < 40; i++) {
    if (await rowHost.count() > 0) break;
    await list.evaluate((el) => el.scrollBy(0, el.clientHeight * 0.8));
    await page.waitForTimeout(80);
  }
  await rowHost.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(300);
  await expect(rowChild).toBeVisible();
  await expect(rowHost).toBeVisible();

  const a = (await rowChild.boundingBox())!;
  const ax = a.x + a.width / 2, ay = a.y + a.height / 2;

  // touch down on the child row, hold still past the 300ms long-press window
  await firePointer(page, { type: "pointerdown", sel: `[data-sb-id="${child.id}"]`, x: ax, y: ay });
  await page.waitForTimeout(450);
  // drag becomes active without ANY prior movement — the overlay proves it
  await expect(page.locator(".sb-pointer-overlay")).toBeVisible();

  // move onto the host row; RE-MEASURE each step — list rows shift while the
  // drag overlay / live refresh re-render the sidebar
  await firePointer(page, { type: "pointermove", x: ax + 12, y: ay + 12 });
  await page.waitForTimeout(80);
  let b = (await rowHost.boundingBox())!;
  await firePointer(page, { type: "pointermove", x: b.x + b.width / 2, y: b.y + b.height / 2 });
  await page.waitForTimeout(120);
  b = (await rowHost.boundingBox())!;
  const bx = b.x + b.width / 2, by = b.y + b.height / 2;
  await firePointer(page, { type: "pointermove", x: bx, y: by });
  await page.waitForTimeout(120);
  await firePointer(page, { type: "pointerup", x: bx, y: by });

  // the child is now parented under the host
  await expect.poll(async () => {
    const r = await (await page.request.get(`/api/nodes/${child.id}`, H)).json();
    return r.parent_id ?? null;
  }, { timeout: 10_000 }).toBe(host.id);
});
