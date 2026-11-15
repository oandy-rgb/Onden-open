// Feature-audit deepening (2026-10-07): COL-01 — saved views: API management
// (create / rename / delete / pin order) recorded separately from what the UI
// can reach; deleting the active and the last view; create failure and retry;
// reopen; phone viewport.
import { test, expect, type Page } from "@playwright/test";
import { ready, openSavedViewTab, BASE, H } from "./helpers";


test("COL-01: view CRUD via API vs UI, delete active/last, create failure, reopen, phone", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const out: Record<string, string> = {};
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `C01T${stamp}`, fields: [{ name: "status", type: "text" }] } })).json();
  for (const t of ["A", "B"]) {
    const n = await (await page.request.post("/api/nodes", { ...H, data: { title: `${t} ${stamp}`, markdown: t } })).json();
    await page.request.put(`/api/nodes/${n.id}/tags/${tag.id}`, { ...H, data: {} });
  }
  const base = `/api/tags/${tag.id}/views`;
  const list = async () => ((await (await page.request.get(base)).json()).views as { id: string; name: string; pin_order: number }[]);
  const names = async () => (await list()).map((v) => v.name).join(",");
  const create = async (data: unknown) => { const r = await page.request.post(base, { ...H, data }); return { s: r.status(), id: (await r.json().catch(() => ({}))).id as string }; };

  // ── API management ────────────────────────────────────────────────────
  const v1 = await create({ name: "Alpha", layout: "table" });
  const v2 = await create({ name: "Beta" });
  const v3 = await create({ name: "Pinned", pin_order: -1 });
  out.apiCreate = `${v1.s} ${v2.s} ${v3.s} order=${await names()}`;
  out.apiDupCreate = String((await create({ name: "Alpha" })).s);
  out.apiBadCreate = `empty=${(await create({ name: "" })).s} long=${(await create({ name: "x".repeat(81) })).s} layout=${(await create({ name: "L", layout: "pivot" })).s}`;
  const rename = async (id: string, name: string) => (await page.request.patch(`${base}/${id}`, { ...H, data: { name } })).status();
  out.apiRename = `${await rename(v2.id, "Beta renamed")} -> ${await names()}`;
  out.apiRenameToExisting = `${await rename(v2.id, "Alpha")} -> ${await names()}`;
  out.apiRenameEmpty = String(await rename(v2.id, ""));
  out.apiPatchMissing = String((await page.request.patch(`${base}/00000000-0000-0000-0000-000000000000`, { ...H, data: { name: "x" } })).status());
  const del = async (id: string) => (await page.request.delete(`${base}/${id}`, H)).status();
  out.apiDelete = `${await del(v3.id)} again=${await del(v3.id)} -> ${await names()}`;
  out.apiExecDeleted = String((await page.request.get(`${base}/${v3.id}/exec`)).status());

  // Another human (editor) and a viewer: who may create / delete views?
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const su = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `C01 ${stamp}`, email: `c01-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  const actor = await (await page.request.post("/api/actors", { ...H, data: { name: `C01 ${stamp}`, type: "human", external_id: su.user.id } })).json();
  out.viewerCreate = String((await human.request.post(base, { ...H, data: { name: "ByViewer" } })).status());
  out.viewerDelete = String((await human.request.delete(`${base}/${v1.id}`, H)).status());
  await page.request.patch(`/api/actors/${actor.id}`, { ...H, data: { role: "editor" } });
  const ed = await human.request.post(base, { ...H, data: { name: "ByEditor" } });
  out.editorCreate = String(ed.status());
  if (ed.ok()) out.editorDelete = String((await human.request.delete(`${base}/${(await ed.json()).id}`, H)).status());
  await human.close();

  // ── UI reachability ───────────────────────────────────────────────────
  const openViews = async (p: Page) => {
    await ready(p, `/?view=notes&node=${tag.id}`);
    await expect(p.locator(".cv-root")).toBeVisible();
    await p.waitForTimeout(600);
    // The saved views are tabs after 「全部」; with none left there is only 「全部」.
    if (await p.locator(".view-tabs [role=tab]").count() > 1) await openSavedViewTab(p);
  };
  const chips = (p: Page) => p.locator(".view-tabs [role=tab]:not(:first-child) .view-tab-name");
  await openViews(page);
  out.uiChips = JSON.stringify(await chips(page).allInnerTexts());
  out.uiActiveAfterOpen = JSON.stringify(await page.locator(".view-tab--active .view-tab-name").innerText().catch(() => "none"));
  const toolbar = page.locator(".cv-root");
  out.uiManageControls = JSON.stringify({
    rename: await toolbar.getByRole("button", { name: /rename/i }).count(),
    del: await toolbar.getByRole("button", { name: /delete|remove/i }).count(),
    pin: await toolbar.getByRole("button", { name: /pin|default/i }).count(),
    contextMenu: await (async () => { await chips(page).first().click({ button: "right" }); await page.waitForTimeout(300); return page.locator("[role=menu]").count(); })(),
    dblClickEdits: await (async () => { await chips(page).first().dblclick(); await page.waitForTimeout(300); return page.locator(".cv-toolbar input").count(); })(),
  });
  await page.keyboard.press("Escape");

  // Select Beta→"Alpha"(dup) etc: pick the second chip, reload → which is active?
  await chips(page).nth(1).click();
  await page.waitForTimeout(500);
  const picked = await page.locator(".view-tab--active .view-tab-name").innerText();
  await openViews(page);
  out.reopenActive = `picked=${picked} afterReload=${await page.locator(".view-tab--active .view-tab-name").innerText().catch(() => "none")}`;

  // Delete the ACTIVE view elsewhere (API), then interact.
  const activeName = await page.locator(".view-tab--active .view-tab-name").innerText();
  const activeId = (await list()).find((v) => v.name === activeName)!.id;
  await del(activeId);
  await page.locator('button[title="Reload query results"]').click();
  await page.waitForTimeout(800);
  out.activeDeletedElsewhere = `error=${JSON.stringify(await page.locator(".cv-error").innerText().catch(() => ""))} chips=${JSON.stringify(await chips(page).allInnerTexts())} rows=${await page.locator(".cv-table tbody tr, .cv-list-row").count()}`;

  // New view via UI: name is "View N" from the count — after a delete it can collide.
  await page.locator(".view-tab--add").click();
  await page.waitForTimeout(1000);
  out.uiNewView1 = `chips=${JSON.stringify(await chips(page).allInnerTexts())} error=${JSON.stringify(await page.locator(".cv-error").innerText().catch(() => ""))}`;
  await page.locator(".view-tab--add").click();
  await page.waitForTimeout(1000);
  out.uiNewView2 = `chips=${JSON.stringify(await chips(page).allInnerTexts())} error=${JSON.stringify(await page.locator(".cv-error").innerText().catch(() => ""))} server=${await names()}`;
  // Force a collision deterministically: server has N views, one already named "View N+1".
  const n0 = (await list()).length;
  await create({ name: `View ${n0 + 1}` });
  await openViews(page);
  const reqs: number[] = [];
  page.on("response", (r) => { if (r.request().method() === "POST" && r.url().endsWith(`/views`)) reqs.push(r.status()); });
  await page.locator(".view-tab--add").click();
  await page.waitForTimeout(1000);
  out.uiNewViewCollision = `posts=${JSON.stringify(reqs)} error=${JSON.stringify(await page.locator(".cv-error").innerText().catch(() => ""))} server=${await names()}`;
  await page.locator(".view-tab--add").click();
  await page.waitForTimeout(1000);
  out.uiNewViewCollisionRetry = `posts=${JSON.stringify(reqs)} server=${await names()}`;

  // Delete the LAST view (all of them) → reopen shows empty state, New view works.
  for (const v of await list()) await del(v.id);
  await openViews(page);
  out.allDeleted = `empty=${JSON.stringify(await page.locator(".cv-empty").allInnerTexts())} chips=${await chips(page).count()}`;
  await page.locator(".view-tab--add").click();
  await page.waitForTimeout(1000);
  out.afterAllDeletedNew = `chips=${JSON.stringify(await chips(page).allInnerTexts())} rows=${await page.locator(".cv-table tbody tr").count()}`;

  // Create failure (503) then retry: exactly one new view; error clears?
  const before = (await list()).length;
  await page.route(`**${base}`, (r) => r.request().method() === "POST" ? r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"down"}' }) : r.continue());
  await page.locator(".view-tab--add").click();
  await page.waitForTimeout(1000);
  out.create503 = `error=${JSON.stringify(await page.locator(".cv-error").innerText().catch(() => ""))} addEnabled=${await page.locator(".view-tab--add").isEnabled()} server=${(await list()).length - before}`;
  await page.unroute(`**${base}`);
  await page.locator(".view-tab--add").click();
  await page.waitForTimeout(1000);
  out.createRetry = `server+${(await list()).length - before} errorStill=${JSON.stringify(await page.locator(".cv-error").innerText().catch(() => ""))}`;

  // Offline create.
  await page.context().setOffline(true);
  await page.locator(".view-tab--add").click();
  await page.waitForTimeout(1000);
  out.createOffline = `error=${JSON.stringify(await page.locator(".cv-error").innerText().catch(() => ""))} addEnabled=${await page.locator(".view-tab--add").isEnabled()}`;
  await page.context().setOffline(false);
  await page.waitForTimeout(4000);
  out.afterReconnect = `server+${(await list()).length - before}`;

  // Phone.
  const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const pp = await phone.newPage();
  await openViews(pp);
  out.phone = JSON.stringify(await pp.evaluate(() => {
    const r = (s: string) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return `${Math.round(b.left)}..${Math.round(b.right)} h${Math.round(b.height)}`; };
    return { doc: document.documentElement.scrollWidth, toolbar: r(".view-tabs"), add: r(".view-tab--add"), chip: r(".view-tab") };
  }));
  await pp.screenshot({ path: "/tmp/pw-output/col01-phone.png", fullPage: true });
  await phone.close();
  console.log(`AUDIT COL-01 ${JSON.stringify(out, null, 1)}`);
});
