// Feature-audit loop probes (2026-10-07): NOTE-02 save triggers in a real
// browser — debounce, Ctrl+S, Save button, switching notes, page hidden,
// title+body together, and a long body. Server copy is the oracle.
import { test, expect, type Page } from "@playwright/test";
import { ready, H } from "./helpers";

const node = async (page: Page, id: string) => (await (await page.request.get(`/api/nodes/${id}`, H)).json()) as { title: string; markdown: string };
const mk = async (page: Page, title: string, markdown = "") =>
  (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown } })).json()) as { id: string };

async function typeAtEnd(page: Page, text: string) {
  const ed = page.locator(".cm-content");
  await ed.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(text);
}

test("NOTE-02: every save trigger reaches the server", async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const results: Record<string, string> = {};
  const timeTo = async (id: string, needle: string, field: "markdown" | "title" = "markdown") => {
    const t0 = Date.now();
    await expect.poll(async () => (await node(page, id))[field], { timeout: 8_000, intervals: [100] }).toContain(needle);
    return `${Date.now() - t0}ms`;
  };

  // 1. debounce autosave
  const a = await mk(page, `Save A ${stamp}`, "a");
  await ready(page, `/?view=notes&node=${a.id}`);
  await typeAtEnd(page, " debounce");
  results.debounce = await timeTo(a.id, "debounce").catch(() => "NOT SAVED");

  // 2. Ctrl+S right after typing (before the 1.5s debounce)
  await typeAtEnd(page, " ctrlS");
  await page.keyboard.press("Control+s");
  results.ctrlS = await timeTo(a.id, "ctrlS").catch(() => "NOT SAVED");

  // 3. No Save button any more (quiet save state): a third edit relies on autosave alone.
  await typeAtEnd(page, " button");
  await expect(page.locator(".note-document .obsidian-save-button")).toHaveCount(0);
  results.button = await timeTo(a.id, "button").catch(() => "NOT SAVED");

  // 4. switch to another note immediately after typing (in-app navigation)
  const b = await mk(page, `Save B ${stamp}`, "b");
  await page.waitForTimeout(1500); // let B arrive via sync
  await typeAtEnd(page, " switched");
  await page.evaluate((id) => { history.pushState({}, "", `/?view=notes&node=${id}`); dispatchEvent(new PopStateEvent("popstate")); }, b.id);
  results.switchNote = await timeTo(a.id, "switched").catch(() => "NOT SAVED");

  // 5. page hidden (mobile app-switch) right after typing
  await page.goto(`/?view=notes&node=${b.id}`, { waitUntil: "load" });
  await page.locator(".cm-content").waitFor();
  await typeAtEnd(page, " hidden");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  results.pageHidden = await timeTo(b.id, "hidden").catch(() => "NOT SAVED");

  // 6. title + body edited together
  const c = await mk(page, `Save C ${stamp}`, "c");
  await ready(page, `/?view=notes&node=${c.id}`);
  const title = page.locator(".obsidian-title-input");
  await title.fill(`Renamed C ${stamp}`);
  await typeAtEnd(page, " body-with-title");
  results.titleAndBody = `${await timeTo(c.id, "body-with-title").catch(() => "BODY NOT SAVED")} / title ${await timeTo(c.id, `Renamed C ${stamp}`, "title").catch(() => "TITLE NOT SAVED")}`;

  // 7. long body (~200 KB) pasted, saved whole, survives reload
  const d = await mk(page, `Save D ${stamp}`, "");
  await ready(page, `/?view=notes&node=${d.id}`);
  const long = Array.from({ length: 4000 }, (_, i) => `line ${i} ${"x".repeat(40)} 中文`).join("\n") + `\nEND-${stamp}`;
  await page.locator(".cm-content").evaluate((el, text) => {
    const dt = new DataTransfer(); dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, long);
  results.longBody = await timeTo(d.id, `END-${stamp}`).catch(() => "NOT SAVED");
  const saved = await node(page, d.id);
  results.longIntact = String(saved.markdown === long) + ` (${saved.markdown.length}/${long.length} chars)`;
  await page.reload({ waitUntil: "load" });
  await page.locator(".cm-content").waitFor();
  await page.keyboard.press("Control+End");
  results.longAfterReload = String(await page.locator(".cm-content").innerText().then((t) => t.includes(`END-${stamp}`)).catch(() => false));

  console.log(`AUDIT NOTE-02 ${JSON.stringify(results)}`);
});
