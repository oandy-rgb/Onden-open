// Feature-audit deepening (2026-10-07): COL-09 — a note's children as rows:
// live row update on reparent, another human sees the same rows,
// empty subtree, and phone viewport. The children Table lens was removed
// (#486): the rows are now the 「全部」 tab of the 「Sub-notes」 section on
// the note's content page (MemberList — a table with the fields the children
// share, else a list of titles), and an old ?lens=table link opens Content.
import { test, expect, type Page } from "@playwright/test";
import { ready, defaultSpaceId, addToDefaultSpace, BASE, H } from "./helpers";

const section = (page: Page) => page.locator(".note-relations-children");
const rows = (page: Page) => section(page).locator(".tag-member-list li, .tag-member-table tbody tr");
const rowTitles = async (page: Page) => (await rows(page).allInnerTexts()).map((t) => t.split("\t")[0].trim());

test("COL-09: reparent updates rows, another human sees them, empty subtree, phone", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const stamp = Date.now();
  // Root notes in the default space so the second human can open them.
  const shared = await defaultSpaceId(page.request);
  const mk = async (title: string, parent?: string) =>
    (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: `${title} body`, ...(parent ? { parent_id: parent } : { space_id: shared }) } })).json()).id as string;
  const P = await mk(`TblParent ${stamp}`), Q = await mk(`TblOther ${stamp}`);
  const c1 = await mk(`Kid1 ${stamp}`, P), c2 = await mk(`Kid2 ${stamp}`, P);
  // No "unreadable child" case any more: a child always shares its parent's
  // space, so whoever can read P reads every child row.
  const out: Record<string, string> = {};

  await ready(page, `/?view=notes&node=${P}`);
  await expect(rows(page).first()).toBeVisible();
  out.ownerInitial = JSON.stringify(await rowTitles(page));

  // Reparent Kid2 away → its row leaves without a reload; reparent back in.
  await page.request.patch(`/api/nodes/${c2}`, { ...H, data: { parent_id: Q } });
  await expect.poll(async () => (await rowTitles(page)).some((t) => t.includes("Kid2")), { timeout: 15_000 }).toBe(false);
  out.afterMoveOut = JSON.stringify(await rowTitles(page));
  const c3 = await mk(`Kid3 ${stamp}`, P);
  await expect.poll(async () => (await rowTitles(page)).some((t) => t.includes("Kid3")), { timeout: 15_000 }).toBe(true);
  out.afterNewChild = JSON.stringify(await rowTitles(page));
  void c1; void c3;

  // Opening a row navigates to that child.
  await rows(page).filter({ hasText: `Kid1 ${stamp}` }).first().getByRole("button", { name: `Kid1 ${stamp}` }).click();
  await page.waitForTimeout(800);
  out.rowClickOpens = String(page.url().includes(c1));

  // Empty subtree.
  const lonely = await mk(`Lonely ${stamp}`);
  await ready(page, `/?view=notes&node=${lonely}`);
  // A note without children has no Sub-notes section at all.
  await expect(page.locator(".obsidian-title-input")).toHaveValue(`Lonely ${stamp}`);
  out.empty = `subNotesSections=${await section(page).count()}`;

  // Another human (editor in the default space) sees the same child rows.
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const signup = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `C09 ${stamp}`, email: `c09-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  const member = await (await page.request.post("/api/actors", { ...H, data: { name: `C09 ${stamp}`, type: "human", external_id: signup.user.id } })).json() as { id: string };
  // A new member joins no shared space by itself (migration 097): add them to 共用.
  await addToDefaultSpace(page.request, member.id);
  const hp = await human.newPage();
  await hp.addInitScript(() => localStorage.setItem("onden.welcomeDismissed", "1"));
  await ready(hp, `/?view=notes&node=${P}`);
  await expect(rows(hp).first()).toBeVisible({ timeout: 20_000 });
  const theirs = await rowTitles(hp);
  out.editorSees = JSON.stringify(theirs);
  await human.close();

  // Phone viewport: the parent's Sub-notes section.
  const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const pp = await phone.newPage();
  await ready(pp, `/?view=notes&node=${P}`);
  await rows(pp).first().waitFor({ timeout: 20_000 }).catch(() => {}); // the section's list is lazy-loaded
  const phoneRows = await rows(pp).count().catch(() => 0);
  const tableBox = await section(pp).boundingBox().catch(() => null);
  out.phone = `rows=${phoneRows} tableWidth=${tableBox ? Math.round(tableBox.width) : "none"} docWidth=${await pp.evaluate(() => document.documentElement.scrollWidth)}`;
  await pp.screenshot({ path: "/tmp/pw-output/col09-phone.png", fullPage: true });
  await phone.close();
  console.log(`AUDIT COL-09 ${JSON.stringify(out)}`);
});
