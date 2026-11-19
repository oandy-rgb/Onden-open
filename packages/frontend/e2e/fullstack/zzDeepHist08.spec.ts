// Feature-audit deepening (2026-10-07), rewritten 2026-11-17: HIST-08 — bringing a deleted note back.
// The trash (its tab, row restore button and /api/nodes/trash) was removed on 2026-10-19 (86ee37124, D111); deleted
// notes now come back from History › 「Recently deleted」 (WorkspaceHistoryDeleted, 70594a921 added Delete for good).
// Kept: a deleted note with its sub-notes comes back whole and in place, a repeat of the request is harmless,
// offline the button is off and nothing is sent, another member never sees or restores a note in a space they
// are not in, and on a phone the row's buttons are reachable without sideways scroll.
// Slug conflicts are covered by undeleteSlugConflict.spec.
import { test, expect, type Page } from "@playwright/test";
import { ready, hideFromOthers, addToDefaultSpace, BASE, H } from "./helpers";

const live = async (page: Page, id: string) => (await page.request.get(`/api/nodes/${id}`, H)).status();
async function openDeleted(page: Page) {
  await ready(page, "/?view=timeline");
  await page.getByRole("tab", { name: "Recently deleted", exact: true }).click();
}
const deletedRow = (page: Page, title: string) => page.locator(".wh-deleted-row", { hasText: title });

test("HIST-08: subtree restore, offline restore, retry, permissions, phone", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const mk = async (title: string, parent?: string) => (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: title, ...(parent ? { parent_id: parent } : {}) } })).json()).id as string;
  const root = await mk(`TrashRoot ${stamp}`), c1 = await mk(`TrashC1 ${stamp}`, root), c2 = await mk(`TrashC2 ${stamp}`, root), g = await mk(`TrashG ${stamp}`, c1);
  expect((await page.request.delete(`/api/nodes/${root}`, H)).ok()).toBe(true);
  for (const id of [root, c1, c2, g]) expect(await live(page, id), "deleted with its sub-notes").toBe(404);

  // Subtree restore through the screen: one row for the note, and the whole tree comes back in place.
  await openDeleted(page);
  const row = deletedRow(page, `TrashRoot ${stamp}`);
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Bring back" }).click();
  await expect(row).toHaveCount(0, { timeout: 15_000 });
  for (const id of [root, c1, c2, g]) expect(await live(page, id), "restored with its sub-notes").toBe(200);
  expect((await (await page.request.get(`/api/nodes/${g}`, H)).json()).parent_id).toBe(c1);
  expect((await (await page.request.get(`/api/nodes/${c1}`, H)).json()).parent_id).toBe(root);
  // A repeat of the same request (lost response, second tab) changes nothing and loses nothing.
  await page.request.post(`/api/nodes/${root}/undelete`, H);
  for (const id of [root, c1, c2, g]) expect(await live(page, id)).toBe(200);

  // Offline: the button is off and nothing is sent; back online it works.
  const solo = await mk(`TrashSolo ${stamp}`);
  await page.request.delete(`/api/nodes/${solo}`, H);
  await openDeleted(page);
  const soloRow = deletedRow(page, `TrashSolo ${stamp}`);
  await expect(soloRow).toBeVisible();
  await page.context().setOffline(true);
  const btn = soloRow.getByRole("button", { name: "Bring back" });
  await expect(btn).toBeDisabled({ timeout: 10_000 });
  expect(await live(page, solo).catch(() => 404), "nothing came back while offline").toBe(404);
  await page.context().setOffline(false);
  await expect(btn).toBeEnabled({ timeout: 15_000 });
  await btn.click();
  await expect(soloRow).toHaveCount(0, { timeout: 15_000 });
  expect(await live(page, solo)).toBe(200);

  // Another member must not see or restore a deleted note in a space they are not in.
  const secret = await mk(`TrashSecret ${stamp}`);
  await hideFromOthers(page.request, secret);
  await page.request.delete(`/api/nodes/${secret}`, H);
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const su = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `H08 ${stamp}`, email: `h08-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  const member = await (await page.request.post("/api/actors", { ...H, data: { name: `H08 ${stamp}`, type: "human", external_id: su.user.id } })).json() as { id: string };
  await addToDefaultSpace(page.request, member.id);
  const theirList = await human.request.get("/api/history/deleted?days=30", H);
  expect(theirList.ok()).toBe(true);
  expect(JSON.stringify(await theirList.json())).not.toContain(`TrashSecret ${stamp}`);
  expect((await human.request.get(`/api/history/deleted/${secret}`, H)).status()).toBe(404);
  expect((await human.request.post(`/api/nodes/${secret}/undelete`, H)).ok()).toBe(false);
  expect(await live(page, secret), "still deleted").toBe(404);
  await human.close();

  // Phone viewport: the row and its button fit, and the tap brings the note back.
  const solo2 = await mk(`TrashPhone ${stamp}`);
  await page.request.delete(`/api/nodes/${solo2}`, H);
  const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const pp = await phone.newPage();
  await openDeleted(pp);
  const prow = deletedRow(pp, `TrashPhone ${stamp}`);
  await expect(prow).toBeVisible();
  const pbtn = prow.getByRole("button", { name: "Bring back" });
  const box = await pbtn.boundingBox();
  expect(box!.x + box!.width, "button inside the screen").toBeLessThanOrEqual(390);
  expect(await pp.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await pbtn.click();
  await expect(prow).toHaveCount(0, { timeout: 15_000 });
  expect(await live(page, solo2)).toBe(200);
  await phone.close();
});
