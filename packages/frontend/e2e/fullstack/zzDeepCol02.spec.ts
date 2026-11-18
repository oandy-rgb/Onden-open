// Feature-audit deepening (2026-10-07): COL-02 — saved-view config: multi-column
// sort, compound filters, partial PATCH keeps other settings, UI builder,
// offline edit and rejected PATCH, phone viewport.
import { test, expect, type Page } from "@playwright/test";
import { ready, openSavedViewTab, BASE, H } from "./helpers";


test("COL-02: multi-sort, compound filter, partial PATCH, builder offline/503, phone", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const out: Record<string, string> = {};
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `C02T${stamp}`, fields: [
    { name: "status", type: "select", options: ["todo", "doing", "done"] },
    { name: "score", type: "number" },
  ] } })).json();
  const seed: [string, string, string | null][] = [
    ["A", "todo", "3"], ["B", "todo", "10"], ["C", "doing", "7"], ["D", "done", "1"], ["E", "todo", null], ["F", "doing", "7"],
  ];
  for (const [t, s, sc] of seed) {
    const n = await (await page.request.post("/api/nodes", { ...H, data: { title: `${t} ${stamp}`, markdown: t } })).json();
    await page.request.put(`/api/nodes/${n.id}/tags/${tag.id}`, { ...H, data: {} });
    await page.request.put(`/api/nodes/${n.id}/attributes/status`, { ...H, data: { value: s, value_type: "text" } });
    if (sc) await page.request.put(`/api/nodes/${n.id}/attributes/score`, { ...H, data: { value: sc, value_type: "number" } });
  }
  const view = await (await page.request.post(`/api/tags/${tag.id}/views`, { ...H, data: { name: "V1", layout: "table", visible_fields: ["title", "status", "score"] } })).json();
  const vPath = `/api/tags/${tag.id}/views/${view.id}`;
  const exec = async () => ((await (await page.request.get(`${vPath}/exec`)).json()).rows as { title: string }[]).map((r) => r.title[0]).join("");
  const getView = async () => ((await (await page.request.get(`/api/tags/${tag.id}/views`)).json()).views as Record<string, unknown>[]).find((v) => v.id === view.id)!;
  const patch = async (data: unknown) => (await page.request.patch(vPath, { ...H, data })).status();

  // API: multi-sort status asc, score desc (score is typed numeric: 10 before 3).
  out.multiSort = `${await patch({ sorts: [{ field: "status", dir: "asc" }, { field: "score", dir: "desc" }] })} ${await exec()}`;
  out.multiSortTitleTiebreak = `${await patch({ sorts: [{ field: "score", dir: "desc" }, { field: "title", dir: "desc" }] })} ${await exec()}`;
  // Compound filter (AND): status ne done AND score nempty AND title contains stamp.
  out.compound = `${await patch({ filters: [{ field: "status", op: "ne", value: "done" }, { field: "score", op: "nempty" }, { field: "title", op: "contains", value: String(stamp) }] })} ${await exec()}`;
  out.compoundGt = `${await patch({ filters: [{ field: "score", op: "gt", value: "5" }, { field: "status", op: "eq", value: "doing" }] })} ${await exec()}`;
  // Partial PATCH must not reset other keys.
  await patch({ layout: "kanban" });
  await patch({ pin_order: 3 });
  const v1 = await getView();
  out.partialKeeps = JSON.stringify({ layout: v1.layout, sorts: v1.sorts, filters: (v1.filters as unknown[]).length, visible: v1.visible_fields, pin: v1.pin_order });
  // Rejections.
  out.badOp = String(await patch({ filters: [{ field: "status", op: "regex", value: "x" }] }));
  out.badLayout = String(await patch({ layout: "pivot" }));
  out.badSortDir = String(await patch({ sorts: [{ field: "title", dir: "sideways" }] }));
  out.unknownSortField = `${await patch({ sorts: [{ field: "no_such_field", dir: "asc" }] })} ${await exec()}`;
  const v2 = await getView();
  out.afterRejectsLayout = String(v2.layout);
  // Reset for the UI part.
  await patch({ layout: "table", filters: [], sorts: [] });

  // UI builder.
  const openViews = async (p: Page) => {
    await ready(p, `/?view=notes&node=${tag.id}`);
    await openSavedViewTab(p);
    await expect(p.locator(".cv-table")).toBeVisible();
    // The builder is an item of the view's 「View options」 menu (CollectionView), not a toolbar button of its own.
    await p.getByRole("button", { name: "View options", exact: true }).click();
    await p.getByRole("menuitem", { name: "Filter, sort and group this view", exact: true }).click();
    await expect(p.locator(".cv-builder")).toBeVisible();
  };
  await openViews(page);
  const tableOrder = async (p: Page) => (await p.locator(".cv-table tbody tr .cv-table-title").allInnerTexts()).map((t) => t[0]).join("");
  out.uiInitial = await tableOrder(page);
  const sortGroup = page.locator(".cv-builder-group").nth(1);
  await sortGroup.getByRole("button", { name: "Add sort" }).click();
  await sortGroup.locator(".cv-builder-row").nth(0).locator("select").first().selectOption("status");
  await sortGroup.getByRole("button", { name: "Add sort" }).click();
  await sortGroup.locator(".cv-builder-row").nth(1).locator("select").first().selectOption("score");
  await sortGroup.locator(".cv-builder-row").nth(1).locator("select").nth(1).selectOption("desc");
  await expect.poll(async () => JSON.stringify((await getView()).sorts), { timeout: 10_000 }).toContain("desc");
  await page.waitForTimeout(800);
  out.uiMultiSortServer = JSON.stringify((await getView()).sorts);
  out.uiMultiSortTable = await tableOrder(page);

  // Compound filter via UI: status is not done + score is not empty.
  const filterGroup = page.locator(".cv-builder-group").nth(0);
  await filterGroup.getByRole("button", { name: "Add filter" }).click();
  const f0 = filterGroup.locator(".cv-builder-row").nth(0);
  await f0.locator("select").first().selectOption("status");
  await f0.locator("select").nth(1).selectOption("ne");
  await f0.locator("input").fill("done");
  await filterGroup.getByRole("button", { name: "Add filter" }).click();
  const f1 = filterGroup.locator(".cv-builder-row").nth(1);
  await f1.locator("select").first().selectOption("score");
  await f1.locator("select").nth(1).selectOption("nempty");
  await page.waitForTimeout(1500);
  out.uiCompoundServer = JSON.stringify((await getView()).filters);
  out.uiCompoundTable = await tableOrder(page);

  // Filter then sort within the 400 ms debounce: does the filter change survive?
  await f1.locator(".cv-builder-del").click();          // remove the score filter (filters PATCH pending)
  out.quickAfterFilterDel = `uiFilters=${await filterGroup.locator(".cv-builder-row").count()}`;
  const patches: string[] = [];
  page.on("request", (r) => { if (r.method() === "PATCH" && r.url().includes("/views/")) patches.push(r.postData() ?? ""); });
  await sortGroup.locator(".cv-builder-row").nth(1).locator(".cv-builder-del").click(); // remove score sort (sorts PATCH) within debounce
  await page.waitForTimeout(1500);
  const v3 = await getView();
  out.quickPatchBodies = JSON.stringify(patches);
  out.quickSuccession = `filters=${(v3.filters as unknown[]).length} sorts=${(v3.sorts as unknown[]).length} (UI shows filters=${await filterGroup.locator(".cv-builder-row").count()} sorts=${await sortGroup.locator(".cv-builder-row").count()})`;
  await page.reload(); await openViews(page);
  out.quickSuccessionAfterReload = `filters=${await page.locator(".cv-builder-group").nth(0).locator(".cv-builder-row").count()} sorts=${await page.locator(".cv-builder-group").nth(1).locator(".cv-builder-row").count()}`;

  // Rejected PATCH (503): status text, local state, server state, then recovery.
  const before503 = JSON.stringify(await getView());
  await page.route(`**/api/tags/${tag.id}/views/${view.id}`, (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 503, body: '{"error":"down"}' }) : r.continue());
  const sg = page.locator(".cv-builder-group").nth(1);
  await sg.getByRole("button", { name: "Add sort" }).click();
  await page.waitForTimeout(1200);
  out.on503 = `status=${JSON.stringify(await page.locator(".cv-builder-status").innerText())} uiSorts=${await sg.locator(".cv-builder-row").count()} serverUnchanged=${JSON.stringify(await getView()) === before503} toasts=${JSON.stringify(await page.locator("[role=status], .toast").allInnerTexts())}`;
  await page.unroute(`**/api/tags/${tag.id}/views/${view.id}`);
  await sg.locator(".cv-builder-row").last().locator("select").nth(1).selectOption("desc");
  await page.waitForTimeout(1200);
  out.after503Retry = `status=${JSON.stringify(await page.locator(".cv-builder-status").innerText())} serverSorts=${JSON.stringify((await getView()).sorts)}`;

  // Offline edit.
  const sortsBeforeOffline = JSON.stringify((await getView()).sorts);
  await page.context().setOffline(true);
  await sg.locator(".cv-builder-row").last().locator(".cv-builder-del").click();
  await page.waitForTimeout(1500);
  out.offline = `status=${JSON.stringify(await page.locator(".cv-builder-status").innerText())} uiSorts=${await sg.locator(".cv-builder-row").count()}`;
  await page.context().setOffline(false);
  await page.waitForTimeout(4000);
  out.afterReconnect = `serverSorts=${JSON.stringify((await getView()).sorts)} sameAsBeforeOffline=${JSON.stringify((await getView()).sorts) === sortsBeforeOffline} uiSorts=${await sg.locator(".cv-builder-row").count()} status=${JSON.stringify(await page.locator(".cv-builder-status").innerText())}`;
  await page.reload(); await openViews(page);
  out.offlineAfterReload = `uiSorts=${await page.locator(".cv-builder-group").nth(1).locator(".cv-builder-row").count()}`;

  // Phone viewport.
  const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const pp = await phone.newPage();
  await openViews(pp);
  const boxes = await pp.evaluate(() => {
    const r = (s: string) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return `${Math.round(b.left)}..${Math.round(b.right)}`; };
    return { doc: document.documentElement.scrollWidth, toolbar: r(".view-tabs"), builder: r(".cv-builder"), table: r(".cv-table-wrap"), addSortH: Math.round(document.querySelector(".cv-builder-add")?.getBoundingClientRect().height ?? 0) };
  });
  out.phone = JSON.stringify(boxes);
  await pp.screenshot({ path: "/tmp/pw-output/col02-phone.png", fullPage: true });
  await phone.close();
  console.log(`AUDIT COL-02 ${JSON.stringify(out, null, 1)}`);
});
