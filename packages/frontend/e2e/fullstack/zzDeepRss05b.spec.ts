// RSS-05 follow-up (2026-10-08): reader UI — "Save to notes" with a lost
// response then a second press, and an offline save that replays; reopening
// the saved note from the reader.
import { test, expect } from "@playwright/test";
import { ready, H, expectPending, pendingCount } from "./helpers";
import { publishFeedArticles, siteFeedUrl } from "./feedHelpers";

type Item = { id: string; title: string; saved_node_id?: string | null };

test("RSS-05b: reader save — lost response, offline, reopen", async ({ page, context }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  await publishFeedArticles(page.request, Array.from({ length: 2 }, (_, i) => `R5b art ${i} (${stamp})`), (i) => `Body ${i}.`);
  const sub = await (await page.request.post("/api/rss/subscribe", { ...H, data: { url: siteFeedUrl(stamp) } })).json();
  await page.request.post(`/api/rss/sources/${sub.id}/refresh`, { ...H, data: {} });
  const items = async (): Promise<Item[]> => (((await (await page.request.get("/api/rss/items?limit=200")).json()).items ?? []) as Item[]).filter((i) => i.title.includes(`(${stamp})`));
  await expect.poll(async () => (await items()).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  const its = (await items()).sort((a, b) => a.title.localeCompare(b.title));
  const rssNotes = async (title: string) => ((await (await page.request.get("/api/bootstrap?slim=1")).json()).nodes as Array<{ title: string }>).filter((n) => n.title === title).length - 1; // minus the published source note
  const savedOf = async (id: string) => (await items()).find((i) => i.id === id)?.saved_node_id ?? null;
  const open = async (title: string) => { await ready(page, "/?view=rss"); await page.locator(".rss-item-list button", { hasText: title }).first().click(); await expect(page.locator(".rss-article-title")).toContainText(title); };
  try {
  // The reply to the save is lost: the button reads saved, the retry keeps its key, and there is exactly one note (AGENTS.md 錯誤與保存: a lost reply
  // is retried with the original idempotency key). Once the retry went through, nothing is left waiting.
  await open(its[0].title);
  let lost = false;
  await page.route("**/api/rss/items/*/save", async (r) => { if (lost) return r.continue(); lost = true; await r.fetch(); return r.abort("connectionreset"); });
  await page.getByRole("button", { name: /Save to notes/ }).first().click();
  await expect(page.locator(".rss-act-open").first()).toContainText("Saved · open note");
  await expect.poll(() => lost).toBe(true);
  await page.unroute("**/api/rss/items/*/save");
  await expect.poll(async () => await savedOf(its[0].id), { timeout: 30_000 }).not.toBeNull();
  expect(await rssNotes(its[0].title), "one note, not one per attempt").toBe(1);
  await expect.poll(() => pendingCount(page), { timeout: 30_000 }).toBe(0);
  // Reopen the saved note from the reader: the control reads 「Saved · open note」 and opens the note that was made.
  await open(its[0].title);
  const openNote = page.locator(".rss-act-open").first();
  await expect(openNote).toHaveText("Saved · open note");
  await openNote.click();
  await expect(page).toHaveURL(new RegExp(`node=${await savedOf(its[0].id)}`));
  await expect(page.locator(".obsidian-title-input, [aria-label='Note title']").first()).toHaveValue(its[0].title);
  // Offline save: the person sees it saved, the sync badge shows it waits, and after reconnecting there is one note.
  await open(its[1].title);
  await context.setOffline(true);
  await page.getByRole("button", { name: /Save to notes/ }).first().click();
  await expect(page.locator(".rss-act-open").first()).toHaveText("Saved · open note");
  await expectPending(page);
  await context.setOffline(false);
  await expect.poll(async () => await savedOf(its[1].id), { timeout: 30_000 }).not.toBeNull();
  expect(await rssNotes(its[1].title), "one note after the replay").toBe(1);
  await expect.poll(() => pendingCount(page), { timeout: 30_000 }).toBe(0);
  } finally {
    await context.setOffline(false).catch(() => {});
  }
});
