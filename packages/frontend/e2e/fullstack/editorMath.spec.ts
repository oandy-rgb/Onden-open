// `$…$` / `$$…$$` in the note editor (src/lib/editorMathSyntax.ts parses,
// src/lib/editorMath.ts draws): KaTeX while the caret is elsewhere, the
// source when it is inside, and nothing inside a formula read as markdown.
// Runs on the chromium project at two viewports (desktop, phone 390×844);
// the phone one drives the caret with taps.
import { test, expect, type Page } from "@playwright/test";
import { ready, H } from "./helpers";


// The note from the bug report: `*` inside both formulas used to pair up as
// emphasis across the text between them.
const FORMULA_LINE = "$W_{new} = W + \\Lambda (C^{-1} k_{*})^T$，右邊那串是一個 Rank-1 矩陣… 其中$\\Lambda = \\frac{v_{*} - Wk_{*}}{\\ell \\cdot (C^{-1} k_{*})}$";

async function seed(page: Page) {
  const stamp = Date.now();
  const note = await (await page.request.post("/api/nodes", {
    ...H,
    data: {
      title: `Math ${stamp}`,
      // A first line so the initial caret (offset 0) is not on a formula.
      markdown: `Intro ${stamp}\n\n${FORMULA_LINE}\n\nSecond paragraph ${stamp}\n\n$$\nx^2 + y_1\n$$\n\nLast line ${stamp}`,
    },
  })).json() as { id: string };
  return { id: note.id, stamp };
}

/** Put the caret in the paragraph with this text: a tap on the phone, a click on desktop. */
async function placeCaretIn(page: Page, text: string, touch: boolean) {
  const target = page.locator(".cm-content .cm-line", { hasText: text }).first();
  await expect(target).toBeVisible();
  if (touch) await target.tap({ position: { x: 12, y: 8 } });
  else await target.click({ position: { x: 12, y: 8 } });
}

/** Computed font-style of every element inside the line that is not KaTeX's own output. */
async function italicOutsideKatex(page: Page) {
  return page.locator(".cm-content .cm-line", { hasText: "Rank-1" }).first().evaluate((line) =>
    Array.from(line.querySelectorAll("*"))
      .filter((el) => !el.closest(".katex") && getComputedStyle(el).fontStyle === "italic")
      .map((el) => el.textContent));
}

function suite(name: string, viewport: { width: number; height: number }, touch: boolean) {
  test.describe(name, () => {
    test.use({ viewport, hasTouch: touch, isMobile: touch });
    test.beforeEach(({}, testInfo) => test.skip(testInfo.project.name !== "chromium", "chromium project; sets its own viewport"));

    test("formulas are KaTeX away from the caret, and no emphasis leaks out of them", async ({ page }) => {
      const { id } = await seed(page);
      await ready(page, `/?view=notes&node=${id}`);
      const line = page.locator(".cm-content .cm-line", { hasText: "Rank-1" }).first();

      await expect(line.locator(".cm-math .katex")).toHaveCount(2, { timeout: 15_000 });
      await expect(page.locator(".cm-content .cm-math-block .katex-display")).toBeVisible();
      await expect(page.locator(".cm-content em")).toHaveCount(0);
      expect(await italicOutsideKatex(page)).toEqual([]);
      // The raw LaTeX is not on the page as text any more.
      await expect(line).not.toContainText("\\Lambda");
      // The text between the formulas is plain text.
      await expect(line).toContainText("右邊那串是一個 Rank-1 矩陣…");
    });

    test("the caret inside a formula shows its source; leaving draws it again", async ({ page }) => {
      const { id, stamp } = await seed(page);
      await ready(page, `/?view=notes&node=${id}`);
      const line = page.locator(".cm-content .cm-line", { hasText: "Rank-1" }).first();
      await expect(line.locator(".cm-math .katex")).toHaveCount(2, { timeout: 15_000 });

      // Tap / click the first formula: the caret goes inside it.
      const first = line.locator(".cm-math").first();
      if (touch) await first.tap(); else await first.click();
      await expect(line.locator(".cm-math")).toHaveCount(1);
      await expect(line).toContainText("$W_{new} = W + \\Lambda (C^{-1} k_{*})^T$");
      // Still no markdown inside it, with the source showing.
      await expect(page.locator(".cm-content em")).toHaveCount(0);
      expect(await italicOutsideKatex(page)).toEqual([]);

      // The caret goes elsewhere: drawn again.
      await placeCaretIn(page, `Second paragraph ${stamp}`, touch);
      await expect(line.locator(".cm-math .katex")).toHaveCount(2);
      await expect(line).not.toContainText("\\Lambda");
    });

    test("a block formula shows its source when the caret is on its lines", async ({ page }) => {
      const { id } = await seed(page);
      await ready(page, `/?view=notes&node=${id}`);
      const block = page.locator(".cm-content .cm-math-block");
      await expect(block.locator(".katex-display")).toBeVisible({ timeout: 15_000 });
      if (touch) await block.tap(); else await block.click();
      await expect(page.locator(".cm-content .cm-math-block")).toHaveCount(0);
      await expect(page.locator(".cm-content")).toContainText("x^2 + y_1");
    });

    test("typing edits the formula and the text is saved as typed", async ({ page }) => {
      const { id } = await seed(page);
      await ready(page, `/?view=notes&node=${id}`);
      const line = page.locator(".cm-content .cm-line", { hasText: "Rank-1" }).first();
      await expect(line.locator(".cm-math .katex")).toHaveCount(2, { timeout: 15_000 });
      const first = line.locator(".cm-math").first();
      if (touch) await first.tap(); else await first.click();
      await page.keyboard.insertText("Z");
      await expect.poll(async () => {
        const res = await page.request.get(`/api/nodes/${id}`);
        return ((await res.json()) as { markdown: string }).markdown;
      }, { timeout: 20_000 }).toContain("Z");
    });

    test("KaTeX has the editor's text colour (light and dark)", async ({ page }) => {
      const { id } = await seed(page);
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        await ready(page, `/?view=notes&node=${id}`);
        const katex = page.locator(".cm-content .cm-math .katex").first();
        await expect(katex).toBeVisible({ timeout: 15_000 });
        const [formula, text] = await Promise.all([
          katex.evaluate((el) => getComputedStyle(el).color),
          page.locator(".cm-content .cm-line", { hasText: "Rank-1" }).first().evaluate((el) => getComputedStyle(el).color),
        ]);
        expect(formula).toBe(text);
      }
    });
  });
}

suite("desktop 1280×800", { width: 1280, height: 800 }, false);
suite("phone 390×844", { width: 390, height: 844 }, true);
