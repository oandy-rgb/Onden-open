// Feature-audit deepening (2026-10-07): HIST-08 — trash: subtree restore via
// UI, offline restore + reconnect, retry, permission view for another human,
// and phone viewport. Slug conflict is covered by undeleteSlugConflict.spec.
import { test, expect, type Page } from "@playwright/test";
import { ready, hideFromOthers, BASE, H } from "./helpers";

const live = async (page: Page, id: string) => (await page.request.get(`/api/nodes/${id}`, H)).status();
async function openTrash(page: Page) {
  await ready(page, "/?view=timeline");
  await page.locator(".tl-tab", { hasText: "Trash" }).filter({ visible: true }).first().click();
}

test("HIST-08: subtree restore, offline restore, retry, permissions, phone", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const mk = async (title: string, parent?: string) => (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: title, ...(parent ? { parent_id: parent } : {}) } })).json()).id as string;
  const root = await mk(`TrashRoot ${stamp}`), c1 = await mk(`TrashC1 ${stamp}`, root), c2 = await mk(`TrashC2 ${stamp}`, root), g = await mk(`TrashG ${stamp}`, c1);
  expect((await page.request.delete(`/api/nodes/${root}`, H)).ok()).toBe(true);
  const out: Record<string, string> = { afterDelete: [root, c1, c2, g].map((x) => 0).join("") };
  out.afterDelete = JSON.stringify(await Promise.all([root, c1, c2, g].map((x) => live(page, x))));

  await openTrash(page);
  const row = page.locator(".tl-item", { hasText: `TrashRoot ${stamp}` });
  await expect(row).toBeVisible();
  out.trashListsChildren = String(await page.locator(".tl-item", { hasText: `TrashC1 ${stamp}` }).count());
  await row.locator(".tl-restore-btn").click();
  await expect(row).toHaveCount(0, { timeout: 15_000 });
  out.afterUiRestore = JSON.stringify(await Promise.all([root, c1, c2, g].map((x) => live(page, x))));
  const parentOfG = (await (await page.request.get(`/api/nodes/${g}`, H)).json()).parent_id;
  out.structureKept = String(parentOfG === c1);
  out.retry = String((await page.request.post(`/api/nodes/${root}/undelete`, H)).status());

  // Offline restore through the UI, then reconnect.
  const solo = await mk(`TrashSolo ${stamp}`);
  await page.request.delete(`/api/nodes/${solo}`, H);
  await openTrash(page);
  const soloRow = page.locator(".tl-item", { hasText: `TrashSolo ${stamp}` });
  await expect(soloRow).toBeVisible();
  await page.context().setOffline(true);
  const btn = soloRow.locator(".tl-restore-btn");
  out.offlineButtonDisabled = String(await btn.isDisabled());
  if (!(await btn.isDisabled())) await btn.click();
  await page.waitForTimeout(1500);
  const offlineNotice = (await page.locator(".toast, [role='alert'], [role='status']").allInnerTexts()).slice(-2);
  await page.context().setOffline(false);
  await page.waitForTimeout(6000);
  out.offline = `notice=${JSON.stringify(offlineNotice)} serverAfterReconnect=${await live(page, solo)}`;

  // Another human (editor) must not see or restore a trashed note in a space
  // they are not in.
  const secret = await mk(`TrashSecret ${stamp}`);
  await hideFromOthers(page.request, secret);
  await page.request.delete(`/api/nodes/${secret}`, H);
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const su = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `H08 ${stamp}`, email: `h08-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  await page.request.post("/api/actors", { ...H, data: { name: `H08 ${stamp}`, type: "human", external_id: su.user.id } });
  const trashList = await (await human.request.get("/api/nodes/trash", H)).text();
  out.editorTrashLeak = String(trashList.includes(`TrashSecret ${stamp}`));
  out.editorUndeleteSecret = String((await human.request.post(`/api/nodes/${secret}/undelete`, H)).status());
  out.secretStillTrashed = String(await live(page, secret));
  await human.close();

  // Phone viewport.
  const solo2 = await mk(`TrashPhone ${stamp}`);
  await page.request.delete(`/api/nodes/${solo2}`, H);
  const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const pp = await phone.newPage();
  await openTrash(pp).catch((e) => { out.phoneOpen = String(e).slice(0, 100); });
  const prow = pp.locator(".tl-item-wrap", { hasText: `TrashPhone ${stamp}` }).filter({ visible: true }).first();
  const visible = await prow.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
  const box = visible ? await prow.locator(".tl-restore-btn").boundingBox() : null;
  if (visible) await prow.locator(".tl-restore-btn").click();
  await pp.waitForTimeout(2000);
  out.phone = `row=${visible} btn=${box ? `${Math.round(box.width)}x${Math.round(box.height)}` : "none"} restored=${await live(page, solo2)} docWidth=${await pp.evaluate(() => document.documentElement.scrollWidth)}`;
  await pp.screenshot({ path: "/tmp/pw-output/hist08-phone.png" });
  await phone.close();
  console.log(`AUDIT HIST-08 ${JSON.stringify(out)}`);
});
