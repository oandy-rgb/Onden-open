// Feature-audit deepening (2026-10-08): RSS-05 — save an article as a note:
// two devices saving the same article at the same moment, a client-supplied
// node_id that belongs to an unrelated (or unreadable) note, a lost response
// then retry from the reader UI, the saved note deleted then saved again,
// and an offline save that replays.
import { test, expect } from "@playwright/test";
import { ready, BASE, H, PAGE } from "./helpers";

type Item = { id: string; title: string; saved_node_id?: string | null };

test("RSS-05: save race, foreign node_id, lost response, deleted note, offline", async ({ page, browser, context }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  for (let i = 0; i < 4; i++) {
    const node = await (await page.request.post("/api/nodes", { ...H, data: { title: `R05 art ${i} (${stamp})`, markdown: `Body ${i} of ${stamp}.` } })).json();
    await page.request.put(`/api/nodes/${node.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
  }
  const sub = await (await page.request.post("/api/rss/subscribe", { ...H, data: { url: `http://nginx/site/feed.xml?run=${stamp}` } })).json();
  await page.request.post(`/api/rss/sources/${sub.id}/refresh`, { ...H, data: {} });
  const items = async (): Promise<Item[]> => (((await (await page.request.get("/api/rss/items?limit=200")).json()).items ?? []) as Item[]).filter((i) => i.title.includes(`(${stamp})`));
  await expect.poll(async () => (await items()).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
  const its = await items();
  const notesTitled = async (t: string) => ((await (await page.request.get("/api/bootstrap?slim=1")).json()).nodes as Array<{ id: string; title: string }>).filter((n) => n.title === t).length - 1; // minus the published source note
  try {
  // 1) Two devices save the same article simultaneously.
  const devB = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json" });
  const [r1, r2] = await Promise.all([
    page.request.post(`/api/rss/items/${its[0].id}/save`, { ...H, data: { node_id: crypto.randomUUID() } }),
    devB.request.post(`/api/rss/items/${its[0].id}/save`, { ...H, data: { node_id: crypto.randomUUID() } }),
  ]);
  const j1 = await r1.json(), j2 = await r2.json();
  out.race = { status: `${r1.status()}/${r2.status()}`, sameNode: j1.node_id === j2.node_id, notesWithTitle: (await notesTitled(its[0].title)).length };
  await devB.close();
  // 2) Foreign node_id: an unrelated note, and a read-restricted one.
  const other = (await (await page.request.post("/api/nodes", { ...H, data: { title: `Unrelated ${stamp}`, markdown: "my own private thoughts" } })).json()).id as string;
  const rf = await page.request.post(`/api/rss/items/${its[1].id}/save`, { ...H, data: { node_id: other } });
  const after = (await items()).find((i) => i.id === its[1].id);
  out.foreignNodeId = { status: rf.status(), body: (await rf.text()).slice(0, 100), itemSavedTo: after?.saved_node_id === other ? "the unrelated note" : after?.saved_node_id ?? null, unrelatedBody: (await (await page.request.get(`/api/nodes/${other}`)).json()).markdown };
  // 3) Lost response from the reader UI, then retry.
  await ready(page, "/?view=rss"); await page.waitForTimeout(1500);
  await page.locator(".rss-article-row, [class*=article]", { hasText: its[2].title }).first().click().catch(() => {});
  await page.waitForTimeout(1200);
  let lost = false;
  await page.route("**/api/rss/items/*/save", async (r) => { if (lost) return r.continue(); lost = true; await r.fetch(); return r.abort("connectionreset"); });
  const saveBtn = page.getByRole("button", { name: /Save to notes/ }).first();
  out.saveBtn = await saveBtn.count();
  if (await saveBtn.count()) {
    await saveBtn.click(); await page.waitForTimeout(1500);
    out.lostUi = { btn: (await page.getByRole("button", { name: /Save to notes|Saved/ }).first().innerText().catch(() => "")).trim(), toast: (await page.locator(".toast").allInnerTexts()).join(" | ").replace(/\s+/g, " ").slice(-100) };
    if (await saveBtn.isVisible().catch(() => false)) { await saveBtn.click().catch(() => {}); await page.waitForTimeout(1500); }
  }
  await page.unroute("**/api/rss/items/*/save");
  await page.waitForTimeout(3000);
  out.lostResult = { notes: (await notesTitled(its[2].title)).length, item: (await items()).find((i) => i.id === its[2].id)?.saved_node_id ? "saved" : "not saved" };
  // 4) Delete the saved note, then save again.
  const s0 = (await items()).find((i) => i.id === its[0].id)!;
  await page.request.delete(`/api/nodes/${s0.saved_node_id}`, { headers: PAGE });
  const again = await page.request.post(`/api/rss/items/${its[0].id}/save`, { ...H, data: { node_id: crypto.randomUUID() } });
  const aj = await again.json();
  out.saveAfterDelete = { status: again.status(), alreadySaved: aj.already_saved ?? false, sameDeletedNode: aj.node_id === s0.saved_node_id, nodeReadable: (await page.request.get(`/api/nodes/${aj.node_id}`)).status() };
  // 5) Offline save from the UI, then reconnect.
  await ready(page, "/?view=rss"); await page.waitForTimeout(1500);
  await page.locator(".rss-article-row, [class*=article]", { hasText: its[3].title }).first().click().catch(() => {});
  await page.waitForTimeout(1000);
  await context.setOffline(true); await page.waitForTimeout(600);
  await page.getByRole("button", { name: /Save to notes/ }).first().click().catch(() => {});
  await page.waitForTimeout(1500);
  out.offlineUi = { btn: (await page.getByRole("button", { name: /Save to notes|Saved/ }).first().innerText().catch(() => "")).trim(), toast: (await page.locator(".toast").allInnerTexts()).join(" | ").replace(/\s+/g, " ").slice(-100) };
  await context.setOffline(false); await page.waitForTimeout(8000);
  out.offlineReplay = { notes: (await notesTitled(its[3].title)).length, item: (await items()).find((i) => i.id === its[3].id)?.saved_node_id ? "saved" : "not saved" };
  } finally {
    await context.setOffline(false).catch(() => {});
    console.log("RSS05 " + JSON.stringify(out, null, 2));
  }
});
