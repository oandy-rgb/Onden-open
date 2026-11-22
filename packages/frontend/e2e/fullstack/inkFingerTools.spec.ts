import { test, expect, type Page, type CDPSession } from "@playwright/test";
import { ready, H } from "./helpers";

// Handwriting page on a PHONE: the tools model (fix/ink-finger-tools).
//
//   - Pen / Highlighter / Eraser / Hand are one group; a drawing tool draws
//     with one finger, Hand pans with one finger, two fingers always pan+zoom.
//   - Pages are fixed sheets: "+ Add page" adds one below the last, and a stroke on it is stored in morePages.
//   - The finger setting (the More menu's 「Finger draws too」) is an explicit device setting; the
//     old hidden pen-seen / fingerMode prefs are migrated into it, visibly.
//   - A drag that runs out of paper scrolls the note page around it.
//
// Touch is real Chromium touch via CDP Input.dispatchTouchEvent (so
// touch-action and the touch -> pointer conversion are exercised); every test
// needs it, so the suite is Chromium-only. Each test seeds its own note.

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
test.skip(({ browserName }) => browserName !== "chromium", "needs CDP Input.dispatchTouchEvent");


type InkStroke = { id: string; points: number[][] };
type InkDoc = { strokes: InkStroke[]; morePages?: { order?: string[]; pages: Record<string, { doc: { strokes: InkStroke[] } }> } };
type Pt = [number, number];

async function seedNote(page: Page, title: string): Promise<string> {
  const node = await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: "" } })).json() as { id: string };
  const doc = { version: 1, page: { width: 1000 }, erased: {}, strokes: [] };
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

const strokeCount = async (page: Page, nodeId: string) => (await fetchInkDoc(page, nodeId))?.strokes.length ?? 0;

async function openInk(page: Page, nodeId: string) {
  await ready(page, `/?view=notes&node=${nodeId}`);
  await expect(page.locator(".page-ink-surface")).toBeVisible({ timeout: 20_000 });
}

/** One gesture: each finger moves from its start to its end in `steps`. */
type Finger = { from: Pt; to: Pt };
async function touch(cdp: CDPSession, fingers: Finger[], steps = 12) {
  const at = (i: number) => fingers.map((f, id) => ({
    id,
    x: f.from[0] + ((f.to[0] - f.from[0]) * i) / steps,
    y: f.from[1] + ((f.to[1] - f.from[1]) * i) / steps,
  }));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(0) });
  for (let i = 1; i <= steps; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(i) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

const tool = (page: Page, id: "pen" | "highlighter" | "eraser" | "hand") => page.locator(`[data-ink-tool="${id}"]`);
const scrollerTop = (page: Page) => page.locator(".pagebook-scroll").evaluate((el) => el.scrollTop);

/** The note page around the drawing (nearest vertically scrollable ancestor):
 *  scrollTop / maximum, or null when nothing around it scrolls. */
async function outerScroll(page: Page): Promise<{ top: number; max: number } | null> {
  return page.evaluate(() => {
    for (let n = document.querySelector(".pagebook-scroll")?.parentElement ?? null; n; n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight && /auto|scroll/.test(getComputedStyle(n).overflowY)) {
        return { top: n.scrollTop, max: n.scrollHeight - n.clientHeight };
      }
    }
    return null;
  });
}
async function setOuterScroll(page: Page, where: "start" | "end") {
  await page.evaluate((where) => {
    for (let n = document.querySelector(".pagebook-scroll")?.parentElement ?? null; n; n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight && /auto|scroll/.test(getComputedStyle(n).overflowY)) {
        n.scrollTop = where === "end" ? n.scrollHeight : 0;
        break;
      }
    }
  }, where);
}

test.describe("handwriting page tools (phone, 390×844, touch)", () => {
  test("draw, add a page and draw on it, then pan back with Hand", async ({ page }) => {
    const nodeId = await seedNote(page, `InkFinger flow ${Date.now()}`);
    await openInk(page, nodeId);
    const cdp = await page.context().newCDPSession(page);
    await setOuterScroll(page, "end"); // the drawing itself takes the drags below

    // 1. Pen tool (default): one finger draws. Stored in page coordinates.
    await expect(tool(page, "pen")).toHaveAttribute("aria-pressed", "true");
    const paper = (await page.locator(".pagebook-page").boundingBox())!;
    const scale = paper.width / 1000;
    const top = await scrollerTop(page);
    await touch(cdp, [{ from: [paper.x + 150 * scale, paper.y + 150 * scale], to: [paper.x + 600 * scale, paper.y + 300 * scale] }]);
    await expect.poll(() => strokeCount(page, nodeId), { timeout: 10_000 }).toBe(1);
    expect(await scrollerTop(page)).toBe(top); // drawing did not scroll
    
    // 2. "+ Add page" adds a sheet below (it is scrolled to), and a finger on it draws there:
    //    stored in morePages, the first page keeps its own stroke.
    await page.getByRole("button", { name: /^\+ Add page|新增一頁/ }).click();
    await expect(page.locator(".pagebook-page")).toHaveCount(2);
    const secondPage = page.locator(".pagebook-page").nth(1);
    // Scrolled to: its top at the top of the book's view (less the gutter).
    await expect.poll(async () => (await secondPage.boundingBox())!.y - (await page.locator(".pagebook-scroll").boundingBox())!.y).toBeLessThan(40);
    const second = (await secondPage.boundingBox())!;
    const s2 = second.width / 1000;
    const scrollBefore = await scrollerTop(page);
    await touch(cdp, [{ from: [second.x + 300 * s2, second.y + 200 * s2], to: [second.x + 700 * s2, second.y + 260 * s2] }]);
    await expect.poll(async () => {
      const doc = await fetchInkDoc(page, nodeId);
      return Object.values(doc?.morePages?.pages ?? {}).reduce((n, p) => n + p.doc.strokes.length, 0);
    }, { timeout: 10_000 }).toBe(1);
    expect(await scrollerTop(page)).toBe(scrollBefore); // it drew, it did not pan
    expect(await strokeCount(page, nodeId)).toBe(1); // the first page still has its one stroke

    // 3. Hand: one finger pans — and draws nothing. Two sheets are taller than the view, so a drag
    //    down scrolls back toward the first one until the top is reached.
    await tool(page, "hand").click();
    await expect(tool(page, "hand")).toHaveAttribute("aria-pressed", "true");
    await expect(tool(page, "pen")).toHaveAttribute("aria-pressed", "false");
    const stage = (await secondPage.locator(".page-ink-surface").boundingBox())!;
    const x = stage.x + stage.width / 2;
    const y0 = Math.max(stage.y + 40, 120);
    const first = await scrollerTop(page);
    await touch(cdp, [{ from: [x, y0], to: [x, y0 + 300] }]);
    await expect.poll(() => scrollerTop(page)).toBeLessThan(first - 100);
    let last = -1;
    for (let i = 0; i < 6 && (await scrollerTop(page)) !== last; i++) {
      last = await scrollerTop(page);
      await touch(cdp, [{ from: [x, 160], to: [x, 460] }]);
      await page.waitForTimeout(400); // let a fling settle
    }
    await page.waitForTimeout(1200);
    expect(await strokeCount(page, nodeId)).toBe(1); // panning drew nothing on the first page
    const doc = await fetchInkDoc(page, nodeId);
    expect(Object.values(doc?.morePages?.pages ?? {}).reduce((n, p) => n + p.doc.strokes.length, 0)).toBe(1); // nor on the second
  });

  test("two fingers pan + zoom with a drawing tool and with Hand", async ({ page }) => {
    const nodeId = await seedNote(page, `InkFinger two ${Date.now()}`);
    await openInk(page, nodeId);
    const cdp = await page.context().newCDPSession(page);
    const stageEl = page.locator(".page-ink-surface");
    const zoomHost = page.locator(".pagebook");
    const box = (await stageEl.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + Math.min(box.height / 2, 300);

    for (const id of ["pen", "hand"] as const) {
      await tool(page, id).click();
      await page.locator(".pagebook-zoom").click(); // back to fit width
      await expect(zoomHost).toHaveAttribute("data-pagebook-zoom", "1");
      await touch(cdp, [
        { from: [cx - 40, cy], to: [cx - 110, cy] },
        { from: [cx + 40, cy], to: [cx + 110, cy] },
      ], 16);
      await expect.poll(async () => Number(await zoomHost.getAttribute("data-pagebook-zoom"))).toBeGreaterThan(1.4);
    }
    await page.waitForTimeout(1200);
    expect(await strokeCount(page, nodeId)).toBe(0); // a pinch never leaves a stroke
  });

  test("toolbar: one row, tools first, Hand is a tool, no finger toggle, undo/redo reachable", async ({ page }) => {
    const nodeId = await seedNote(page, `InkFinger bar ${Date.now()}`);
    await openInk(page, nodeId);
    await expect(page.locator("[data-ink-finger]")).toHaveCount(0);

    const bar = page.locator(".ink-note-toolbar");
    const rows = await bar.evaluate((el) => {
      const ys = [...el.querySelectorAll("button")].map((b) => Math.round(b.getBoundingClientRect().top));
      return { distinct: [...new Set(ys)].length, firstTool: (el.querySelector("[data-ink-tool]") as HTMLElement | null)?.dataset.inkTool };
    });
    expect(rows.distinct).toBe(1); // every button on the same line
    expect(rows.firstTool).toBe("pen");

    // The tools are one group — the four ink tools plus Shape (0422ea6e), Text and Quote
    // (InkNodeView trailing tools; Quote = 9d6ec4483, "quote an area as an embed") — exactly one pressed.
    const tools = await page.locator("[data-ink-tool]").evaluateAll((els) => els.map((e) => [e.getAttribute("data-ink-tool"), e.getAttribute("aria-pressed")]));
    expect(tools).toEqual([["pen", "true"], ["highlighter", "false"], ["eraser", "false"], ["shape", "false"], ["hand", "false"], ["text", "false"], ["quote", "false"]]);

    // Undo is on screen (pinned right) even though the row scrolls sideways.
    const undo = page.getByRole("button", { name: /^Undo|復原/ }).first();
    await expect(undo).toBeInViewport();
  });

  test("finger setting (More menu, explicit): a drawing tool's finger then only scrolls; on → draws again", async ({ page }) => {
    const nodeId = await seedNote(page, `InkFinger stylus ${Date.now()}`);
    await openInk(page, nodeId);
    const cdp = await page.context().newCDPSession(page);
    // The switch lives in the page's More menu (it stays open after a click).
    const fingerDraws = () => page.locator("[data-ink-finger-draws]");
    const setFingerDraws = async (on: boolean) => {
      await page.locator("[data-pdf-more]").click();
      if ((await fingerDraws().getAttribute("data-ink-finger-draws")) !== (on ? "on" : "off")) await fingerDraws().click();
      await expect(fingerDraws()).toHaveAttribute("data-ink-finger-draws", on ? "on" : "off");
      await page.keyboard.press("Escape");
    };

    const paper = (await page.locator(".pagebook-page").boundingBox())!;
    const scale = paper.width / 1000;
    const drag: Finger = { from: [paper.x + 200 * scale, paper.y + 300 * scale], to: [paper.x + 600 * scale, paper.y + 350 * scale] };

    await setFingerDraws(false);
    await touch(cdp, [drag]);
    await page.waitForTimeout(1500);
    expect(await strokeCount(page, nodeId)).toBe(0); // the finger panned

    await setFingerDraws(true);
    await touch(cdp, [drag]);
    await expect.poll(() => strokeCount(page, nodeId), { timeout: 10_000 }).toBe(1);
  });

  test("migration: an old 'fingers pan' pref turns the finger setting to 'only scroll', visibly, and the old keys go", async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem("seeded-old-ink-prefs")) return;
      sessionStorage.setItem("seeded-old-ink-prefs", "1");
      localStorage.setItem("onden.ink.fingerMode", "auto");
      localStorage.setItem("onden.ink.penSeen", "1");
      localStorage.removeItem("onden.ink.stylusOnly");
    });
    const nodeId = await seedNote(page, `InkFinger migrate ${Date.now()}`);
    await openInk(page, nodeId);
    await page.locator("[data-pdf-more]").click();
    await expect(page.locator("[data-ink-finger-draws]")).toHaveAttribute("data-ink-finger-draws", "off");
    const stored = await page.evaluate(() => ({
      mode: localStorage.getItem("onden.ink.fingerMode"),
      seen: localStorage.getItem("onden.ink.penSeen"),
      stylus: localStorage.getItem("onden.ink.stylusOnly"),
    }));
    expect(stored).toEqual({ mode: null, seen: null, stylus: "1" });
  });

  test("a drag that runs out of paper scrolls the note page: the title comes back (and goes again)", async ({ page }) => {
    const nodeId = await seedNote(page, `InkFinger handoff ${Date.now()}`);
    await openInk(page, nodeId);
    const outer = await outerScroll(page);
    test.skip(!outer || outer.max < 40, "nothing around the drawing scrolls at this size");
    const cdp = await page.context().newCDPSession(page);
    await tool(page, "hand").click();

    await setOuterScroll(page, "end");
    const scrolledAway = (await outerScroll(page))!.top;
    expect(scrolledAway).toBeGreaterThan(0);
    expect(await scrollerTop(page)).toBe(0); // paper top edge

    const stage = (await page.locator(".page-ink-surface").boundingBox())!;
    const x = stage.x + stage.width / 2;
    const y0 = stage.y + 40;
    // Finger down: the paper is already at its top, the rest goes to the note page.
    await touch(cdp, [{ from: [x, y0], to: [x, y0 + 160] }]);
    await expect.poll(async () => (await outerScroll(page))!.top).toBeLessThan(scrolledAway - 40);
    expect(await scrollerTop(page)).toBe(0);
    // Back up: the note page moves away first, the drawing only after it.
    await touch(cdp, [{ from: [x, y0 + 160], to: [x, y0] }]);
    await expect.poll(async () => (await outerScroll(page))!.top).toBeGreaterThan(scrolledAway - 20);
  });
});
