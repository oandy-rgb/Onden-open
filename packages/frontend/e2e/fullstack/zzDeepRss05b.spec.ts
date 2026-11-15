// RSS-05 follow-up (2026-10-08): reader UI — "Save to notes" with a lost
// response then a second press, and an offline save that replays; reopening
// the saved note from the reader.
import { test, expect, type Page } from "@playwright/test";
import { ready, BASE, H, syncLabel } from "./helpers";

type Item = { id: string; title: string; saved_node_id?: string | null };

test("RSS-05b: reader save — lost response, offline, reopen", async ({ page, context }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  for (let i = 0; i < 2; i++) {
    const node = await (await page.request.post("/api/nodes", { ...H, data: { title: `R5b art ${i} (${stamp})`, markdown: `Body ${i}.` } })).json();
    await page.request.put(`/api/nodes/${node.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
  }
  const sub = await (await page.request.post("/api/rss/subscribe", { ...H, data: { url: `http://nginx/site/feed.xml?run=${stamp}` } })).json();
  await page.request.post(`/api/rss/sources/${sub.id}/refresh`, { ...H, data: {} });
  const items = async (): Promise<Item[]> => (((await (await page.request.get("/api/rss/items?limit=200")).json()).items ?? []) as Item[]).filter((i) => i.title.includes(`(${stamp})`));
  await expect.poll(async () => (await items()).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  const its = await items();
  const rssNotes = async (title: string) => ((await (await page.request.get("/api/bootstrap?slim=1")).json()).nodes as Array<{ title: string }>).filter((n) => n.title === title).length - 1;
  const open = async (p: Page, title: string) => { await ready(p, "/?view=rss"); await p.waitForTimeout(1500); await p.locator(".rss-item-list button", { hasText: title }).first().click(); await p.waitForTimeout(1000); };
  const notice = () => page.locator(".rss-right").innerText().then((t) => (t.match(/Saved[^\n]*|Could not[^\n]*|Failed[^\n]*/)?.[0] ?? "").slice(0, 100)).catch(() => "");
  try {
  await open(page, its[0].title);
  let lost = false;
  await page.route("**/api/rss/items/*/save", async (r) => { if (lost) return r.continue(); lost = true; await r.fetch(); return r.abort("connectionreset"); });
  await page.getByRole("button", { name: /Save to notes/ }).first().click();
  await page.waitForTimeout(1500);
  out.lostUi = { button: (await page.getByRole("button", { name: /Save to notes|Saved/ }).first().innerText()).trim(), notice: await notice(), sync: (await syncLabel(page)).replace(/\s+/g, " ") };
  const again = page.getByRole("button", { name: /Save to notes/ }).first();
  if (await again.isVisible().catch(() => false)) { await again.click(); await page.waitForTimeout(1500); }
  await page.unroute("**/api/rss/items/*/save");
  await page.waitForTimeout(5000);
  out.lostResult = { notes: await rssNotes(its[0].title), saved: !!(await items()).find((i) => i.id === its[0].id)?.saved_node_id };
  // Reopen the saved note from the reader.
  await open(page, its[0].title);
  const openNote = page.locator(".rss-act-open").first();
  out.reopenControl = (await openNote.innerText().catch(() => "")).trim();
  await openNote.click().catch(() => {}); await page.waitForTimeout(1500);
  out.reopen = { url: page.url().replace(BASE, "").slice(0, 50), title: await page.locator(".obsidian-title-input, [aria-label='Note title']").first().inputValue().catch(() => null) };
  // Offline save.
  await open(page, its[1].title);
  await context.setOffline(true); await page.waitForTimeout(600);
  await page.getByRole("button", { name: /Save to notes/ }).first().click();
  await page.waitForTimeout(1200);
  out.offlineUi = { button: (await page.getByRole("button", { name: /Save to notes|Saved/ }).first().innerText()).trim(), notice: await notice() };
  await context.setOffline(false); await page.waitForTimeout(8000);
  out.offlineReplay = { notes: await rssNotes(its[1].title), saved: !!(await items()).find((i) => i.id === its[1].id)?.saved_node_id };
  } finally {
    await context.setOffline(false).catch(() => {});
    console.log("RSS05B " + JSON.stringify(out, null, 2));
  }
});
