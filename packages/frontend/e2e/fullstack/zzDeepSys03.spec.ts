// Feature-audit deepening (2026-10-09, tick 21): SYS-03 — offline queue replay
// with dependent writes.
// A. offline: capture A and B, then edit A's body (PATCH depends on A's POST).
//    On replay A's POST is refused (403): what happens to A's PATCH, does B
//    still land (failure isolation), what does the user see?
// B. offline capture C; on replay the POST commits but the response is lost →
//    same-key retry → exactly one C on the server.
// C. offline body edit of an existing note; on replay PATCH gets 401 (session
//    expired): the write must stay pending (not "rejected"), then drain.
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { ready, openQuickCapture, saveQuickCapture, ensureInbox, BASE, H, expectOffline, expectPending, pendingCount } from "./helpers";
// Rewritten 2026-11-18 for the current flows: a quick capture lands in the inbox and the box stays open after saving
// (docs/decisions/quick-capture-inbox.md; helpers saveQuickCapture), the server is read through the API (no database access, so it also runs on the
// cloud stack), and the written rules are the offline queue's (docs/agents/decisions-offline-account.md: a refused write keeps its input in the recovery
// panel and is not counted as waiting; a write for another target still goes out; a 401 keeps the write waiting and it goes out on the next sync).

async function goOffline(page: Page, context: BrowserContext) {
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expectOffline(page);
}
async function goOnline(page: Page, context: BrowserContext) {
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
}
async function capture(page: Page, text: string) {
  await openQuickCapture(page);
  await page.locator(".quick-capture-textarea").fill(text);
  await saveQuickCapture(page); // the box stays open for the next thought since 2026-10-29: this waits for 「Saved」, then closes it
}
const recovery = (page: Page) => page.locator(".failed-write-recovery").filter({ visible: true });
const liveNodes = async (page: Page, prefix: string) => ((await (await page.request.get("/api/bootstrap?bodies=none", H)).json()).nodes as Array<{ id: string; title: string; parent_id?: string | null; deleted_at?: string | null }>).filter((n) => !n.deleted_at && n.title.startsWith(prefix));
const countOf = async (page: Page, prefix: string) => (await liveNodes(page, prefix)).length;
const bodyOf = async (page: Page, id: string) => ((await (await page.request.get(`/api/nodes/${id}`, H)).json()).markdown as string);
const openInboxTab = (page: Page) => page.locator(".obsidian-sidebar .sidebar-tab").filter({ hasText: /^(Inbox|收件匣)/ }).filter({ visible: true }).first().click();
const inboxRow = (page: Page, text: string) => page.locator(".capture-inbox-text", { hasText: text });
/** Remove every recovery copy (the person's "Remove recovery copy" on each card), so the next part starts with an empty panel. */
const clearRecovery = async (page: Page) => {
  const collapsed = page.getByRole("button", { name: /^Recovery inputs/ });
  if (await collapsed.isVisible().catch(() => false)) await collapsed.click();
  // One card at a time: wait for each to go before pressing the next (a card being removed has its button disabled).
  for (let left = await page.locator(".fwr-dismiss").count(); left > 0; left = await page.locator(".fwr-dismiss").count()) {
    await page.locator(".fwr-dismiss").first().click();
    await expect(page.locator(".fwr-dismiss")).toHaveCount(left - 1);
  }
  await expect(page.locator(".failed-write-recovery")).toHaveCount(0);
};
const settle = async (page: Page) => { await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); };

test("SYS-03: dependent replay, refused create, lost response, 401", async ({ page, context }) => {
  test.setTimeout(400_000);
  const s = Date.now();
  const reqLog: string[] = [];
  page.on("response", (r) => { const u = r.url(); if (u.includes("/api/nodes") && r.request().method() !== "GET") reqLog.push(`${r.request().method()} ${u.replace(BASE, "").slice(0, 60)} → ${r.status()}`); });
  page.on("requestfailed", (r) => { if (r.url().includes("/api/nodes")) reqLog.push(`${r.method()} ${r.url().replace(BASE, "").slice(0, 60)} ✗ ${r.failure()?.errorText}`); });
  try {
  await page.setViewportSize({ width: 1280, height: 800 });
  await ensureInbox(page); // an offline capture needs the inbox's tag to exist already (helpers ensureInbox)
  await ready(page, "/?view=notes");
  await settle(page);
  await page.waitForTimeout(2000); // the lazily loaded capture box has to be in before the network goes (the offline cold-start limit, decisions-offline-account.md)

  // ── A ── offline: capture A and B, then edit A's body (a PATCH that depends on A's create).
  await goOffline(page, context);
  await capture(page, `S03A ${s}`);
  await capture(page, `S03B ${s}`);
  await openInboxTab(page);
  await inboxRow(page, `S03A ${s}`).click();
  await expect(page.locator(".cm-content")).toContainText(`S03A ${s}`);
  await expect(page.locator(".obsidian-title-input"), "A is the open note").toHaveValue(`S03A ${s}`);
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(` dependent-edit-${s}`);
  // Three writes wait: A's create, B's create, A's edit.
  await expect.poll(() => pendingCount(page), { timeout: 15_000 }).toBe(3);
  await page.route("**/api/nodes", async (r) => {
    if (r.request().method() === "POST" && (r.request().postData() ?? "").includes(`S03A ${s}`)) return r.fulfill({ status: 403, contentType: "application/json", body: "{\"error\":\"forbidden\"}" });
    return r.continue();
  });
  reqLog.length = 0;
  await goOnline(page, context);
  // A's create is refused, B's goes out regardless (a refusal does not stop the other targets), and A's edit has no note to land on.
  await expect.poll(() => countOf(page, `S03B ${s}`), { timeout: 60_000 }).toBe(1);
  await expect(recovery(page), "both refused inputs are kept for the person").toContainText(`dependent-edit-${s}`, { timeout: 60_000 });
  await expect(page.locator(".toast").filter({ hasText: "A queued change was rejected. Its input is available in recovery." }).first()).toBeVisible();
  const panel = (await recovery(page).allInnerTexts()).join(" ").replace(/\s+/g, " ");
  expect(panel, "the refused create says why, in words").toContain("You don't have permission to do that.");
  expect(panel, "and keeps its text").toContain(`S03A ${s}`);
  expect(panel, "the edit that had no note to land on says so (lib/serverSentences.ts: node not found)").toContain("node not found");
  expect(panel, "and keeps what was typed").toContain(`dependent-edit-${s}`);
  expect(reqLog, "A's create was refused").toContain("POST /api/nodes → 403");
  expect(reqLog.some((l) => l.startsWith("POST /api/nodes → 20")), "B's create was accepted").toBe(true);
  expect(await countOf(page, `S03A ${s}`), "A never reached the server").toBe(0);
  await expect.poll(() => pendingCount(page), { message: "a refused write is not counted as waiting (decisions-offline-account.md, batch 16)" }).toBe(0);
  await page.unroute("**/api/nodes");
  // A refused create does not stay readable: its row is gone from the inbox (batch 16: the recovery copy is no readable note).
  await openInboxTab(page);
  await expect(inboxRow(page, `S03A ${s}`)).toHaveCount(0);
  await page.reload(); await settle(page);
  await expect(recovery(page), "the refused inputs survive a reload").toContainText(`S03A ${s}`);
  await expect.poll(() => pendingCount(page)).toBe(0);
  await openInboxTab(page);
  await expect(inboxRow(page, `S03A ${s}`)).toHaveCount(0);
  expect(await countOf(page, `S03A ${s}`)).toBe(0);

  // ── B ── offline capture C; on replay the create commits but its response is lost: the same-key retry leaves exactly one C
  // (AGENTS.md 錯誤與保存: a lost response is retried with the original idempotency key). A capture has no parent: it goes to the inbox.
  await clearRecovery(page);
  const parentP = await (await page.request.post("/api/nodes", { ...H, data: { title: `S03P ${s}`, markdown: "parent" } })).json();
  await ready(page, `/?view=notes&node=${parentP.id}`);
  await settle(page);
  await page.waitForTimeout(2500); // see the offline cold-start note above
  await goOffline(page, context);
  await capture(page, `S03C ${s}`);
  let dropped = 0;
  await page.route("**/api/nodes", async (r) => {
    if (r.request().method() === "POST" && (r.request().postData() ?? "").includes(`S03C ${s}`) && dropped === 0) {
      dropped++; await r.fetch().catch(() => null); return r.abort("connectionreset");
    }
    return r.continue();
  });
  reqLog.length = 0;
  await goOnline(page, context);
  await expect.poll(() => countOf(page, `S03C ${s}`), { timeout: 60_000 }).toBe(1);
  await expect.poll(() => pendingCount(page), { timeout: 60_000 }).toBe(0);
  await page.unroute("**/api/nodes");
  expect(dropped, "the first send reached the server and lost its reply").toBe(1);
  await expect.poll(() => reqLog.filter((l) => l.startsWith("POST")).length, { message: "one lost send and one retry, no more" }).toBe(2);
  expect(reqLog[0]).toContain("ERR_CONNECTION_RESET");
  const cNodes = await liveNodes(page, `S03C ${s}`);
  expect(cNodes, "exactly one C on the server").toHaveLength(1);
  expect(cNodes[0].parent_id ?? null, "a capture is no child of the open note (docs/decisions/quick-capture-inbox.md)").toBeNull();
  await expect(recovery(page), "nothing was refused").toHaveCount(0);

  // ── C ── offline body edit of an existing note; on replay the PATCH gets 401 (session expired): the write stays waiting (it is not rejected, it
  // has no recovery copy), the person is asked to sign in, and it goes out on the next sync (decisions-offline-account.md; writeErrors.ts: a 401
  // can recover after login; writeQueue.ts schedules no timed retry for it, so the next trigger is a sync, e.g. the person's "Sync now").
  const existing = await (await page.request.post("/api/nodes", { ...H, data: { title: `S03E ${s}`, markdown: "start" } })).json();
  await ready(page, `/?view=notes&node=${existing.id}`);
  await settle(page);
  await page.waitForTimeout(2500); // see the offline cold-start note above
  await goOffline(page, context);
  await page.locator(".cm-content").click({ force: true });
  await page.keyboard.press("Control+End");
  await page.keyboard.type(` offline-401-${s}`);
  await expectPending(page);
  await page.route(`**/api/nodes/${existing.id}`, (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 401, contentType: "application/json", body: "{\"error\":\"unauthorized\"}" }) : r.continue());
  reqLog.length = 0;
  await goOnline(page, context);
  await expect(page.locator(".toast").filter({ hasText: "Sign in again, then retry syncing or saving." }).first()).toBeVisible({ timeout: 30_000 });
  expect(reqLog.some((l) => l.includes(`PATCH /api/nodes/${existing.id}`) && l.endsWith("→ 401"))).toBe(true);
  expect(await pendingCount(page), "the edit still waits").toBe(1);
  await expect(recovery(page), "a 401 is not a refusal: no recovery copy").toHaveCount(0);
  expect(await bodyOf(page, existing.id), "and the server has not got it").not.toContain(`offline-401-${s}`);
  await page.unroute(`**/api/nodes/${existing.id}`);
  // The next sync: the person's "Sync now" in the account dialog. Another sync trigger may get there first, so it is pressed only while the edit still waits.
  await page.locator(".user-chip").first().click();
  if (await page.locator(".sync-status--btn").filter({ hasText: "Sync now" }).count() > 0) {
    // The status row is redrawn while a failure is being reported, so Playwright never finds it still enough to click: press it in the page.
    await page.evaluate(() => { [...document.querySelectorAll<HTMLElement>(".sync-status--btn")].find((el) => el.getBoundingClientRect().width > 0)?.click(); });
  }
  await expect.poll(async () => bodyOf(page, existing.id), { timeout: 30_000 }).toContain(`offline-401-${s}`);
  await expect.poll(() => pendingCount(page), { timeout: 30_000 }).toBe(0);
  await expect(recovery(page)).toHaveCount(0);
  } finally {
  // cleanup
  for (const t of ["S03A", "S03B", "S03C", "S03E", "S03P"]) for (const n of await liveNodes(page, `${t} ${s}`)) await page.request.delete(`/api/nodes/${n.id}`, H).catch(() => {});
  }
});
