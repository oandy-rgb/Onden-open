// 回饋修復: the editor must NOT jump while typing/deleting across autosave
// round-trips (the stale-base self-merge made every second save reflect a
// rewritten body with the caret reset to 0).
import { test, expect } from "@playwright/test";
import { ready, H } from "./helpers";


test("caret survives several autosave cycles of typing and deleting", async ({ page }) => {
  const note = await (await page.request.post("/api/nodes", {
    ...H, data: { title: `Stability ${Date.now()}`, markdown: "# s\n\nhello world" },
  })).json();
  await ready(page, `/?view=notes&node=${note.id}`);
  const cm = page.locator(".cm-content");
  await cm.click();
  await page.keyboard.press("Control+End");

  const caretPos = () => page.evaluate(() => {
    const sel = window.getSelection();
    return sel && sel.rangeCount ? { text: sel.anchorNode?.textContent ?? "", off: sel.anchorOffset } : null;
  });

  // type → wait past autosave → delete chars → wait again → type — three
  // round-trips; the caret must stay at the END of the text throughout.
  await page.keyboard.type(" one");
  await page.waitForTimeout(2000); // autosave A lands
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(2000); // autosave B (the old bug fired here)
  await page.keyboard.type("two");
  await page.waitForTimeout(2000); // autosave C
  await page.keyboard.type("!");

  // typing "!" lands where we left off — NOT at position 0 / start of doc
  const body = await cm.textContent();
  expect(body).toContain("otwo!"); // " one" -2 chars +"two"+"!" appended in place
  expect(body!.indexOf("!")).toBeGreaterThan(5); // never prepended at the top
  const pos = await caretPos();
  expect(pos?.off ?? 0).toBeGreaterThan(0);

  // and the server body matches what we see (no self-merge duplication)
  await page.waitForTimeout(2000);
  const saved = await (await page.request.get(`/api/nodes/${note.id}`)).json();
  expect(saved.markdown).toContain("hello world otwo!");
  expect(saved.markdown.match(/otwo!/g)?.length).toBe(1); // not duplicated
});
