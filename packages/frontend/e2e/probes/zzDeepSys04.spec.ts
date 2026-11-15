// Feature-audit deepening (2026-10-09, tick 29): SYS-04 — the server committed,
// the response was lost, and the user reloads at once (no in-page retry).
// A. quick capture: POST committed, response reset → reload after 300 ms →
//    exactly one note, no stuck pending / duplicate recovery.
// B. editor save: PATCH committed, response reset → reload after 300 ms →
//    text kept once (not doubled), no conflict copy, no stuck pending.
import { test, type Page } from "@playwright/test";
import { ready, openQuickCapture, H, psql as db, pendingCount } from "../fullstack/helpers";

async function settle(p: Page) {
  await p.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  await p.waitForTimeout(6000);
}
const pending = async (p: Page) => String(await pendingCount(p));
const recovery = async (p: Page) => (await p.locator(".failed-write-recovery").filter({ visible: true }).allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, " ").slice(0, 200));

test("SYS-04: committed write, lost response, immediate reload", async ({ page }) => {
  test.setTimeout(300_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  const parent = await (await req.post("/api/nodes", { ...H, data: { title: `S04 parent ${s}`, markdown: "p" } })).json();
  const target = await (await req.post("/api/nodes", { ...H, data: { title: `S04 edit ${s}`, markdown: "start" } })).json();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    // ── A ──
    await ready(page, `/?view=notes&node=${parent.id}`); await settle(page);
    let droppedA = 0;
    await page.route("**/api/nodes", async (r) => {
      if (r.request().method() === "POST" && (r.request().postData() ?? "").includes(`S04cap ${s}`) && droppedA === 0) { droppedA++; await r.fetch().catch(() => null); return r.abort("connectionreset"); }
      return r.continue();
    });
    await openQuickCapture(page);
    await page.locator(".quick-capture-textarea").fill(`S04cap ${s}`);
    await page.locator(".quick-capture-save").click();
    await page.waitForTimeout(300);
    out.A_beforeReload = { dropped: droppedA, server: db(`select count(*) from content_nodes where title='S04cap ${s}' and deleted_at is null`), overlayOpen: await page.locator(".quick-capture-overlay").count() };
    await page.unroute("**/api/nodes");
    await page.reload(); await settle(page);
    out.A_afterReload = { server: db(`select count(*) from content_nodes where title='S04cap ${s}' and deleted_at is null`), pending: await pending(page), recovery: await recovery(page), listed: await page.getByText(`S04cap ${s}`, { exact: true }).count() };

    // ── B ──
    await ready(page, `/?view=notes&node=${target.id}`); await settle(page);
    let droppedB = 0;
    await page.route(`**/api/nodes/${target.id}`, async (r) => {
      if (r.request().method() === "PATCH" && (r.request().postData() ?? "").includes(`lost-${s}`) && droppedB === 0) { droppedB++; await r.fetch().catch(() => null); return r.abort("connectionreset"); }
      return r.continue();
    });
    await page.locator(".cm-content").click({ force: true });
    await page.keyboard.press("Control+End"); await page.keyboard.type(` lost-${s}`);
    // Wait for the debounced save to fire (and be dropped), then reload quickly.
    for (let i = 0; i < 40 && droppedB === 0; i++) await page.waitForTimeout(250);
    await page.waitForTimeout(300);
    out.B_beforeReload = { dropped: droppedB, server: db(`select (length(markdown) - length(replace(markdown, 'lost-${s}', ''))) / length('lost-${s}') from content_nodes where id='${target.id}'`) };
    await page.unroute(`**/api/nodes/${target.id}`);
    await page.reload(); await settle(page);
    out.B_afterReload = {
      occurrencesOnServer: db(`select (length(markdown) - length(replace(markdown, 'lost-${s}', ''))) / length('lost-${s}') from content_nodes where id='${target.id}'`),
      editorOccurrences: ((await page.locator(".cm-content").innerText().catch(() => "")).match(new RegExp(`lost-${s}`, "g")) ?? []).length,
      pending: await pending(page), recovery: await recovery(page),
      conflictCopies: db(`select count(*) from content_nodes where title like 'S04 edit ${s}%' and id <> '${target.id}' and deleted_at is null`),
      patchEvents: db(`select count(*) from domain_events where target_id='${target.id}' and event_type='NODE_UPDATED'`),
    };
  } finally {
    for (const id of db(`select id from content_nodes where title like 'S04%${s}%'`).split("\n").filter(Boolean)) await req.delete(`/api/nodes/${id}`, H).catch(() => {});
    console.log("SYS04 " + JSON.stringify(out, null, 2));
  }
});
