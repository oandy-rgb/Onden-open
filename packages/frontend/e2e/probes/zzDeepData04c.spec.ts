// Feature-audit deepening (2026-10-09, tick 53, after the GAP-264 fix): DATA-04.
// A. Cancel: choose a backup file, press Cancel in the confirm → are the
//    Download / Restore buttons usable again, and does choosing the same file
//    again reopen the confirm?
// B. Two tabs: both open the same note and load Settings online (GAP-263), go
//    offline; tab 2 queues edit X; tab 1 restores an older backup (v1 only) →
//    reconnect: does X still reach the server exactly once, does tab 1 keep the
//    restored snapshot, any page errors?
import { test, type Page, type BrowserContext } from "@playwright/test";
import { ready, showAdvancedSettings, BASE, H, pendingCount } from "../fullstack/helpers";

async function off(c: BrowserContext, ps: Page[], v: boolean) { await c.setOffline(v); for (const p of ps) await p.evaluate((x) => window.dispatchEvent(new Event(x ? "offline" : "online")), v).catch(() => {}); }
async function append(p: Page, text: string) { await p.locator(".cm-content").first().click({ force: true }); await p.keyboard.press("Control+End"); await p.keyboard.type(text); }
async function openData(p: Page) {
  await p.locator("button[title*=Settings i], button[aria-label*=Settings i]").filter({ visible: true }).first().click(); await p.waitForTimeout(600);
  await p.getByRole("button", { name: /^Your Data$/ }).first().click(); await p.waitForTimeout(600);
  await showAdvancedSettings(p);
}
async function closeSettings(p: Page) {
  await p.locator(".settings-overlay").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await p.keyboard.press("Escape").catch(() => {}); await p.waitForTimeout(600);
  if (await p.locator(".settings-overlay").isVisible().catch(() => false)) await p.locator(".settings-overlay button").filter({ has: p.locator("svg") }).first().click().catch(() => {});
  await p.waitForTimeout(500);
  return !(await p.locator(".settings-overlay").isVisible().catch(() => false));
}
const pending = (p: Page) => pendingCount(p).then(String);
const buttons = async (p: Page) => ({
  download: await p.getByRole("group", { name: "Download this device's copy" }).getByRole("button").isEnabled().catch(() => null),
  restore: await p.getByRole("group", { name: "Restore this device's copy" }).getByRole("button").isEnabled().catch(() => null),
  importing: await p.getByText(/Importing…/).count(),
});

test("DATA-04: cancel restore and two-tab restore", async ({ page, context }) => {
  test.setTimeout(400_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  const note = await (await req.post("/api/nodes", { ...H, data: { title: `D04c ${s}`, markdown: `v1-${s}` } })).json();
  const md = async () => (await (await req.get(`/api/nodes/${note.id}`)).json()).markdown as string;
  const backupPath = test.info().outputPath("backup.sqlite3");
  const errs: string[] = [];
  try {
    await ready(page, `/?view=notes&node=${note.id}`);
    await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(3000);
    page.on("pageerror", (e) => errs.push(`t1 ${String(e).slice(0, 120)}`));
    // A. Cancel.
    await openData(page);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("group", { name: "Download this device's copy" }).getByRole("button").click()]);
    await dl.saveAs(backupPath);
    await page.locator("input[accept='.sqlite3,.sqlite,.db']").setInputFiles(backupPath); await page.waitForTimeout(1000);
    out.A_duringConfirm = await buttons(page);
    await page.getByRole("button", { name: /^Cancel$/ }).filter({ visible: true }).last().click();
    await page.waitForTimeout(1000);
    out.A_afterCancel = { ...(await buttons(page)), confirmOpen: await page.getByRole("button", { name: /Overwrite & import/ }).count(), url: page.url().includes(note.id) };
    await page.locator("input[accept='.sqlite3,.sqlite,.db']").setInputFiles(backupPath); await page.waitForTimeout(1000);
    out.A_sameFileAgainOpensConfirm = await page.getByRole("button", { name: /Overwrite & import/ }).count();
    await page.getByRole("button", { name: /^Cancel$/ }).filter({ visible: true }).last().click().catch(() => {});
    await closeSettings(page);

    // B. Two tabs.
    const t2 = await context.newPage();
    t2.on("pageerror", (e) => errs.push(`t2 ${String(e).slice(0, 120)}`));
    const t2patches: string[] = []; t2.on("request", (r) => { if (r.method() === "PATCH" && r.url().includes(note.id)) t2patches.push((r.postData() ?? "").slice(0, 60)); });
    const t1patches: string[] = []; page.on("request", (r) => { if (r.method() === "PATCH" && r.url().includes(note.id)) t1patches.push((r.postData() ?? "").slice(0, 60)); });
    await t2.goto(`${BASE}/?view=notes&node=${note.id}`);
    await t2.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await t2.waitForTimeout(3000);
    await openData(t2); await closeSettings(t2);
    await off(context, [page, t2], true);
    await append(t2, ` X-${s}`); await t2.waitForTimeout(4000);
    out.B_t2PendingBefore = await pending(t2);
    await page.bringToFront();
    await openData(page);
    await page.locator("input[accept='.sqlite3,.sqlite,.db']").setInputFiles(backupPath); await page.waitForTimeout(1000);
    await page.getByRole("button", { name: /Overwrite & import/ }).click({ timeout: 5000 }).catch((e) => { out.B_overwriteErr = String(e).slice(0, 80); });
    await page.waitForTimeout(6000);
    out.B_t2PendingAfterRestore = await pending(t2);
    await off(context, [page, t2], false);
    for (const p of [page, t2]) await p.getByRole("button", { name: /Retry connection/i }).click().catch(() => {});
    await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
    await t2.bringToFront(); await t2.getByRole("button", { name: /Sync now/i }).filter({ visible: true }).first().click().catch(() => {});
    await page.waitForTimeout(10_000);
    const m = await md();
    out.B_server = { hasX: m.includes(`X-${s}`), occurrencesX: m.split(`X-${s}`).length - 1, t1patches: t1patches.length, t2patches: t2patches.length, pendingT1: await pending(page), pendingT2: await pending(t2), markdown: m.slice(-60) };
    // Close tab 2, reload tab 1: still a working workspace, X present?
    await t2.close();
    await page.reload(); await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(5000);
    out.B_t1AfterReload = { editor: (await page.locator(".cm-content").first().innerText().catch(() => "")).slice(-60), pending: await pending(page), recovery: await page.locator(".failed-write-recovery").filter({ visible: true }).count() };
    out.errors = errs;
  } finally {
    await context.setOffline(false).catch(() => {});
    await req.delete(`/api/nodes/${note.id}`, H).catch(() => {});
    console.log("DATA04C " + JSON.stringify(out, null, 2));
  }
});
