// Feature-audit deepening (2026-10-07): HIST-04 — restore a version on the
// phone (the note header's 「Version history」 → version window → Restore),
// and two notes restored concurrently from two tabs. The phone's Info tab and
// its recent-version list are gone: a note's page has no Info tab (91a0e24d)
// and history opens from the header (c38ff179).
import { test, expect, type Page } from "@playwright/test";
import { ready, BASE, H } from "./helpers";

async function twoVersions(page: Page, title: string) {
  const n = await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: `ORIGINAL ${title}` } })).json();
  await page.waitForTimeout(1100);
  await page.request.patch(`/api/nodes/${n.id}`, { ...H, data: { markdown: `EDITED ${title}` } });
  return n.id as string;
}
async function restoreOldest(page: Page) {
  await page.locator(".note-history-link").filter({ visible: true }).first().click();
  await expect(page.locator(".nh")).toBeVisible();
  // The "all versions" sheet is a button on a phone, always showing beside the note on desktop.
  const sheet = page.locator(".nh-all-btn");
  if (await sheet.isVisible()) await sheet.click();
  await page.locator(".nh-versions .nh-row").last().click();
  await page.locator(".nh-actions .ui-btn--primary").click();
  await expect(page.locator(".nh-notice")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /^(Back|返回)$/ }).click();
  await expect(page.locator(".nh")).toHaveCount(0);
}

test("HIST-04: phone restore", async ({ browser, page: base }) => {
  const s = Date.now();
  const id = await twoVersions(base, `PhoneRestore ${s}`);
  const ctx = await browser.newContext({ storageState: await base.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const page = await ctx.newPage();
  await ready(page, `/?view=notes&node=${id}`);
  const open = page.locator(".note-history-link").filter({ visible: true }).first();
  await expect(open).toBeVisible();
  const openBox = await open.boundingBox();
  await restoreOldest(page);
  await page.getByText("Content", { exact: true }).filter({ visible: true }).first().click().catch(() => {});
  await page.waitForTimeout(1000);
  const editor = await page.locator(".cm-content").filter({ visible: true }).first().innerText().catch(() => "");
  expect(editor).toContain("ORIGINAL");
  await expect.poll(async () => (await (await page.request.get(`/api/nodes/${id}`, H)).json()).markdown).toContain("ORIGINAL");
  const server = (await (await page.request.get(`/api/nodes/${id}`, H)).json()).markdown;
  console.log(`AUDIT HIST-04 phone ${JSON.stringify({ openBtn: openBox ? `${Math.round(openBox.width)}x${Math.round(openBox.height)}` : "none", editor: editor.slice(0, 40), server: String(server).slice(0, 40), docWidth: await page.evaluate(() => document.documentElement.scrollWidth) })}`);
  await page.screenshot({ path: "/tmp/pw-output/hist04-phone.png" });
  await ctx.close();
});

test("HIST-04: two notes restored concurrently from two tabs", async ({ page }) => {
  const s = Date.now();
  const a = await twoVersions(page, `ConA ${s}`), b = await twoVersions(page, `ConB ${s}`);
  const p2 = await page.context().newPage();
  await ready(page, `/?view=notes&node=${a}`);
  await ready(p2, `/?view=notes&node=${b}`);
  await Promise.all([restoreOldest(page), restoreOldest(p2)]);
  await page.waitForTimeout(1500);
  const get = async (id: string) => (await (await page.request.get(`/api/nodes/${id}`, H)).json()).markdown as string;
  const versions = async (id: string) => (await (await page.request.get(`/api/nodes/${id}/versions`, H)).json()).length as number;
  const ea = await page.locator(".cm-content").first().innerText(), eb = await p2.locator(".cm-content").first().innerText();
  // Restore is a new version on top of the old ones: the old text is back, nothing in the history is lost.
  expect(await get(a)).toContain("ORIGINAL");
  expect(await get(b)).toContain("ORIGINAL");
  expect(await versions(a)).toBeGreaterThanOrEqual(3);
  expect(await versions(b)).toBeGreaterThanOrEqual(3);
  console.log(`AUDIT HIST-04 concurrent ${JSON.stringify({ serverA: await get(a), serverB: await get(b), editorA: ea.slice(0, 30), editorB: eb.slice(0, 30), versionsA: await versions(a), versionsB: await versions(b) })}`);
  // Same note, two tabs: both restore the oldest at once.
  const c = await twoVersions(page, `Same ${s}`);
  await ready(page, `/?view=notes&node=${c}`); await ready(p2, `/?view=notes&node=${c}`);
  const r = await Promise.allSettled([restoreOldest(page), restoreOldest(p2)]);
  await page.waitForTimeout(1500);
  const notices = [...await page.locator(".toast, [role='alert']").allInnerTexts(), ...await p2.locator(".toast, [role='alert']").allInnerTexts()].map((x) => x.replace(/\s+/g, " ").slice(0, 60));
  expect(r.map((x) => x.status)).toEqual(["fulfilled", "fulfilled"]);
  expect(await get(c)).toContain("ORIGINAL");
  console.log(`AUDIT HIST-04 sameNote ${JSON.stringify({ settled: r.map((x) => x.status), server: (await get(c)).slice(0, 40), versions: await versions(c), notices: notices.slice(0, 4) })}`);
});
