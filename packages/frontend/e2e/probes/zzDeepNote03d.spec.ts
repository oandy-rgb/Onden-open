// NOTE-03 deepening after the GAP-185 fix (2026-10-09): dependent offline
// writes. Offline: sidebar "+" → Note creates P; quick capture with P focused
// creates child C under P with "@tomorrow" (a due_date attribute on C) and a
// task line in its body. Reconnect: do P, then C (parent_id = P), then C's
// attribute reach the server in order, exactly once, with nothing left queued?
import { test } from "@playwright/test";
import { BASE, ready, openQuickCaptureByHotkey, psql as db, pendingCount, PAGE } from "../fullstack/helpers";


test("NOTE-03d: offline create → child → attribute replay", async ({ page, context }) => {
  test.setTimeout(240_000);
  const out: Record<string, unknown> = {}; const s = Date.now();
  const writes: string[] = []; page.on("request", (r) => { if (["POST", "PUT", "PATCH"].includes(r.method()) && /\/api\/nodes/.test(r.url())) writes.push(`${r.method()} ${r.url().replace(/^https?:\/\/[^/]+/, "").replace(/[0-9a-f-]{36}/g, "<id>")}`); });
  const errs: string[] = []; page.on("pageerror", (e) => errs.push(String(e).slice(0, 120)));
  let parentId = "";
  try {
    await ready(page, "/?view=notes");
    await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(3000);
    await context.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event("offline"))); await page.waitForTimeout(800);
    // P: sidebar + → Note (enabled offline after the fix).
    const plus = page.getByRole("button", { name: "Create new node" }).filter({ visible: true }).first();
    out.plusEnabled = await plus.isEnabled();
    await plus.click();
    out.menuDisabled = await page.locator(".sidebar-sort-menu [role=menuitem]:disabled").count();
    await page.locator(".sidebar-sort-menu [role=menuitem]").filter({ hasText: /^\s*Note\s*$/ }).first().click();
    await page.waitForTimeout(1500);
    parentId = /node=([0-9a-f-]{36})/.exec(page.url())?.[1] ?? "";
    out.parentOpened = { id: !!parentId, editor: await page.locator(".cm-content").count() };
    await page.locator(".cm-content").first().click({ force: true }); await page.keyboard.type(`parent body ${s}`);
    await page.waitForTimeout(2500);
    // C: quick capture under P, with a date and a task line.
    await openQuickCaptureByHotkey(page);
    await page.locator(".quick-capture-textarea").fill(`Child ${s} @tomorrow\n- [ ] task ${s}`);
    await page.locator(".quick-capture-textarea").press("Control+Enter");
    await page.waitForTimeout(2500);
    out.childOpened = { url: page.url().includes("node=") && !page.url().includes(parentId), editor: await page.locator(".cm-content").count() };
    out.pendingOffline = String(await pendingCount(page));
    out.offlineWrites = writes.length;
    await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForTimeout(15_000);
    out.writesAfterOnline = writes;
    const child = db(`select id||'|'||coalesce(parent_id::text,'')||'|'||replace(markdown,E'\\n',' ') from content_nodes where deleted_at is null and title like 'Child ${s}%'`).split("\n").filter(Boolean);
    const childId = child[0]?.split("|")[0] ?? "";
    out.server = {
      parent: db(`select count(*)||' '||replace(markdown,E'\\n',' ') from content_nodes where id='${parentId}' group by markdown`),
      children: child.length, childParentIsP: child[0]?.split("|")[1] === parentId, childBody: child[0]?.split("|")[2],
      dueDate: childId ? db(`select value from node_attributes where node_id='${childId}' and key='due_date'`) : null,
      tasks: db(`select count(*) from content_nodes where deleted_at is null and title like '%task ${s}%'`),
    };
    out.pendingAfter = String(await pendingCount(page));
    out.recovery = await page.locator(".failed-write-recovery").filter({ visible: true }).count();
    out.errors = errs;
  } finally {
    await context.setOffline(false).catch(() => {});
    const ids = db(`select id from content_nodes where title like 'Child ${s}%' or id::text='${parentId || "00000000-0000-0000-0000-000000000000"}' or title like '%task ${s}%'`).split("\n").filter(Boolean);
    for (const id of ids) await page.request.delete(`/api/nodes/${id}`, { headers: PAGE }).catch(() => {});
    console.log("NOTE03D " + JSON.stringify(out, null, 2));
  }
});
