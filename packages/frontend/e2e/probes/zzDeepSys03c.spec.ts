// Feature-audit deepening (2026-10-09, tick 22): SYS-03 — offline parent change
// and multi-tab queues.
// D. offline: move X from P1 to P2 (inspector Parent select) → reconnect → server parent P2.
// E. offline: move Y to P3 and edit Y's body; meanwhile another device deletes P3
//    → replay: move refused, body edit still lands, user told, nothing half-applied.
// F. two tabs, same browser profile, both offline: tab1 edits N1, tab2 edits N2;
//    close tab1 before reconnect; tab2 reconnects → do tab1's queued writes drain?
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { ready, H, psql as db, pendingCount } from "../fullstack/helpers";


async function off(context: BrowserContext, pages: Page[]) { await context.setOffline(true); for (const p of pages) await p.evaluate(() => window.dispatchEvent(new Event("offline"))).catch(() => {}); }
async function on(context: BrowserContext, pages: Page[]) { await context.setOffline(false); for (const p of pages) await p.evaluate(() => window.dispatchEvent(new Event("online"))).catch(() => {}); }
async function open(page: Page, id: string) {
  await ready(page, `/?view=notes&node=${id}`);
  await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  await page.waitForTimeout(2500);
  for (const b of await page.locator(".fwr-dismiss").filter({ visible: true }).all()) await b.click().catch(() => {});
}
async function setParent(page: Page, parentId: string) {
  const sel = page.locator(".ov-prop-row").filter({ hasText: /^Parent/ }).locator("select").filter({ visible: true }).first();
  await sel.focus(); await page.waitForTimeout(300);
  await sel.selectOption(parentId);
}
async function typeEnd(page: Page, text: string) {
  await page.locator(".cm-content").click({ force: true });
  await page.keyboard.press("Control+End"); await page.keyboard.type(text);
}
const pending = async (page: Page) => String(await pendingCount(page));
const recovery = async (page: Page) => (await page.locator(".failed-write-recovery").filter({ visible: true }).allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, " ").slice(0, 300));
const parentOf = (id: string) => db(`select coalesce(p.title,'none') from content_nodes n left join content_nodes p on p.id=n.parent_id where n.id='${id}'`);

test("SYS-03: offline move, deleted target parent, multi-tab queue", async ({ page, context }) => {
  test.setTimeout(400_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  const mk = async (title: string, parent_id?: string) => (await (await req.post("/api/nodes", { ...H, data: { title, markdown: `${title} body`, parent_id } })).json()) as { id: string };
  const P1 = await mk(`S03 P1 ${s}`); const P2 = await mk(`S03 P2 ${s}`); const P3 = await mk(`S03 P3 ${s}`);
  const X = await mk(`S03 X ${s}`, P1.id); const Y = await mk(`S03 Y ${s}`, P1.id);
  const N1 = await mk(`S03 N1 ${s}`); const N2 = await mk(`S03 N2 ${s}`);
  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    // ── D ──
    await open(page, X.id);
    await off(context, [page]);
    await setParent(page, P2.id); await page.waitForTimeout(2000);
    out.D_pendingOffline = await pending(page);
    await on(context, [page]); await page.waitForTimeout(8000);
    out.D = { pending: await pending(page), serverParent: parentOf(X.id), recovery: await recovery(page) };

    // ── E ──
    await open(page, Y.id);
    await off(context, [page]);
    await setParent(page, P3.id); await page.waitForTimeout(800);
    await typeEnd(page, ` offline-edit-${s}`); await page.waitForTimeout(2500);
    out.E_pendingOffline = await pending(page);
    out.E_deleteP3 = (await req.delete(`/api/nodes/${P3.id}`, H)).status();
    await on(context, [page]); await page.waitForTimeout(10_000);
    out.E = {
      pending: await pending(page), recovery: await recovery(page), toasts: await page.locator(".toast-message").allInnerTexts(),
      serverParent: parentOf(Y.id), bodyLanded: db(`select position('offline-edit-${s}' in markdown) > 0 from content_nodes where id='${Y.id}'`),
      clientParentShown: await page.locator(".ov-prop-row").filter({ hasText: /^Parent/ }).locator("select").filter({ visible: true }).first().evaluate((e) => (e as HTMLSelectElement).selectedOptions[0]?.textContent ?? null).catch(() => null),
    };

    // ── F ──
    const tab1 = await context.newPage(); await tab1.setViewportSize({ width: 1280, height: 800 });
    await open(tab1, N1.id);
    await open(page, N2.id);
    await off(context, [page, tab1]);
    await typeEnd(tab1, ` tab1-edit-${s}`); await tab1.waitForTimeout(2500);
    await typeEnd(page, ` tab2-edit-${s}`); await page.waitForTimeout(2500);
    out.F_pendingOffline = { tab1: await pending(tab1), tab2: await pending(page) };
    await tab1.close();
    await page.waitForTimeout(1000);
    await on(context, [page]); await page.waitForTimeout(12_000);
    out.F_afterTab1Closed = {
      tab2Pending: await pending(page),
      n1Landed: db(`select position('tab1-edit-${s}' in markdown) > 0 from content_nodes where id='${N1.id}'`),
      n2Landed: db(`select position('tab2-edit-${s}' in markdown) > 0 from content_nodes where id='${N2.id}'`),
    };
    await page.reload(); await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(8000);
    out.F_afterReload = {
      pending: await pending(page), recovery: await recovery(page),
      n1Landed: db(`select position('tab1-edit-${s}' in markdown) > 0 from content_nodes where id='${N1.id}'`),
      n1Events: db(`select count(*) from domain_events where target_id='${N1.id}' and event_type='NODE_UPDATED'`),
    };
  } finally {
    for (const n of [X, Y, N1, N2, P1, P2, P3]) await req.delete(`/api/nodes/${n.id}`, H).catch(() => {});
    console.log("SYS03C " + JSON.stringify(out, null, 2));
  }
});
