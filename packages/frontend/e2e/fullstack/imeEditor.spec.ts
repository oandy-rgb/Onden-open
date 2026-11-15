import { test, expect, type Page } from "@playwright/test";
import { ready, H } from "./helpers";
import { keysSeen, startIme } from "./imeHelpers";

// IME composition in the note editor (CodeMirror), driven in real Chromium.
// Zhuyin ㄋ → ㄋㄧ → 你, Enter picks the candidate, then a sentinel "Z" is typed to prove
// where the caret ended up. The saved Markdown must be exactly the text with 你 and Z
// added at that place: nothing doubled, dropped or left as a Latin letter.
// Obsidian's long-standing IME bugs (a stray Latin letter after a link, characters
// inserted on Android) are the cases to catch. Not covered: physical keyboards, Safari
// (docs/agents/testing.md → 輸入法手動檢查清單).

const ZHUYIN = ["ㄋ", "ㄋㄧ", "你"];

async function openNoteWith(page: Page, markdown: string): Promise<string> {
  const note = await (await page.request.post("/api/nodes", {
    ...H, data: { title: `IME ${Date.now()}`, markdown },
  })).json() as { id: string };
  await ready(page, `/?view=notes&node=${note.id}`);
  await expect(page.locator(".cm-content")).toBeVisible();
  return note.id;
}

const savedMarkdown = async (page: Page, id: string): Promise<string> =>
  ((await (await page.request.get(`/api/nodes/${id}`)).json()) as { markdown: string }).markdown;

/** Put the caret on a line: click it, then Home/End; `left` steps move it back from the end. */
async function placeCaret(page: Page, lineText: string, at: "start" | "end", left = 0): Promise<void> {
  // The editor draws a table as a table (lib/editorTables.ts); pressing a cell turns it back into text lines.
  const table = page.locator(".cm-table");
  if (await table.count()) {
    await table.first().locator("td, th", { hasText: lineText }).first().click();
    await expect(table).toHaveCount(0);
  }
  await page.locator(".cm-line", { hasText: lineText }).first().click();
  await page.keyboard.press(at === "start" ? "Home" : "End");
  for (let i = 0; i < left; i++) await page.keyboard.press("ArrowLeft");
}

type Case = { name: string; md: string; line: string; at?: "start" | "end"; left?: number; right?: number; expected: string };
const CASES: Case[] = [
  { name: "start of a line", md: "hello", line: "hello", at: "start", expected: "你Zhello" },
  { name: "end of a line", md: "hello", line: "hello", expected: "hello你Z" },
  { name: "in a bullet item", md: "- item", line: "item", expected: "- item你Z" },
  { name: "in a task item", md: "- [ ] todo", line: "todo", expected: "- [ ] todo你Z" },
  { name: "in a numbered item", md: "1. first", line: "first", expected: "1. first你Z" },
  { name: "in a table cell", md: "| a | b |\n|---|---|\n| c | d |", line: "c", at: "end", left: 6, expected: "| a | b |\n|---|---|\n| c你Z | d |" },
  { name: "right after bold", md: "**bold**", line: "bold", expected: "**bold**你Z" },
  { name: "inside bold", md: "**bold**", line: "bold", left: 2, expected: "**bold你Z**" },
  { name: "right after italic", md: "*it*", line: "it", expected: "*it*你Z" },
  { name: "right after a [[link]]", md: "see [[Other note]]", line: "see", expected: "see [[Other note]]你Z" },
  { name: "right after #tag", md: "word #tagx", line: "word", expected: "word #tagx你Z" },
  { name: "next to math", md: "area $x^2$", line: "area", expected: "area $x^2$你Z" },
  { name: "in a quote", md: "> quoted", line: "quoted", expected: "> quoted你Z" },
  { name: "in a heading", md: "# Title", line: "Title", expected: "# Title你Z" },
  { name: "at the start of a heading", md: "# Title", line: "Title", at: "start", right: 2, expected: "# 你ZTitle" },
];

for (const c of CASES) {
  test(`editor: composing ${c.name} saves exactly the final text`, async ({ page }) => {
    const id = await openNoteWith(page, c.md);
    const ime = await startIme(page);
    await placeCaret(page, c.line, c.at ?? "end", c.left ?? 0);
    for (let i = 0; i < (c.right ?? 0); i++) await page.keyboard.press("ArrowRight");

    await ime.composeSteps(ZHUYIN);
    expect(await ime.composing()).toBe(true);
    await ime.pickWithEnter("你");
    await expect.poll(() => ime.composing()).toBe(false);
    expect(await keysSeen(page)).toContain("keydown:Enter:true");
    await page.keyboard.type("Z");

    await expect.poll(() => savedMarkdown(page, id), { timeout: 20_000 }).toBe(c.expected);
    await page.reload();
    await expect(page.locator(".cm-content")).toContainText("你");
    expect(await savedMarkdown(page, id)).toBe(c.expected);
  });
}

test("editor: cancelling a composition leaves the text as it was", async ({ page }) => {
  const id = await openNoteWith(page, "hello");
  const ime = await startIme(page);
  await placeCaret(page, "hello", "end");
  await ime.composeSteps(["ㄋ", "ㄋㄧ"]);
  await ime.escapeWhileComposing();
  await ime.cancel();
  await expect.poll(() => ime.composing()).toBe(false);
  await expect(page.locator(".cm-content")).not.toContainText("ㄋ");
  await page.keyboard.type("Z");
  await expect.poll(() => savedMarkdown(page, id), { timeout: 20_000 }).toBe("helloZ");
});

test("editor: changing the candidate mid-composition keeps only the picked one", async ({ page }) => {
  const id = await openNoteWith(page, "hello");
  const ime = await startIme(page);
  await placeCaret(page, "hello", "end");
  await ime.composeSteps(["ㄋ", "ㄋㄧ", "你", "尼", "泥"]);
  await expect(page.locator(".cm-content")).toContainText("hello泥");
  await ime.pickWithEnter("尼");
  await page.keyboard.type("Z");
  await expect.poll(() => savedMarkdown(page, id), { timeout: 20_000 }).toBe("hello尼Z");
});

test("editor: Enter that picks a candidate adds no line; the next Enter does", async ({ page }) => {
  const id = await openNoteWith(page, "- item");
  const ime = await startIme(page);
  await placeCaret(page, "item", "end");
  await ime.composeSteps(ZHUYIN);
  await ime.pickWithEnter("你");
  await expect(page.locator(".cm-line")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Z");
  await expect.poll(() => savedMarkdown(page, id), { timeout: 20_000 }).toBe("- item你\n- Z");
});

test("editor: Tab and Escape during a composition do not indent or leave the note", async ({ page }) => {
  const id = await openNoteWith(page, "- item");
  const ime = await startIme(page);
  await placeCaret(page, "item", "end");
  await ime.composeSteps(["ㄋ", "ㄋㄧ"]);
  await page.evaluate(() => {
    const target = document.querySelector(".cm-content")!;
    for (const key of ["Tab", "Escape", "ArrowDown", "ArrowUp"]) {
      // keyCode 229 is what an input method reports for the keys it handles.
      target.dispatchEvent(new KeyboardEvent("keydown", { key, keyCode: 229, bubbles: true, cancelable: true, isComposing: true }));
    }
  });
  await ime.pickWithEnter("你");
  await page.keyboard.type("Z");
  await expect.poll(() => savedMarkdown(page, id), { timeout: 20_000 }).toBe("- item你Z");
});

test("editor: autosave while composing neither swaps the editor content nor ends the composition", async ({ page }) => {
  const id = await openNoteWith(page, "hello");
  const ime = await startIme(page);
  await placeCaret(page, "hello", "end");
  await page.keyboard.type(" a"); // a real edit, so an autosave is due
  await ime.composeSteps(["ㄋ", "ㄋㄧ"]);
  // Longer than the autosave debounce and a save round trip.
  await expect.poll(() => savedMarkdown(page, id), { timeout: 20_000 }).toContain("hello a");
  await page.waitForTimeout(2_500);
  expect(await ime.composing()).toBe(true);
  await expect(page.locator(".cm-content")).toContainText("hello aㄋㄧ");
  await ime.composeSteps(["你"]);
  await ime.pickWithEnter("你");
  await page.keyboard.type("Z");
  await expect.poll(() => savedMarkdown(page, id), { timeout: 20_000 }).toBe("hello a你Z");
});

test("editor: a change arriving from another tab does not interrupt the composition", async ({ page, context }) => {
  const id = await openNoteWith(page, "hello\n\nsecond");
  const ime = await startIme(page);
  await placeCaret(page, "hello", "end");
  await ime.composeSteps(["ㄋ", "ㄋㄧ"]);

  // The other tab: a real edit of the last line, saved while the first tab composes.
  const other = await context.newPage();
  await ready(other, `/?view=notes&node=${id}`);
  await other.locator(".cm-line", { hasText: "second" }).click();
  await other.keyboard.press("End");
  await other.keyboard.type(" remote");
  await expect.poll(() => savedMarkdown(page, id), { timeout: 20_000 }).toContain("second remote");
  await page.waitForTimeout(2_500); // the live update has reached the first tab by now

  expect(await ime.composing()).toBe(true);
  await ime.composeSteps(["你"]);
  await ime.pickWithEnter("你");
  await page.keyboard.type("Z");
  await expect.poll(() => savedMarkdown(page, id), { timeout: 20_000 }).toBe("hello你Z\n\nsecond remote");
  await other.close();
});
