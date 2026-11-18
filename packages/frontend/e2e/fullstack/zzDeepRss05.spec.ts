// Feature-audit deepening (2026-10-08): RSS-05 — save an article as a note:
// two devices saving the same article at the same moment, a client-supplied
// node_id that belongs to an unrelated (or unreadable) note, a lost response
// then retry from the reader UI, the saved note deleted then saved again,
// and an offline save that replays.
// Saving an article is one operation whose result is one usable note, however many devices press it or however often a lost reply is retried
// (docs/research/full-feature-audit.md RSS-05 and GAP-198: 「保存文章成筆記；重複、跨裝置保存返回同一可用來源」; the retry keeps its idempotency key, AGENTS.md 錯誤與保存).
import { test, expect } from "@playwright/test";
import { ready, BASE, H, PAGE, expectPending, pendingCount } from "./helpers";
import { publishFeedArticles, siteFeedUrl } from "./feedHelpers";

type Item = { id: string; title: string; saved_node_id?: string | null };

test("RSS-05: save race, foreign node_id, lost response, deleted note, offline", async ({ page, browser, context }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  await publishFeedArticles(page.request, Array.from({ length: 4 }, (_, i) => `R05 art ${i} (${stamp})`), (i) => `Body ${i} of ${stamp}.`);
  const sub = await (await page.request.post("/api/rss/subscribe", { ...H, data: { url: siteFeedUrl(stamp) } })).json();
  await page.request.post(`/api/rss/sources/${sub.id}/refresh`, { ...H, data: {} });
  const items = async (): Promise<Item[]> => (((await (await page.request.get("/api/rss/items?limit=200")).json()).items ?? []) as Item[]).filter((i) => i.title.includes(`(${stamp})`));
  await expect.poll(async () => (await items()).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
  const its = (await items()).sort((a, b) => a.title.localeCompare(b.title));
  const notesTitled = async (t: string) => ((await (await page.request.get("/api/bootstrap?slim=1")).json()).nodes as Array<{ id: string; title: string }>).filter((n) => n.title === t).length - 1; // minus the published source note
  const savedOf = async (id: string) => (await items()).find((i) => i.id === id)?.saved_node_id ?? null;
  const open = async (title: string) => { await ready(page, "/?view=rss"); await page.locator(".rss-item-list button", { hasText: title }).first().click(); await expect(page.locator(".rss-article-title")).toContainText(title); };
  try {
  // 1) Two devices save the same article simultaneously: one creates the note, the other is told it is already saved, and there is one note.
  const devB = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json" });
  const [r1, r2] = await Promise.all([
    page.request.post(`/api/rss/items/${its[0].id}/save`, { ...H, data: { node_id: crypto.randomUUID() } }),
    devB.request.post(`/api/rss/items/${its[0].id}/save`, { ...H, data: { node_id: crypto.randomUUID() } }),
  ]);
  expect([r1.status(), r2.status()].sort(), "one save creates, the other finds it saved").toEqual([200, 201]);
  const j1 = await r1.json(), j2 = await r2.json();
  expect(j1.node_id, "both get the same note").toBe(j2.node_id);
  expect(await notesTitled(its[0].title), "and there is one note").toBe(1);
  await devB.close();
  // 2) A client-supplied node_id that belongs to an unrelated note is refused, and that note is not touched (GAP-198: the id is accepted only when
  // it is new or is this article's own note).
  const other = (await (await page.request.post("/api/nodes", { ...H, data: { title: `Unrelated ${stamp}`, markdown: "my own private thoughts" } })).json()).id as string;
  const rf = await page.request.post(`/api/rss/items/${its[1].id}/save`, { ...H, data: { node_id: other } });
  expect(rf.status()).toBe(409);
  expect(await savedOf(its[1].id), "the article is not bound to the unrelated note").toBeNull();
  expect((await (await page.request.get(`/api/nodes/${other}`)).json()).markdown, "the unrelated note is untouched").toBe("my own private thoughts");
  // 3) Lost response from the reader UI, then retry: the save reached the server, the reply did not, the retry keeps its key: one note.
  await open(its[2].title);
  let lost = false;
  await page.route("**/api/rss/items/*/save", async (r) => { if (lost) return r.continue(); lost = true; await r.fetch(); return r.abort("connectionreset"); });
  await page.getByRole("button", { name: /Save to notes/ }).first().click();
  await expect(page.locator(".rss-act-open").first()).toContainText("Saved · open note");
  await expect.poll(() => lost).toBe(true);
  await page.unroute("**/api/rss/items/*/save");
  await expect.poll(async () => await savedOf(its[2].id), { timeout: 30_000 }).not.toBeNull();
  expect(await notesTitled(its[2].title), "one note, not one per attempt").toBe(1);
  await expect.poll(() => pendingCount(page), { timeout: 30_000 }).toBe(0);
  // 4) Delete the saved note, then save again: the article reads as unsaved (it can be saved again) and the answer is a note that can be opened.
  const s0 = (await items()).find((i) => i.id === its[0].id)!;
  await page.request.delete(`/api/nodes/${s0.saved_node_id}`, { headers: PAGE });
  const again = await page.request.post(`/api/rss/items/${its[0].id}/save`, { ...H, data: { node_id: crypto.randomUUID() } });
  const aj = await again.json();
  expect(again.status()).toBe(200);
  expect(aj.already_saved ?? false, "the deleted save does not count as saved").toBe(false);
  expect((await page.request.get(`/api/nodes/${aj.node_id}`)).status(), "the note it answers with opens (GAP-198: not a deleted id)").toBe(200);
  expect(aj.node_id, "the same note comes back").toBe(s0.saved_node_id); // pinned: today's behaviour, no written rule (GAP-198 allows either: clear the save or rebuild it)
  // 5) Offline save from the UI: the person sees it saved, the sync badge shows it waits, and after reconnecting there is one note.
  await open(its[3].title);
  await context.setOffline(true);
  await page.getByRole("button", { name: /Save to notes/ }).first().click();
  await expect(page.locator(".rss-act-open").first()).toContainText("Saved · open note");
  await expectPending(page);
  await context.setOffline(false);
  await expect.poll(async () => await savedOf(its[3].id), { timeout: 30_000 }).not.toBeNull();
  expect(await notesTitled(its[3].title), "one note after the replay").toBe(1);
  await expect.poll(() => pendingCount(page), { timeout: 30_000 }).toBe(0);
  } finally {
    await context.setOffline(false).catch(() => {});
  }
});
