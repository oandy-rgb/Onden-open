// Scenario 10 — answers out of order (owner report 2026-11-16: alone on a tablet, typing, told the note was "merged").
// A sync answer the server computed BEFORE a save is held back and delivered only AFTER that save was acknowledged:
// desktop Chromium normally receives answers in order, a tablet does not. The answer is the real backend's, read when
// the request reached it (`route.fetch`), so it carries the head it was read at; the save's response carries the
// position it committed at (X-Onden-Event-Position). The late answer must change nothing the save made: the editor
// keeps the typed text, and the next save's base is the text the server acknowledged (otherwise the server merges it
// "with another writer" although nobody else wrote). No waits on time: every step waits on a request or a state.
import { test, expect, type Page, type Response } from "@playwright/test";
import {
  FAULTS_TAG, PHONE, editor, expectColdConvergence, expectServerHas, openNote, seedNote, skipUnlessRequested,
  typeInNote, uniqueToken,
} from "./faultKit";

test.beforeEach(skipUnlessRequested);

/** Open a note by its title from the command palette (inside the page: no reload, the store stays as it is). */
async function openThroughPalette(page: Page, title: string): Promise<void> {
  // The shortcut works on every layout (the phone has no palette button); the first press can land before focus.
  await expect(async () => {
    if (!(await page.locator(".palette-input-wrap input").isVisible())) await page.keyboard.press("ControlOrMeta+k");
    await expect(page.locator(".palette-input-wrap input")).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await page.locator(".palette-input-wrap input").fill(title);
  const item = page.locator(".palette-item", { hasText: title }).first();
  await item.click();
  await expect(page.locator(".palette-modal")).toHaveCount(0);
  await expect(page.locator(".obsidian-title-input").first()).toHaveValue(title, { timeout: 15_000 });
}

type Save = { base?: string; sent: string; acknowledged?: string };

async function lateAnswerAfterSave(page: Page): Promise<void> {
  const first = uniqueToken("first");
  const second = uniqueToken("second");
  const third = uniqueToken("third");
  const id = await seedNote(page);
  const title = ((await (await page.request.get(`/api/nodes/${id}`)).json()) as { title: string }).title;
  const otherId = await seedNote(page, "the other note");
  const otherTitle = ((await (await page.request.get(`/api/nodes/${otherId}`)).json()) as { title: string }).title;
  await openNote(page, id);

  // Every save of this note, with the base it carried and the text the server acknowledged.
  const saves: Save[] = [];
  page.on("request", (request) => {
    if (request.method() !== "PATCH" || !request.url().endsWith(`/api/nodes/${id}`)) return;
    const body = JSON.parse(request.postData() ?? "{}") as { markdown?: string; base_markdown?: string };
    if (body.markdown !== undefined) saves.push({ base: body.base_markdown, sent: body.markdown });
  });
  const acknowledged = (response: Response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/nodes/${id}`) && response.ok();
  page.on("response", async (response) => {
    if (!acknowledged(response)) return;
    const body = JSON.parse(response.request().postData() ?? "{}") as { markdown?: string };
    const save = saves.find((s) => s.sent === body.markdown && s.acknowledged === undefined);
    if (save) save.acknowledged = ((await response.json().catch(() => ({}))) as { markdown?: string }).markdown ?? "";
  });

  // The first save goes through, at position P1.
  const firstAck = page.waitForResponse(acknowledged);
  await typeInNote(page, "end", ` ${first}`);
  const p1 = Number((await firstAck).headers()["x-onden-event-position"]);
  expect(p1).toBeGreaterThan(0);

  // Hold the next sync answer: read by the real server now, delivered later. It is read as the pass that started just
  // before save 1 would have it (since P1 - 1), so it carries the note as save 1 left it, whatever this page's cursor.
  let holding = true;
  // After the late answer: every later sync request waits here, so what the page shows is what that answer left.
  let holdRest = false;
  const rest: Array<() => Promise<void>> = [];
  const held: Array<{ carriesNote: boolean; deliver: () => Promise<void> }> = [];
  await page.route("**/api/sync", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    if (!holding) {
      if (!holdRest) return route.continue();
      rest.push(() => route.continue());
      return;
    }
    holding = false;
    const response = await route.fetch({ postData: JSON.stringify({ since: p1 - 1 }) });
    const body = await response.body();
    const carriesNote = ((JSON.parse(body.toString()) as { nodes?: { upsert?: Array<{ id: string }> } }).nodes?.upsert ?? []).some((n) => n.id === id);
    held.push({ carriesNote, deliver: () => route.fulfill({ response, body }) });
  });
  // Something changes on the server (another note is made outside this page): the live channel tells the page, which
  // starts a sync pass; its answer is read and kept back. The page waits at most 15 s for an answer (readWithDeadline),
  // so everything up to the delivery below happens well inside that.
  await seedNote(page, "elsewhere");
  await expect.poll(() => held.length, { message: "a sync request must reach the server and be held" }).toBe(1);
  expect(held[0]!.carriesNote, "the held answer carries the note as save 1 left it").toBe(true);

  // The second save is acknowledged while that answer is still on its way, with its position.
  const secondAck = page.waitForResponse(acknowledged);
  await typeInNote(page, "end", ` ${second}`);
  const ack = await secondAck;
  expect(ack.headers()["x-onden-event-position"], "the save's response carries its position").toMatch(/^\d+$/);

  // Now the older answer arrives; whatever the page asks next waits, so nothing can repair what it did.
  holdRest = true;
  const asksAgain = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/sync");
  await held[0]!.deliver();
  await asksAgain; // the answer was handled (taken or refused), and the engine asked for the next one
  // The editor's own draft keeps the typed text whatever the store holds; switching to another note and back shows the
  // note as the page holds it. An answer read before save 2 would have put the text from before it there.
  await openThroughPalette(page, otherTitle);
  await expect.poll(() => editor(page).innerText()).toContain("the other note");
  await openThroughPalette(page, title);
  await expect.poll(() => editor(page).innerText(), { message: "the note as the page holds it keeps the acknowledged text" })
    .toEqual(expect.stringMatching(new RegExp(`(?=[\\s\\S]*${first})(?=[\\s\\S]*${second})`)));
  holdRest = false;
  await page.unroute("**/api/sync");
  for (const go of rest) await go().catch(() => {});

  // The next save starts from what the server acknowledged, so it is not merged.
  const thirdAck = page.waitForResponse(acknowledged);
  await typeInNote(page, "end", ` ${third}`);
  await thirdAck;
  await expectServerHas(page, id, [first, second, third]);
  await expect.poll(() => saves.filter((s) => s.acknowledged === undefined).length).toBe(0);
  const stale = saves.slice(1).filter((save, i) => save.base !== undefined && save.base !== saves[i]!.acknowledged);
  expect(stale, "a save carried a base older than the save acknowledged before it").toEqual([]);
  await expectColdConvergence(page.context(), id, [first, second, third]);
}

test("10: a sync answer read before a save and delivered after its acknowledgement changes nothing", { tag: FAULTS_TAG }, async ({ page }) => {
  test.setTimeout(150_000);
  await lateAnswerAfterSave(page);
});

test.describe("phone viewport", () => {
  test.use({ ...PHONE });
  test("10b (scenario 10 on a Pixel-like phone)", { tag: FAULTS_TAG }, async ({ page }) => {
    test.setTimeout(150_000);
    await lateAnswerAfterSave(page);
  });
});
