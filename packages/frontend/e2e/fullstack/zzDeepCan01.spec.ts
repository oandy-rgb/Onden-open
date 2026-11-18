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
  const out: Record<string, string> = {};
  const boards = async () => (await (await page.request.get("/api/canvases")).json()) as Array<{ id: string; title: string }>;
  const toasts = async () => (await page.locator(".toast").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").slice(0, 160);
  try {
  const before0 = new Set((await boards()).map((b) => b.id));
  const n0 = before0.size;
  await ready(page, "/?view=notes");
  const sheet = await openCreateSheet(page);
  await page.waitForTimeout(1500);
  out.sheetCreatesNothing = `${n0}→${(await boards()).length}`;
  expect((await boards()).length, "opening the Create sheet and choosing a kind creates nothing").toBe(n0);

  // Double click "Create" with Canvas chosen.
  const posts: string[] = [];
  page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/canvases")) posts.push(r.postData() ?? ""); });
  await sheet.getByRole("button", { name: "Create", exact: true }).dblclick();
  await page.waitForTimeout(2500);
  const after = await boards();
  out.doubleClickCreate = JSON.stringify({ posts: posts.length, delta: after.length - n0, url: page.url().replace(BASE, ""), boardShown: await page.locator(".kw-canvas-wrap").isVisible().catch(() => false) });
  expect(posts.length, "a double click on Create sends one create").toBe(1);
  expect(after.length - n0, "and makes one board").toBe(1);
  const created = after.find((b) => !before0.has(b.id));

  // Refused create (403).
  await page.route("**/api/canvases", (r) => r.request().method() === "POST" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  const n1 = (await boards()).length;
  const sheet403 = await openCreateSheet(page);
  await sheet403.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForTimeout(2000);
  out.create403 = JSON.stringify({ delta: (await boards()).length - n1, sheetStill: await sheet403.isVisible().catch(() => false), buttonEnabled: await sheet403.getByRole("button", { name: "Create", exact: true }).isEnabled().catch(() => "gone"), toast: await toasts() });
  expect((await boards()).length - n1, "a refused create makes no board").toBe(0);
  await page.unroute("**/api/canvases");
  if (await sheet403.isVisible().catch(() => false)) await page.keyboard.press("Escape");

  // Rename + delete from the sidebar, on a board with two member notes.
  const m1 = await (await page.request.post("/api/nodes", { ...H, data: { title: `Mem1 ${stamp}`, markdown: "m1" } })).json();
  const m2 = await (await page.request.post("/api/nodes", { ...H, data: { title: `Mem2 ${stamp}`, markdown: "m2" } })).json();
  const bd = await (await page.request.post("/api/canvases", { ...H, data: { title: `C01Board ${stamp}` } })).json();
  await seedLayout(page.request, bd.id, { ...H, data: { data: { nodes: [{ nodeId: m1.id, x: 40, y: 40, width: 240 }, { nodeId: m2.id, x: 400, y: 40, width: 240 }] } } });
  await ready(page, `/?view=notes&node=${bd.id}`);
  await page.locator(".react-flow__node").first().waitFor({ timeout: 30_000 });
  const row = () => findRow(page, `C01Board ${stamp}`);
  out.sidebarRowVisibleWithoutScroll = String(await page.locator(".obsidian-page-button", { hasText: `C01Board ${stamp}` }).first().isVisible().catch(() => false));
  const rename = async (to: string) => {
    await (await row()).click({ button: "right" });
    await page.locator(".ctx-menu").getByRole("menuitem", { name: "Rename", exact: true }).click();
    const input = page.locator(".sb-rename-input");
    await input.fill(to); await input.press("Enter");
    await page.waitForTimeout(1500);
  };
  await rename(`C01Renamed ${stamp}`);
  out.rename = JSON.stringify({ server: (await boards()).find((b) => b.id === bd.id)?.title, sidebar: await (await findRow(page, `C01Renamed ${stamp}`)).count() });
  // Refused rename (403) — sidebar must go back to the server title.
  await page.route(`**/api/nodes/${bd.id}`, (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  await page.route(`**/api/canvases/${bd.id}`, (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  await (await findRow(page, `C01Renamed ${stamp}`)).click({ button: "right" });
  await page.locator(".ctx-menu").getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.locator(".sb-rename-input").fill(`C01Refused ${stamp}`); await page.locator(".sb-rename-input").press("Enter");
  await page.waitForTimeout(1500);
  out.rename403 = JSON.stringify({ server: (await boards()).find((b) => b.id === bd.id)?.title, sidebarRefused: await page.locator(".obsidian-page-button", { hasText: `C01Refused ${stamp}` }).count(), inputStill: await page.locator(".sb-rename-input").count(), toast: await toasts() });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  if (await page.locator(".sb-rename-input").count()) await page.locator(".sb-rename-input").press("Escape");
  // Empty title.
  await ready(page, `/?view=notes&node=${bd.id}`);
  await (await findRow(page, `C01Renamed ${stamp}`)).click({ button: "right" });
  await page.locator(".ctx-menu").getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.locator(".sb-rename-input").fill("   "); await page.locator(".sb-rename-input").press("Enter");
  await page.waitForTimeout(1500);
  out.renameBlank = JSON.stringify({ server: (await boards()).find((b) => b.id === bd.id)?.title, toast: await toasts() });
  if (await page.locator(".sb-rename-input").count()) await page.locator(".sb-rename-input").press("Escape");

  // Delete: refused first, then for real.
  await ready(page, `/?view=notes&node=${bd.id}`);
  const delRow = await findRow(page, `C01Renamed ${stamp}`);
  await page.route(`**/api/nodes/${bd.id}`, (r) => r.request().method() === "DELETE" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  await page.route(`**/api/canvases/${bd.id}`, (r) => r.request().method() === "DELETE" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  page.once("dialog", (d) => { out.deleteDialog403 = d.message(); void d.accept(); });
  await delRow.click({ button: "right" });
  await page.locator(".ctx-menu").getByRole("menuitem", { name: "Delete", exact: true }).click();
  const confirm = page.locator(".confirm-dialog");
  if (await confirm.isVisible().catch(() => false)) { out.confirmText403 = (await confirm.innerText()).replace(/\s+/g, " "); await confirm.getByRole("button", { name: /Delete|Move/ }).last().click(); }
  await page.waitForTimeout(1500);
  out.delete403 = JSON.stringify({ live: (await boards()).some((b) => b.id === bd.id), sidebar: await page.locator(".obsidian-page-button", { hasText: `C01Renamed ${stamp}` }).count(), toast: await toasts() });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await ready(page, `/?view=notes&node=${bd.id}`);
  page.once("dialog", (d) => { out.deleteDialog = d.message(); void d.accept(); });
  await (await findRow(page, `C01Renamed ${stamp}`)).click({ button: "right" });
  await page.locator(".ctx-menu").getByRole("menuitem", { name: "Delete", exact: true }).click();
  if (await confirm.isVisible().catch(() => false)) { out.confirmText = (await confirm.innerText()).replace(/\s+/g, " "); await confirm.getByRole("button", { name: /Delete|Move/ }).last().click(); }
  await page.waitForTimeout(2000);
  const memLive = async () => `${(await page.request.get(`/api/nodes/${m1.id}`)).status()}/${(await page.request.get(`/api/nodes/${m2.id}`)).status()}`;
  out.deleted = JSON.stringify({ live: (await boards()).some((b) => b.id === bd.id), members: await memLive(), url: page.url().replace(BASE, ""), main: (await page.locator("main, .notes-main").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 100) });
  // A deleted board is gone from the notes list and from the boards the server lists; undelete brings it back with its layout.
  out.listAfterDelete = String(await page.locator(".obsidian-page-button", { hasText: `C01Renamed ${stamp}` }).count());
  const und = await page.request.post(`/api/nodes/${bd.id}/undelete`, { ...H, data: {} });
  const back = await (await page.request.get(`/api/canvases/${bd.id}`)).json().catch(() => ({}));
  out.undelete = `${und.status()} nodes=${JSON.stringify((back.data?.nodes ?? []).map((n: { nodeId: string; x: number }) => `${n.nodeId === m1.id ? "m1" : n.nodeId === m2.id ? "m2" : "?"}@${n.x}`))}`;
  expect(JSON.parse(out.deleted).live, "the deleted board is not listed").toBe(false);
  expect(out.undelete, "undelete keeps both cards where they were").toBe(`200 nodes=["m1@40","m2@400"]`);

  // Phone: the Create sheet is a bottom sheet over the notes list.
  const phone = await browser.newContext({ baseURL: BASE, storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await phone.newPage();
  await ready(pp, "/?view=notes");
  const toList = pp.getByRole("button", { name: "Back to notes list", exact: true }).filter({ visible: true });
  if (await toList.count()) await toList.first().click();
  const psheet = await openCreateSheet(pp);
  const nb = psheet.getByRole("button", { name: "Create", exact: true });
  const box = await nb.boundingBox().catch(() => null);
  out.phoneSheet = JSON.stringify({ btn: box ? `${Math.round(box.width)}x${Math.round(box.height)}` : null, sw: await pp.evaluate(() => document.documentElement.scrollWidth) });
  const before = (await boards()).length;
  await nb.click();
  await pp.waitForTimeout(2500);
  out.phoneCreate = JSON.stringify({ delta: (await boards()).length - before, board: await pp.locator(".kw-canvas-wrap").isVisible().catch(() => false) });
  expect((await boards()).length - before, "the phone's Create sheet makes one board").toBe(1);
  await phone.close();
  if (created) out.cleanupNote = created.id;
  } finally {
    console.log("CAN01 " + JSON.stringify(out, null, 2));
  }
});
