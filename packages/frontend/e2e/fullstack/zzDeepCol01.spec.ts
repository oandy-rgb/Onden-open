// Feature-audit deepening (2026-10-07): COL-01 — saved views: API management
// (create / rename / delete / pin order) recorded separately from what the UI
// can reach; deleting the active and the last view; create failure and retry;
// reopen; phone viewport.
//
// 2026-11-18: every observation the probe used to print is now a check (owner's order 「都改成檢查」). Where the product has
// moved on since 2026-10-07 the check follows the newest written decision: only the workspace owner writes a tag's views
// (tagViews.ts: `principal_admin`), the tab strip has a right-click menu for rename / move / delete (decisions-ui.md 「筆記與標籤頁的視角分頁」),
// the open tab is part of the URL, and a view is never created offline (GAP-124 in full-feature-audit.md).
import { test, expect, type Page } from "@playwright/test";
import { ready, openSavedViewTab, BASE, H } from "./helpers";
import { contextsClosedAfterEach, clickableSize, readyLive } from "./viewChecks";

// Every extra browser context a test opens is closed when the test ends, also when it stops at a failing line (see viewChecks.ts).
const newContext = contextsClosedAfterEach(test);

test("COL-01: view CRUD via API vs UI, delete active/last, create failure, reopen, phone", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `C01T${stamp}`, fields: [{ name: "status", type: "text" }] } })).json();
  for (const t of ["A", "B"]) {
    const n = await (await page.request.post("/api/nodes", { ...H, data: { title: `${t} ${stamp}`, markdown: t } })).json();
    await page.request.put(`/api/nodes/${n.id}/tags/${tag.id}`, { ...H, data: {} });
  }
  const base = `/api/tags/${tag.id}/views`;
  const list = async () => ((await (await page.request.get(base)).json()).views as { id: string; name: string; pin_order: number }[]);
  const names = async () => (await list()).map((v) => v.name);
  const create = async (data: unknown) => { const r = await page.request.post(base, { ...H, data }); return { s: r.status(), id: (await r.json().catch(() => ({}))).id as string }; };

  // ── API management ────────────────────────────────────────────────────
  const v1 = await create({ name: "Alpha", layout: "table" });
  const v2 = await create({ name: "Beta" });
  const v3 = await create({ name: "Pinned", pin_order: -1 });
  // routes/tags.ts answers a created view 201; the list is "pinned first, then by name" (tagViews.ts byPinThenName).
  expect([v1.s, v2.s, v3.s]).toEqual([201, 201, 201]);
  expect(await names()).toEqual(["Pinned", "Alpha", "Beta"]);
  // A name the tag already has is refused 409 (tagViews.ts TagViewNameConflictError).
  expect((await create({ name: "Alpha" })).s).toBe(409);
  // viewFieldsSchema: name 1..VIEW_NAME_MAX (80) characters, layout one of the registered ones.
  expect((await create({ name: "" })).s).toBe(400);
  expect((await create({ name: "x".repeat(81) })).s).toBe(400);
  expect((await create({ name: "L", layout: "pivot" })).s).toBe(400);
  expect(await names()).toEqual(["Pinned", "Alpha", "Beta"]); // none of the refusals left a view behind
  const rename = async (id: string, name: string) => (await page.request.patch(`${base}/${id}`, { ...H, data: { name } })).status();
  expect(await rename(v2.id, "Beta renamed")).toBe(200);
  expect(await names()).toEqual(["Pinned", "Alpha", "Beta renamed"]);
  // A rename goes through the same unique-name rule as create (tagViews.ts updateTagView; GAP-148 asked for exactly this).
  expect(await rename(v2.id, "Alpha")).toBe(409);
  expect(await names()).toEqual(["Pinned", "Alpha", "Beta renamed"]);
  expect(await rename(v2.id, "")).toBe(400);
  expect((await page.request.patch(`${base}/00000000-0000-0000-0000-000000000000`, { ...H, data: { name: "x" } })).status()).toBe(404);
  const del = async (id: string) => (await page.request.delete(`${base}/${id}`, H)).status();
  expect(await del(v3.id)).toBe(200);
  expect(await del(v3.id)).toBe(404); // routes/tags.ts: a view that is gone is not_found
  expect(await names()).toEqual(["Alpha", "Beta renamed"]);
  expect((await page.request.get(`${base}/${v3.id}/exec`)).status()).toBe(404);

  // Another human: a tag's views are part of the global tag definition, so only the workspace owner writes them
  // (tagViews.ts `principal_admin`, docs/decisions/identity-owner-member.md). The probe expected an editor to be allowed; that
  // was before views became owner-only.
  const human = await newContext(browser, { baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const su = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `C01 ${stamp}`, email: `c01-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  const actor = await (await page.request.post("/api/actors", { ...H, data: { name: `C01 ${stamp}`, type: "human", external_id: su.user.id } })).json();
  expect((await human.request.post(base, { ...H, data: { name: "ByViewer" } })).status()).toBe(403);
  expect((await human.request.delete(`${base}/${v1.id}`, H)).status()).toBe(403);
  await page.request.patch(`/api/actors/${actor.id}`, { ...H, data: { role: "editor" } });
  expect((await human.request.post(base, { ...H, data: { name: "ByEditor" } })).status()).toBe(403);
  expect((await human.request.delete(`${base}/${v1.id}`, H)).status()).toBe(403);
  await human.close();
  expect(await names()).toEqual(["Alpha", "Beta renamed"]); // nothing the second human tried changed the list

  // ── UI reachability ───────────────────────────────────────────────────
  // A tag's page opens on its first tab, 「List」 (the tagged notes); the saved views are the tabs after it, and a view's
  // toolbar (.cv-root) exists only while one of them is open. With none left there is only 「List」.
  const tabs = (p: Page) => p.locator(".view-tabs [role=tab]");
  const chips = (p: Page) => p.locator(".view-tabs [role=tab]:not(:first-child) .view-tab-name");
  const active = (p: Page) => p.locator(".view-tab--active .view-tab-name");
  const openViews = async (p: Page, savedViews: number) => {
    await ready(p, `/?view=notes&node=${tag.id}`);
    await expect(tabs(p)).toHaveCount(1 + savedViews);
    if (savedViews > 0) {
      await openSavedViewTab(p);
      await expect(p.locator(".cv-root")).toBeVisible();
    }
  };
  // 「＋」 opens the panel of ways of seeing the page; a layout the page already has only opens its tab ("Already here"), so
  // each UI create below picks a layout the tag has no view of. Each is made at once (#1848): Calendar takes the first date
  // field (Created date), Cards picks its cover itself, Table needs nothing.
  const addPanel = (p: Page) => p.getByRole("dialog", { name: "Add a view" });
  const addViaUi = async (p: Page, layout: "Table" | "Calendar" | "Cards") => {
    await p.locator(".view-tab--add").click();
    await addPanel(p).getByRole("button", { name: layout }).click();
  };
  await openViews(page, 2);
  // The tabs after 「List」 are the saved views, in the API's order.
  await expect(chips(page)).toHaveText(["Alpha", "Beta renamed"]);
  await expect(active(page)).toHaveText("Alpha"); // clicking a tab makes it the active one

  // Managing a tab (rename / move / delete) is the right-click menu of the tab (decisions-ui.md: 「右鍵／長按選單：重新命名、往左移、往右移、刪除」).
  await chips(page).first().click({ button: "right" });
  const menu = page.getByRole("menu");
  for (const item of ["Rename", "Move left", "Move right", "Delete view"]) await expect(menu.getByRole("menuitem", { name: item, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  // pinned: today's behaviour, no written rule — the view toolbar has no rename / delete / pin button of its own.
  const toolbar = page.locator(".cv-root");
  expect(await toolbar.getByRole("button", { name: /rename/i }).count()).toBe(0); // pinned: today's behaviour, no written rule
  expect(await toolbar.getByRole("button", { name: /delete|remove/i }).count()).toBe(0); // pinned: today's behaviour, no written rule
  expect(await toolbar.getByRole("button", { name: /pin|default/i }).count()).toBe(0); // pinned: today's behaviour, no written rule
  // The probe saw a double click do nothing (GAP-148: 「UI 沒有改名」); since then the tab renames in place: a double click opens
  // an input named 「View name」 (ViewTabs.tsx, at most VIEW_NAME_MAX characters) and Escape leaves the name as it was.
  await chips(page).first().dblclick();
  const renameInput = page.getByRole("textbox", { name: "View name" });
  await expect(renameInput).toHaveValue("Alpha");
  await expect(renameInput).toHaveAttribute("maxlength", "80");
  await renameInput.press("Escape");
  await expect(renameInput).toHaveCount(0);
  expect(await names()).toEqual(["Alpha", "Beta renamed"]);

  // The open tab is in the URL (decisions-ui.md: `lens=editor&tab=<id>`, a tab switch is a replace), so a reload keeps it.
  await chips(page).nth(1).click();
  await expect(active(page)).toHaveText("Beta renamed");
  const betaId = (await list()).find((v) => v.name === "Beta renamed")!.id;
  await expect(page).toHaveURL(new RegExp(`tab=${betaId}`));
  await page.reload();
  await expect(active(page)).toHaveText("Beta renamed");
  // Opening the page again by an address without a tab: the tab this device last left the page on comes back (decisions-ui.md says
  // that for 「從側欄開筆記」; a typed address is not named there).
  await readyLive(page, `/?view=notes&node=${tag.id}`); // the view is deleted elsewhere below: the live stream must be open by then
  await expect(active(page)).toHaveText("Beta renamed"); // pinned: today's behaviour, no written rule

  // Delete the ACTIVE view elsewhere (API), then interact. There is no reload button on the view: sync brings the deletion to the
  // open page (full-feature-audit.md GAP-158, 「開著的 view 在 changed 事件…重跑」) and the dead tab goes (GAP-149).
  await expect(page.locator(".cv-root")).toBeVisible();
  expect(await del(betaId)).toBe(200);
  await expect(chips(page)).toHaveText(["Alpha"], { timeout: 20_000 });
  await expect(page.locator(".cv-error")).toHaveCount(0); // no raw `not_found` left on the page
  await expect(page.locator("body")).not.toContainText("not_found");
  await expect(active(page)).toHaveCount(1); // some tab that exists is open, not the deleted one
  await expect(active(page)).not.toHaveText("Beta renamed");

  // New views via the UI: the name comes from the layout and what it is placed by (freeViewName avoids a taken one), so the old
  // "View N" collision (GAP-149) cannot happen; what is left to check is that each add makes exactly one view.
  const posts: number[] = [];
  page.on("response", (r) => { if (r.request().method() === "POST" && r.url().endsWith(`/views`)) posts.push(r.status()); });
  const n1 = (await list()).length;
  await addViaUi(page, "Cards");
  await expect(chips(page)).toContainText(["Cards"]);
  expect((await list()).length - n1).toBe(1);
  expect(posts).toEqual([201]);
  await expect(page.locator(".cv-error")).toHaveCount(0);
  await addViaUi(page, "Calendar");
  // lib/viewTabs.ts autoViewName: 「<kind> · <what places it>」; the calendar's built-in date is named 「Created date」 (decisions-ui-history.md: 內部名稱不外露).
  await expect(chips(page)).toContainText(["Calendar · Created date"]);
  expect((await list()).length - n1).toBe(2);
  expect(posts).toEqual([201, 201]);
  // Pinned and by name (tagViews.ts byPinThenName): every one of them has pin_order 0, so the tabs are in name order.
  expect(await names()).toEqual(["Alpha", "Calendar · Created date", "Cards"]);
  await expect(chips(page)).toHaveText(await names());
  // A layout the page already has: no second view, just its tab (useAddView `present`).
  await page.locator(".view-tab--add").click();
  for (const layout of ["Table", "Calendar", "Cards"]) await expect(addPanel(page).getByRole("button", { name: layout }).filter({ hasText: "Already here" })).toHaveCount(1);
  await expect(addPanel(page).locator(".cv-add-view-have")).toHaveCount(3);
  await page.keyboard.press("Escape");

  // Delete the LAST view (all of them) → reopen shows only 「List」, and the 「＋」 still adds a view.
  for (const v of await list()) await del(v.id);
  await openViews(page, 0);
  await expect(chips(page)).toHaveCount(0);
  await expect(page.locator(".cv-root")).toHaveCount(0);
  await addViaUi(page, "Cards");
  await expect(chips(page)).toHaveText(["Cards"]);
  expect(await names()).toEqual(["Cards"]);

  // Create failure (503) then retry: nothing is created, one notice, and the retry makes exactly one view.
  const before = (await list()).length;
  await page.route(`**${base}`, (r) => r.request().method() === "POST" ? r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"down"}' }) : r.continue());
  await addViaUi(page, "Calendar");
  // lib/data/writeErrors.ts writeFailureMessage: a server that answers 503 without a known code is 「Could not reach the server」; the writer says it once.
  await expect(page.getByRole("alert").filter({ hasText: "Could not reach the server. Try again when the connection is available." })).toHaveCount(1);
  await expect(chips(page)).toHaveText(["Cards"]);
  await expect(page.locator(".view-tab--add")).toBeEnabled();
  expect((await list()).length - before).toBe(0);
  await page.unroute(`**${base}`);
  await addViaUi(page, "Calendar");
  await expect(chips(page)).toHaveText(["Calendar · Created date", "Cards"]);
  expect((await list()).length - before).toBe(1);

  // Offline create: a new view needs the server (it makes the id), so it is refused out loud and not queued
  // (full-feature-audit.md GAP-124: 「建立新檢視仍需連線，離線時明確拒絕」).
  await page.context().setOffline(true);
  await addViaUi(page, "Table");
  // lib/data/viewWriter.ts: `create` is refused offline with 「Creating a view needs a connection.」
  await expect(page.getByRole("alert").filter({ hasText: "Creating a view needs a connection." })).toHaveCount(1);
  await expect(chips(page)).toHaveText(["Calendar · Created date", "Cards"]);
  await expect(page.locator(".view-tab--add")).toBeEnabled();
  await page.context().setOffline(false);
  // Back online the refused view does not appear by itself: the next add of a Table makes the one and only Table view (had the
  // offline add been queued and replayed, this would find the layout already there or be named 「Table 2」).
  await addViaUi(page, "Table");
  await expect(chips(page)).toHaveText(["Calendar · Created date", "Cards", "Table"]);
  expect(await names()).toEqual(["Calendar · Created date", "Cards", "Table"]);

  // Phone.
  const phone = await newContext(browser, { storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const pp = await phone.newPage();
  await openViews(pp, 3);
  // full-feature-audit.md COL-01: no horizontal overflow of the page at 390px (layout-audit: no horizontal scrollbar).
  expect(await pp.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // The tab strip stays inside the viewport's left edge, and its tabs are finger-sized: layout-audit R7 / `--ac-tap` ask 44px on a phone.
  const strip = await pp.locator(".view-tabs").boundingBox();
  expect(strip!.x).toBeGreaterThanOrEqual(0);
  expect(strip!.x + strip!.width).toBeLessThanOrEqual(390 + 1);
  for (const target of [pp.locator(".view-tab").first(), pp.locator(".view-tab--add")]) {
    expect((await clickableSize(target)).h).toBeGreaterThanOrEqual(44);
  }
  await phone.close();
});
