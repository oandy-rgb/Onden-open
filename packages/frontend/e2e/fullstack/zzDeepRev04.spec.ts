// Feature-audit deepening (2026-10-07): REV-04 — Q:/A: extraction: partial
// failure and re-run, later edits to the source, desktop and phone entries.
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
const lastToast = async (page: Page) => ((await page.locator(".toast, [role='alert']").allInnerTexts()).slice(-1)[0] ?? "").replace(/\s+/g, " ").slice(0, 80);

test("REV-04: partial failure, re-run, edits after extraction", async ({ page }) => {
  test.setTimeout(150_000);
  const s = Date.now(); const out: Record<string, string> = {};
  const lec = await (await page.request.post("/api/nodes", { ...H, data: { title: `Lecture ${s}`, markdown: `Q: What is ATP ${s}?\nA: energy\n\nQ: What is DNA ${s}?\nA: genes` } })).json();
  await ready(page, `/?view=notes&node=${lec.id}`);

  // Partial failure: the 2nd card's "make it a review card" request fails.
  let cardPuts = 0;
  await page.route("**/api/review/cards/*", (r) => { if (r.request().method() === "PUT" && ++cardPuts === 2) return r.fulfill({ status: 503, body: "{}" }); return r.continue(); });
  await palette(page, "Extract review cards (Q:/A:)");
  await page.waitForTimeout(2500);
  await page.unroute("**/api/review/cards/*");
  let cs = await cards(page, lec.id);
  out.partial = `children=${cs.length} cards=${await cardCount(page, cs)} toast=${JSON.stringify(await lastToast(page))}`;
  // Re-run makes the missing card.
  await palette(page, "Extract review cards (Q:/A:)");
  await page.waitForTimeout(2000);
  cs = await cards(page, lec.id);
  out.rerun = `children=${cs.length} cards=${await cardCount(page, cs)} toast=${JSON.stringify(await lastToast(page))}`;
  await palette(page, "Extract review cards (Q:/A:)");
  await page.waitForTimeout(1500);
  out.thirdRun = JSON.stringify(await lastToast(page));

  // Edit the answer in the source, re-extract: is the card updated?
  await page.request.patch(`/api/nodes/${lec.id}`, { ...H, data: { markdown: `Q: What is ATP ${s}?\nA: adenosine triphosphate\n\nQ: What is RNA ${s}?\nA: genes` } });
  await ready(page, `/?view=notes&node=${lec.id}`);
  await palette(page, "Extract review cards (Q:/A:)");
  await page.waitForTimeout(2000);
  cs = await cards(page, lec.id);
  const atp = cs.find((c) => c.title.includes("ATP"));
  const atpBody = atp ? (await (await page.request.get(`/api/nodes/${atp.id}`, H)).json()).markdown as string : "";
  out.afterEdit = `cards=${JSON.stringify(cs.map((c) => c.title.replace(String(s), "")))} atpAnswerUpdated=${atpBody.includes("adenosine")} toast=${JSON.stringify(await lastToast(page))}`;
  console.log(`AUDIT REV-04 ${JSON.stringify(out)}`);
});

test("REV-04: phone entry", async ({ browser, page: base }) => {
  const s = Date.now();
  const lec = await (await base.request.post("/api/nodes", { ...H, data: { title: `PhoneLec ${s}`, markdown: `Q: Phone q ${s}?\nA: yes` } })).json();
  const ctx = await browser.newContext({ storageState: await base.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const page = await ctx.newPage();
  await ready(page, `/?view=notes&node=${lec.id}`);
  const menuBtn = page.locator(".note-actions-more, button[aria-label*='More']").filter({ visible: true }).first();
  const viaMenu = await menuBtn.count() ? (await menuBtn.click(), await page.getByText("Extract review cards").filter({ visible: true }).count()) : 0;
  if (viaMenu) await page.getByText("Extract review cards").filter({ visible: true }).first().click();
  else {
    await page.keyboard.press("Escape");
    // The phone's 更多 sheet no longer lists Search: the palette opens with the shortcut at any width.
    await expect(async () => { await page.keyboard.press("Control+k"); await expect(page.locator(".palette-input-wrap input")).toBeVisible({ timeout: 1000 }); }).toPass({ timeout: 15_000 });
    await page.locator(".palette-input-wrap input").fill(">Extract review");
    await page.locator(".palette-item", { hasText: "Extract review cards" }).click();
  }
  await page.waitForTimeout(2500);
  const n = (await cards(page, lec.id)).length;
  console.log(`AUDIT REV-04 phone ${JSON.stringify({ viaNoteMenu: viaMenu > 0, cards: n })}`);
  await ctx.close();
});
