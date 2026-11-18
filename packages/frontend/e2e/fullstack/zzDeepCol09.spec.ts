// Feature-audit deepening (2026-10-07): COL-09 — a note's children as rows:
// live row update on reparent, another human sees the same rows,
// empty subtree, and phone viewport. The children Table lens was removed
// (#486): the rows are now the 「全部」 tab of the 「Sub-notes」 section on
// the note's content page (MemberList — a table with the fields the children
// share, else a list of titles), and an old ?lens=table link opens Content.
//
// 2026-11-18: every observation the probe printed is a check now (owner's order 「都改成檢查」). The rules: NoteRelations.tsx (the 「Sub-notes」
// section exists only while the note has children), full-feature-audit.md COL-09 (a reparent moves the row live, a row opens the child,
// someone who reads the parent reads every child row), spaces.md (a child shares its parent's space). The order of the rows is not a
// written rule here, so the checks compare them as sets.
import { test, expect, type Page } from "@playwright/test";
import { ready, defaultSpaceId, addToDefaultSpace, BASE, H } from "./helpers";
import { contextsClosedAfterEach, readyLive } from "./viewChecks";

// Every extra browser context a test opens is closed when the test ends, also when it stops at a failing line (see viewChecks.ts).
const newContext = contextsClosedAfterEach(test);

const section = (page: Page) => page.locator(".note-relations-children");
const rows = (page: Page) => section(page).locator(".tag-member-list li, .tag-member-table tbody tr");
const rowTitles = async (page: Page) => (await rows(page).allInnerTexts()).map((t) => t.split("\t")[0].trim()).sort();

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
  const kid = (n: number) => `Kid${n} ${stamp}`;

  await readyLive(page, `/?view=notes&node=${P}`); // the reparent below must not be made before the live stream is open
  await expect(rows(page).first()).toBeVisible();
  expect(await rowTitles(page)).toEqual([kid(1), kid(2)]);

  // Reparent Kid2 away → its row leaves without a reload; a new child arrives the same way (COL-09: 「子節點改父後列即時移出、新子節點即時出現」).
  await page.request.patch(`/api/nodes/${c2}`, { ...H, data: { parent_id: Q } });
  await expect.poll(() => rowTitles(page), { timeout: 15_000 }).toEqual([kid(1)]);
  await mk(kid(3), P);
  await expect.poll(() => rowTitles(page), { timeout: 15_000 }).toEqual([kid(1), kid(3)]);

  // Opening a row navigates to that child.
  await rows(page).filter({ hasText: kid(1) }).first().getByRole("button", { name: kid(1) }).click();
  await expect(page).toHaveURL(new RegExp(`node=${c1}`));

  // A note without children has no Sub-notes section at all (NoteRelations.tsx: the section is drawn only for `children.length > 0`).
  const lonely = await mk(`Lonely ${stamp}`);
  await ready(page, `/?view=notes&node=${lonely}`);
  await expect(page.locator(".obsidian-title-input")).toHaveValue(`Lonely ${stamp}`);
  await expect(section(page)).toHaveCount(0);

  // Another human (editor in the default space) sees the same child rows.
  const human = await newContext(browser, { baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const signup = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `C09 ${stamp}`, email: `c09-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  const member = await (await page.request.post("/api/actors", { ...H, data: { name: `C09 ${stamp}`, type: "human", external_id: signup.user.id } })).json() as { id: string };
  // A new member joins no shared space by itself (migration 097): add them to 共用.
  await addToDefaultSpace(page.request, member.id);
  const hp = await human.newPage();
  await hp.addInitScript(() => localStorage.setItem("onden.welcomeDismissed", "1"));
  await ready(hp, `/?view=notes&node=${P}`);
  await expect(rows(hp).first()).toBeVisible({ timeout: 20_000 });
  expect(await rowTitles(hp)).toEqual([kid(1), kid(3)]);
  await human.close();

  // Phone viewport: the parent's Sub-notes section (COL-09: 「390px 3 列…無溢出」): both rows are there, inside the screen, and the page is not wider.
  const phone = await newContext(browser, { storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const pp = await phone.newPage();
  await ready(pp, `/?view=notes&node=${P}`);
  await expect(rows(pp)).toHaveCount(2, { timeout: 20_000 }); // the section's list is lazy-loaded
  const box = await section(pp).boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390 + 1);
  expect(await pp.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await phone.close();
});
