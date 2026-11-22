// Feature-audit deepening (2026-10-08): CAN-01 — boards through the real UI:
// opening the sidebar's Create sheet creates nothing by itself; choosing Canvas there creates
// exactly one even on a double click; a refused create; rename and delete from
// the sidebar (refusal, member notes untouched, undelete keeps the layout);
// the same Create sheet at phone width.
// A board is a note with a Canvas tab (docs/architecture/canvas-as-view.md), so there is no board list page and no
// 「Canvas」 entry in the top bar's 「More」 any more: a board is made from the Create sheet (sidebar ＋), the palette or
// 「＋ Add a view」, and it is found in the notes list like any note.
import { test, expect, type Page } from "@playwright/test";
import { ready, seedLayout, BASE, H } from "./helpers";

/** The sidebar's ＋ opens the Create sheet with Canvas among its kinds; returns the sheet. */
async function openCreateSheet(page: Page) {
  await page.getByRole("button", { name: "Create", exact: true }).filter({ visible: true }).first().click();
  const sheet = page.getByRole("dialog", { name: "Create", exact: true });
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await sheet.getByRole("radio", { name: "Canvas", exact: true }).click();
  return sheet;
}

async function findRow(page: Page, text: string) {
  const loc = page.locator(".obsidian-page-button", { hasText: text }).first();
  for (let i = 0; i < 80 && !(await loc.isVisible().catch(() => false)); i++) {
    await page.locator(".obsidian-page-button").first().evaluate((el) => {
      let p: HTMLElement | null = el.parentElement;
      while (p && !(p.scrollHeight > p.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
      if (p) p.scrollTop += 300;
    });
    await page.waitForTimeout(80);
  }
  return loc;
}

test("CAN-01: board create / rename / delete through the UI", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const boards = async () => (await (await page.request.get("/api/canvases")).json()) as Array<{ id: string; title: string }>;
  const serverTitle = async (id: string) => (await boards()).find((b) => b.id === id)?.title;
  // The one wording of a refused write (lib/serverErrors.ts: forbidden), on a toast and in the recovery panel.
  const forbiddenText = "You don't have permission to do that.";
  // Deleting is a soft delete with an Undo prompt, not a question (docs/decisions/soft-delete-no-trash.md): no native or in-app confirmation appears.
  const dialogs: string[] = [];
  page.on("dialog", (d) => { dialogs.push(d.message()); void d.dismiss(); });
  const before0 = new Set((await boards()).map((b) => b.id));
  const newBoards = async () => (await boards()).filter((b) => !before0.has(b.id));
  await ready(page, "/?view=notes");
  const sheet = await openCreateSheet(page);
  await page.waitForTimeout(1500); // an absence check: nothing may be created while the sheet only sits open
  expect(await newBoards(), "opening the Create sheet and choosing a kind creates nothing").toHaveLength(0);

  // Double click "Create" with Canvas chosen.
  const posts: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/canvases")) posts.push(r.postData() ?? ""); });
  await sheet.getByRole("button", { name: "Create", exact: true }).dblclick();
  await expect.poll(async () => (await newBoards()).length).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(1500); // an absence check: a second create from the second click would land by now
  expect(posts.length, "a double click on Create sends one create").toBe(1);
  const created = await newBoards();
  expect(created, "and makes one board").toHaveLength(1);
  // The new board opens as the open note on its Canvas tab (docs/architecture/canvas-as-view.md: a board is a note with a Canvas tab).
  await expect(page).toHaveURL(new RegExp(`node=${created[0].id}`));
  expect(new URL(page.url()).searchParams.get("lens"), "it opens on the Canvas tab").toBe("canvas");
  await expect(page.locator(".kw-canvas-wrap")).toBeVisible();

  // Refused create (403): nothing is made; the refused input is kept in the recovery panel (decisions-offline-account.md, batch 16:
  // a refusal is not a discard; 403 gets a readable sentence).
  await page.route("**/api/canvases", (r) => r.request().method() === "POST" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  const n1 = (await boards()).length;
  const sheet403 = await openCreateSheet(page);
  await sheet403.getByRole("button", { name: "Create", exact: true }).click();
  const recovery = page.locator(".failed-write-recovery").filter({ visible: true });
  await expect(recovery).toContainText("This change was rejected");
  await expect(recovery).toContainText(forbiddenText);
  await expect(recovery, "the refused input is kept").toContainText("Untitled canvas");
  expect((await boards()).length - n1, "a refused create makes no board").toBe(0);
  // The Create sheet closes once the write is handed to the recovery panel; its input lives there.
  await expect(sheet403).toBeHidden(); // pinned: today's behaviour, no written rule
  await page.unroute("**/api/canvases");
  await recovery.getByRole("button", { name: "Minimize recovery panel" }).click().catch(() => {});

  // Rename + delete from the sidebar, on a board with two member notes.
  const m1 = await (await page.request.post("/api/nodes", { ...H, data: { title: `Mem1 ${stamp}`, markdown: "m1" } })).json();
  const m2 = await (await page.request.post("/api/nodes", { ...H, data: { title: `Mem2 ${stamp}`, markdown: "m2" } })).json();
  const bd = await (await page.request.post("/api/canvases", { ...H, data: { title: `C01Board ${stamp}` } })).json();
  await seedLayout(page.request, bd.id, { ...H, data: { data: { nodes: [{ nodeId: m1.id, x: 40, y: 40, width: 240 }, { nodeId: m2.id, x: 400, y: 40, width: 240 }] } } });
  await ready(page, `/?view=notes&node=${bd.id}`);
  await page.locator(".react-flow__node").first().waitFor({ timeout: 30_000 });
  const row = () => findRow(page, `C01Board ${stamp}`);
  // The open note's row is scrolled into view in the sidebar (components/OverviewSidebar.tsx: scrollIntoView of the active row).
  await expect(page.locator(".obsidian-page-button.active", { hasText: `C01Board ${stamp}` }).first()).toBeInViewport();
  const rename = async (from: string, to: string) => {
    await (await findRow(page, from)).click({ button: "right" });
    await page.locator(".ctx-menu").getByRole("menuitem", { name: "Rename", exact: true }).click();
    const input = page.locator(".sb-rename-input");
    await input.fill(to); await input.press("Enter");
  };
  await row();
  await rename(`C01Board ${stamp}`, `C01Renamed ${stamp}`);
  await expect.poll(() => serverTitle(bd.id)).toBe(`C01Renamed ${stamp}`);
  await expect(page.locator(".obsidian-page-button", { hasText: `C01Renamed ${stamp}` })).toHaveCount(1);
  await expect(page.locator(".toast").filter({ hasText: "Renamed" }).first()).toBeVisible(); // nodeMutations.renameNode: "Renamed"
  // Refused rename (403): the server title stays, the sidebar never shows the refused title as a row, and the form stays open with
  // the typed text (nodeMutations.renameNode: false keeps the rename form open; the writer has reported why).
  await page.route(`**/api/nodes/${bd.id}`, (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  await page.route(`**/api/canvases/${bd.id}`, (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  await rename(`C01Renamed ${stamp}`, `C01Refused ${stamp}`);
  await expect(page.locator(".failed-write-recovery").filter({ visible: true })).toContainText(forbiddenText);
  expect(await serverTitle(bd.id), "a refused rename changes nothing on the server").toBe(`C01Renamed ${stamp}`);
  await expect(page.locator(".obsidian-page-button", { hasText: `C01Refused ${stamp}` }), "the refused title is not a row").toHaveCount(0);
  await expect(page.locator(".sb-rename-input"), "the form stays open").toHaveValue(`C01Refused ${stamp}`);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.locator(".sb-rename-input").press("Escape");
  // Empty title: no write; the form stays open.
  await ready(page, `/?view=notes&node=${bd.id}`);
  await (await findRow(page, `C01Renamed ${stamp}`)).click({ button: "right" });
  await page.locator(".ctx-menu").getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.locator(".sb-rename-input").fill("   "); await page.locator(".sb-rename-input").press("Enter");
  await expect(page.locator(".sb-rename-input"), "a blank title keeps the form open (nodeMutations.renameNode)").toBeVisible();
  expect(await serverTitle(bd.id), "a blank title is no rename").toBe(`C01Renamed ${stamp}`);
  await page.locator(".sb-rename-input").press("Escape");

  // Delete: refused first, then for real.
  await ready(page, `/?view=notes&node=${bd.id}`);
  const delRow = await findRow(page, `C01Renamed ${stamp}`);
  await page.route(`**/api/nodes/${bd.id}`, (r) => r.request().method() === "DELETE" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  await page.route(`**/api/canvases/${bd.id}`, (r) => r.request().method() === "DELETE" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  await delRow.click({ button: "right" });
  await page.locator(".ctx-menu").getByRole("menuitem", { name: "Delete", exact: true }).click();
  await expect(page.locator(".toast").filter({ hasText: forbiddenText }).first()).toBeVisible();
  expect((await boards()).some((b) => b.id === bd.id), "a refused delete leaves the board live").toBe(true);
  await expect(page.locator(".obsidian-page-button", { hasText: `C01Renamed ${stamp}` })).toHaveCount(1);
  // A refused delete gives the focus back: the page the user is on stays (lib/data/nodeActions.ts, delete).
  await expect(page).toHaveURL(new RegExp(`node=${bd.id}`));
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await ready(page, `/?view=notes&node=${bd.id}`);
  await (await findRow(page, `C01Renamed ${stamp}`)).click({ button: "right" });
  await page.locator(".ctx-menu").getByRole("menuitem", { name: "Delete", exact: true }).click();
  const memLive = async () => [(await page.request.get(`/api/nodes/${m1.id}`)).status(), (await page.request.get(`/api/nodes/${m2.id}`)).status()];
  // Soft delete with an Undo prompt, and the open note moves to its neighbour (docs/decisions/soft-delete-no-trash.md).
  await expect(page.locator(".toast").getByRole("button", { name: "Undo" }).first()).toBeVisible();
  await expect.poll(async () => (await boards()).some((b) => b.id === bd.id), "the deleted board is not listed").toBe(false);
  expect(await memLive(), "member notes are untouched").toEqual([200, 200]);
  expect(page.url(), "the open note moved on to a neighbour").not.toContain(bd.id);
  expect(new URL(page.url()).searchParams.get("node"), "and a note is open").not.toBeNull();
  expect(dialogs, "no confirmation question for a soft delete").toEqual([]);
  await expect(page.locator(".confirm-dialog")).toHaveCount(0);
  // A deleted board is gone from the notes list and from the boards the server lists; undelete brings it back with its layout.
  await expect(page.locator(".obsidian-page-button", { hasText: `C01Renamed ${stamp}` })).toHaveCount(0);
  const und = await page.request.post(`/api/nodes/${bd.id}/undelete`, { ...H, data: {} });
  const back = await (await page.request.get(`/api/canvases/${bd.id}`)).json().catch(() => ({}));
  const placedAt = (back.data?.nodes ?? []).map((n: { nodeId: string; x: number }) => `${n.nodeId === m1.id ? "m1" : n.nodeId === m2.id ? "m2" : "?"}@${n.x}`);
  expect(und.status()).toBe(200);
  expect(placedAt, "undelete keeps both cards where they were").toEqual(["m1@40", "m2@400"]);

  // Phone: the Create sheet is a bottom sheet over the notes list.
  const phone = await browser.newContext({ baseURL: BASE, storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await phone.newPage();
  await ready(pp, "/?view=notes");
  const toList = pp.getByRole("button", { name: "Back to notes list", exact: true }).filter({ visible: true });
  if (await toList.count()) await toList.first().click();
  const psheet = await openCreateSheet(pp);
  const nb = psheet.getByRole("button", { name: "Create", exact: true });
  const box = await nb.boundingBox();
  // A phone tap target is at least 44 px (frontend/e2e/layout-audit README: 手機點擊目標) and the page does not scroll sideways.
  expect(box!.height, "the Create button is a 44px tap target").toBeGreaterThanOrEqual(44);
  expect(await pp.evaluate(() => document.documentElement.scrollWidth), "no sideways scroll on the phone").toBeLessThanOrEqual(390);
  const phoneBefore = new Set((await boards()).map((b) => b.id));
  await nb.click();
  await expect.poll(async () => (await boards()).filter((b) => !phoneBefore.has(b.id)).length).toBe(1);
  await expect(pp.locator(".kw-canvas-wrap"), "the new board opens").toBeVisible();
  await phone.close();
});
