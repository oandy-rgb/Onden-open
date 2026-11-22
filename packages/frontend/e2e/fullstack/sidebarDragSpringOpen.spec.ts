// Spring-loaded folders in the sidebar: a held note that stays over a folded note opens it; dropping inside
// keeps the path to the drop open (saved), and what the drag opened on the way folds back.
// Desktop: real mouse. Phone: long-press + synthetic touch pointers on Pixel-5 emulation (like mobileSidebarDrag).
import { test, expect, devices, type Page, type Locator } from "@playwright/test";
import { ready, H } from "./helpers";

async function makeNode(page: Page, title: string, parentId?: string) {
  return (await page.request.post("/api/nodes", { ...H, data: { title, markdown: `${title} body`, ...(parentId ? { parent_id: parentId } : {}) } })).json();
}

async function seed(page: Page) {
  const stamp = Date.now();
  const src = await makeNode(page, `SpSrc ${stamp}`);
  const passing = await makeNode(page, `SpPassing ${stamp}`);
  const passingKid = await makeNode(page, `SpPassingKid ${stamp}`, passing.id);
  const host = await makeNode(page, `SpHost ${stamp}`);
  const kid = await makeNode(page, `SpKid ${stamp}`, host.id);
  return { src, passing, passingKid, host, kid };
}

async function revealRow(page: Page, row: Locator) {
  const list = page.locator(".obsidian-page-list");
  await list.evaluate((el) => { el.scrollTop = 0; });
  for (let i = 0; i < 40; i++) {
    if (await row.count() > 0) break;
    await list.evaluate((el) => el.scrollBy(0, el.clientHeight * 0.8));
    await page.waitForTimeout(80);
  }
  await row.evaluate((el) => el.scrollIntoView({ block: "center" }));
}

// Where the pointer must go: the row's centre once the list has stopped moving. A note the drag just opened renders its
// child rows, and the browser's scroll anchoring may shift the list, a frame or two after `data-sb-expanded` flips; a
// centre read before that sends the pointer to the row above (the first opened note's child), and the target never opens.
async function center(row: Locator) {
  const read = async () => {
    await row.page().evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    const b = (await row.boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  let last = await read();
  await expect.poll(async () => { const now = await read(); const same = now.x === last.x && now.y === last.y; last = now; return same; },
    { message: "the row stays put for two frames" }).toBe(true);
  return last;
}

const rowOf = (page: Page, id: string) => page.locator(`[data-sb-id="${id}"]`);
const header = (page: Page, id: string) => rowOf(page, id).locator(".obsidian-group-header").first();

async function expectDropResult(page: Page, ids: { src: { id: string }; host: { id: string }; kid: { id: string }; passing: { id: string } }) {
  await expect.poll(async () => (await (await page.request.get(`/api/nodes/${ids.src.id}`, H)).json()).parent_id ?? null, { timeout: 10_000 }).toBe(ids.kid.id);
  await page.reload();
  await ready(page);
  await expect(page.locator(".membership-gate")).toHaveCount(0, { timeout: 45_000 });
  const host = rowOf(page, ids.host.id);
  await revealRow(page, host);
  await expect(host).toHaveAttribute("data-sb-expanded", "true"); // the drop's path stays open, saved
  await expect(rowOf(page, ids.passing.id)).toHaveAttribute("data-sb-expanded", "false"); // opened on the way, folded back
}

test("desktop: stay over a folded note → it opens; drop inside keeps only that path open", async ({ page }) => {
  const ids = await seed(page);
  await ready(page);
  await expect(page.locator(".membership-gate")).toHaveCount(0, { timeout: 45_000 });
  const src = rowOf(page, ids.src.id);
  await revealRow(page, src);
  await expect(rowOf(page, ids.host.id)).toHaveAttribute("data-sb-expanded", "false");

  const from = await center(src);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 4 });

  // Over a folded note: a hint while waiting, then it opens (and folds back later).
  const passingHeader = header(page, ids.passing.id);
  await revealRow(page, rowOf(page, ids.passing.id));
  let p = await center(passingHeader);
  await page.mouse.move(p.x, p.y, { steps: 6 });
  await expect(rowOf(page, ids.passing.id)).toHaveClass(/sb-drop-spring/);
  await expect(rowOf(page, ids.passing.id)).toHaveAttribute("data-sb-expanded", "true", { timeout: 3000 });
  await expect(rowOf(page, ids.passingKid.id)).toBeVisible(); // its child row is in the list before anything below it is measured

  // Then another one: the list is longer now, so measure again, and drop inside its child.
  // Opening the first one pushed this one down: with notes left over from earlier runs it can sit at the clipped
  // edge of the list, where the pointer would not be over it. Bring it to the middle before measuring.
  const hostHeader = header(page, ids.host.id);
  await revealRow(page, rowOf(page, ids.host.id));
  p = await center(hostHeader);
  await page.mouse.move(p.x, p.y, { steps: 6 });
  await expect(rowOf(page, ids.host.id)).toHaveAttribute("data-sb-expanded", "true", { timeout: 3000 });
  const kidRow = rowOf(page, ids.kid.id);
  await expect(kidRow).toBeVisible();
  const k = await center(kidRow);
  await page.mouse.move(k.x, k.y, { steps: 6 });
  await expect(kidRow).toHaveClass(/sb-drop-into/);
  await page.mouse.up();

  await expectDropResult(page, ids);
});

// Inside a describe, Playwright rejects `defaultBrowserType` (it would force a new worker, and the whole file
// then fails to load); the project already runs Chromium, so only the phone viewport and touch settings stay.
const { defaultBrowserType: _chromium, ...PIXEL_5 } = devices["Pixel 5"];

test.describe("phone", () => {
  test.use(PIXEL_5);

  const touch = (page: Page, opts: { type: string; sel?: string; x: number; y: number }) =>
    page.evaluate(({ type, sel, x, y }) => {
      const target = sel ? document.querySelector(sel)! : window;
      target.dispatchEvent(new PointerEvent(type, {
        pointerType: "touch", isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true,
      }));
    }, opts);

  test("phone: hold over a folded note → it opens; drop inside keeps only that path open", async ({ page }) => {
    const ids = await seed(page);
    await ready(page);
    await expect(page.locator(".membership-gate")).toHaveCount(0, { timeout: 45_000 });
    await page.locator(".omt-back").click();
    const src = rowOf(page, ids.src.id);
    await revealRow(page, src);
    await page.waitForTimeout(300);

    const from = await center(src);
    await touch(page, { type: "pointerdown", sel: `[data-sb-id="${ids.src.id}"]`, x: from.x, y: from.y });
    await page.waitForTimeout(450);
    await expect(page.locator(".sb-pointer-overlay")).toBeVisible();
    await touch(page, { type: "pointermove", x: from.x + 12, y: from.y + 12 });

    await revealRow(page, rowOf(page, ids.passing.id));
    let p = await center(header(page, ids.passing.id));
    await touch(page, { type: "pointermove", x: p.x, y: p.y });
    // a fingertip wobbles inside the row: the wait must not restart
    await page.waitForTimeout(500);
    await touch(page, { type: "pointermove", x: p.x + 4, y: p.y + 2 });
    await expect(rowOf(page, ids.passing.id)).toHaveAttribute("data-sb-expanded", "true", { timeout: 3000 });
    await expect(rowOf(page, ids.passingKid.id)).toBeVisible(); // its child row is in the list before anything below it is measured

    await revealRow(page, rowOf(page, ids.host.id));
    p = await center(header(page, ids.host.id));
    await touch(page, { type: "pointermove", x: p.x, y: p.y });
    await expect(rowOf(page, ids.host.id)).toHaveAttribute("data-sb-expanded", "true", { timeout: 3000 });
    const k = await center(rowOf(page, ids.kid.id));
    await touch(page, { type: "pointermove", x: k.x, y: k.y });
    await page.waitForTimeout(150);
    await touch(page, { type: "pointerup", x: k.x, y: k.y });

    await expectDropResult(page, ids);
  });
});
