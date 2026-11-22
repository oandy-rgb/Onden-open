// Feature-audit deepening (2026-10-07): REV-04 — Q:/A: extraction: partial
// failure and re-run, later edits to the source, desktop and phone entries.
// What extraction does is written in modules/review/extractCards.ts: the lecture is untouched, each Q:/A: becomes a CHILD note that is a review
// card, a question that already exists as a child (same title) is skipped, so a run that failed half-way is finished by running it again.
import { test, expect, type Page } from "@playwright/test";
import { ready, BASE, H } from "./helpers";

async function palette(page: Page, label: string) {
  await expect(async () => { await page.keyboard.press("Control+k"); await expect(page.locator(".palette-input-wrap input")).toBeVisible({ timeout: 1000 }); }).toPass({ timeout: 15_000 });
  await page.locator(".palette-input-wrap input").fill(">Extract review");
  await page.locator(".palette-item", { hasText: label }).click();
}
const cards = async (page: Page, parent: string) => {
  const boot = await (await page.request.get("/api/bootstrap?bodies=none", H)).json();
  return (boot.nodes as Array<{ id: string; parent_id: string; title: string; class_tag_ids?: string[]; label_tag_ids?: string[] }>)
    .filter((n) => n.parent_id === parent).map((n) => ({ id: n.id, title: n.title, tags: [...(n.class_tag_ids ?? []), ...(n.label_tag_ids ?? [])] }));
};
/** How many of these notes are review cards (their own reference). */
const cardCount = async (page: Page, notes: Array<{ id: string }>) => {
  let n = 0;
  for (const note of notes) if ((await (await page.request.get(`/api/review/cards/${note.id}`, H)).json() as { card: boolean }).card) n++;
  return n;
};
const toastWith = (page: Page, text: string | RegExp) => page.locator(".toast, [role='alert']").filter({ hasText: text }).first();

test("REV-04: partial failure, re-run, edits after extraction", async ({ page }) => {
  test.setTimeout(150_000);
  const s = Date.now();
  const lec = await (await page.request.post("/api/nodes", { ...H, data: { title: `Lecture ${s}`, markdown: `Q: What is ATP ${s}?\nA: energy\n\nQ: What is DNA ${s}?\nA: genes` } })).json();
  await ready(page, `/?view=notes&node=${lec.id}`);

  // Partial failure: the 2nd card's "make it a review card" request fails. Both notes exist, one is a card, and the person is told
  // that one card still has to be made (extractCards.ts: "{n} cards could not be made review cards yet. Run it again when you are online.").
  let cardPuts = 0;
  await page.route("**/api/review/cards/*", (r) => { if (r.request().method() === "PUT" && ++cardPuts === 2) return r.fulfill({ status: 503, body: "{}" }); return r.continue(); });
  await palette(page, "Extract review cards (Q:/A:)");
  await expect.poll(async () => (await cards(page, lec.id)).length).toBe(2);
  await expect(toastWith(page, "1 cards could not be made review cards yet. Run it again when you are online.")).toBeVisible();
  await expect(toastWith(page, "Extracted 2 review cards")).toBeVisible(); // pinned: today's behaviour, no written rule (the notes were extracted; the toast does not say that one is not a card yet)
  await page.unroute("**/api/review/cards/*");
  let cs = await cards(page, lec.id);
  expect(await cardCount(page, cs), "one of the two is a review card").toBe(1);

  // Re-run makes the missing card, and no note twice.
  await palette(page, "Extract review cards (Q:/A:)");
  await expect(toastWith(page, "Made 1 existing notes review cards")).toBeVisible();
  cs = await cards(page, lec.id);
  expect(cs, "no question is extracted twice").toHaveLength(2);
  expect(await cardCount(page, cs), "now both are review cards").toBe(2);
  await palette(page, "Extract review cards (Q:/A:)");
  await expect(toastWith(page, "All 2 cards already extracted")).toBeVisible();

  // Edit the source, re-extract: a question that is already a child (same title) is skipped, so its card keeps its old answer; a new
  // question makes a new card; a question that is gone from the lecture leaves its card where it was (extractCards.ts only adds).
  await page.request.patch(`/api/nodes/${lec.id}`, { ...H, data: { markdown: `Q: What is ATP ${s}?\nA: adenosine triphosphate\n\nQ: What is RNA ${s}?\nA: genes` } });
  await ready(page, `/?view=notes&node=${lec.id}`);
  await palette(page, "Extract review cards (Q:/A:)");
  await expect(toastWith(page, "Extracted 1 review cards")).toBeVisible();
  cs = await cards(page, lec.id);
  expect(cs.map((c) => c.title.replace(String(s), "").trim()).sort(), "the new question has a card").toEqual(["What is ATP ?", "What is DNA ?", "What is RNA ?"]);
  const atp = cs.find((c) => c.title.includes("ATP"))!;
  const atpBody = (await (await page.request.get(`/api/nodes/${atp.id}`, H)).json()).markdown as string;
  expect(atpBody.includes("adenosine"), "the existing card keeps its answer").toBe(false);
  expect(atpBody).toContain("energy");
  expect(await cardCount(page, cs), "all three are review cards").toBe(3);
});

test("REV-04: phone entry", async ({ browser, page: base }) => {
  const s = Date.now();
  const lec = await (await base.request.post("/api/nodes", { ...H, data: { title: `PhoneLec ${s}`, markdown: `Q: Phone q ${s}?\nA: yes` } })).json();
  const ctx = await browser.newContext({ storageState: await base.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const page = await ctx.newPage();
  await ready(page, `/?view=notes&node=${lec.id}`);
  // The phone's note menu does not list the extraction (it is a note command of the palette and of the note's function rows, not of the ⋯ menu).
  const menuBtn = page.locator(".note-actions-more, button[aria-label*='More']").filter({ visible: true }).first();
  await menuBtn.click();
  await expect(page.getByText("Extract review cards").filter({ visible: true })).toHaveCount(0); // pinned: today's behaviour, no written rule
  await page.keyboard.press("Escape");
  // The palette opens with the shortcut at any width and extracts the same way.
  await palette(page, "Extract review cards");
  await expect.poll(async () => { const cs = await cards(page, lec.id); return `${cs.length}/${await cardCount(page, cs)}`; }).toBe("1/1");
  await expect(toastWith(page, "Extracted 1 review cards")).toBeVisible();
  await ctx.close();
});
