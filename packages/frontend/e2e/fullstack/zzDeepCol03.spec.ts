// Feature-audit deepening (2026-10-07): COL-03 — saved-view table: real cell
// edits per field type, rejected/failed writes keep the draft, retry without
// duplicate rows (cell + quick-add row, incl. lost response), offline, phone.
import { test, expect, type Page } from "@playwright/test";
import { ready, openSavedViewTab, clearRecoveryCopies, BASE, H } from "./helpers";


test("COL-03: table cell edits, failure keeps draft, retry no duplicate rows, offline, phone", async ({ page, browser }) => {
  test.setTimeout(260_000); // the 503 replay poll alone may wait 60 s
  const stamp = Date.now();
  const out: Record<string, string> = {};
  const tagName = `C03T${stamp}`;
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: tagName, fields: [
    { name: "status", type: "select", options: ["todo", "doing", "done"] },
    { name: "score", type: "number" },
    { name: "due", type: "date" },
    { name: "done", type: "boolean" },
    { name: "memo", type: "text" },
  ] } })).json();
  const ids: Record<string, string> = {};
  for (const t of ["Alpha", "Beta"]) {
    const n = await (await page.request.post("/api/nodes", { ...H, data: { title: `${t} ${stamp}`, markdown: t } })).json();
    await page.request.put(`/api/nodes/${n.id}/tags/${tag.id}`, { ...H, data: {} });
    ids[t] = n.id;
  }
  await page.request.post(`/api/tags/${tag.id}/views`, { ...H, data: { name: "T", layout: "table", visible_fields: ["title", "status", "score", "due", "done", "memo"] } });
  const attr = async (id: string, k: string) => ((await (await page.request.get(`/api/nodes/${id}/attributes`)).json()) as { key: string; value: string; value_type: string }[]).find((a) => a.key === k);
  const members = async () => ((await (await page.request.get(`/api/tags/${tag.id}/views`)).json()).views[0] as { id: string }).id;
  const viewId = await members();
  const execTitles = async () => ((await (await page.request.get(`/api/tags/${tag.id}/views/${viewId}/exec`)).json()).rows as { title: string }[]).map((r) => r.title);
  const puts: string[] = [];
  page.on("request", (r) => { if (r.method() === "PUT" && r.url().includes("/attributes/")) puts.push(`${r.url().split("/attributes/")[1]}=${JSON.parse(r.postData() ?? "{}").value}`); });

  const open = async (p: Page) => {
    await ready(p, `/?view=notes&node=${tag.id}`);
    await openSavedViewTab(p);
    await expect(p.locator(".cv-table")).toBeVisible();
  };
  const COL = { status: 1, score: 2, due: 3, done: 4, memo: 5 } as const;
  const cell = (p: Page, title: string, f: keyof typeof COL) =>
    p.locator(".cv-table tbody tr", { hasText: `${title} ${stamp}` }).locator("td").nth(COL[f]);
  const editCell = async (p: Page, title: string, f: keyof typeof COL, v: string, how: "Enter" | "blur") => {
    await cell(p, title, f).locator("button").click();
    const input = p.locator(".cv-table-cell-input");
    await input.fill(v);
    if (how === "Enter") await input.press("Enter"); else await p.locator(".view-tabs").click();
  };
  await open(page);

  // Real edits through each field type (the table offers one text input for all).
  puts.length = 0;
  await editCell(page, "Alpha", "score", "42", "Enter");
  await page.waitForTimeout(1200);
  out.scoreEnter = `puts=${JSON.stringify(puts)} server=${JSON.stringify(await attr(ids.Alpha, "score"))} cell=${await cell(page, "Alpha", "score").innerText()}`;
  puts.length = 0;
  await editCell(page, "Alpha", "memo", "hello", "blur");
  await page.waitForTimeout(1200);
  out.memoBlur = `puts=${JSON.stringify(puts)} server=${(await attr(ids.Alpha, "memo"))?.value}`;
  await editCell(page, "Alpha", "status", "doing", "Enter");
  await page.waitForTimeout(1000);
  out.statusValid = `server=${(await attr(ids.Alpha, "status"))?.value} inputType=text-only`;
  await editCell(page, "Alpha", "due", "2026-10-31", "Enter");
  await page.waitForTimeout(1000);
  out.dueValid = JSON.stringify(await attr(ids.Alpha, "due"));
  await editCell(page, "Alpha", "done", "true", "Enter");
  await page.waitForTimeout(1000);
  out.boolValid = JSON.stringify(await attr(ids.Alpha, "done"));
  // A text field holding digits is typed as a number by the table heuristic.
  await editCell(page, "Beta", "memo", "123", "Enter");
  await page.waitForTimeout(1000);
  out.textDigitsValueType = JSON.stringify(await attr(ids.Beta, "memo"));

  // Rejected write (422): error shown, draft stays in the input, server unchanged.
  await editCell(page, "Alpha", "status", "bogus", "Enter");
  await page.waitForTimeout(1200);
  out.reject422 = `error=${JSON.stringify(await page.locator(".cv-table-cell-error").innerText().catch(() => ""))} inputValue=${await page.locator(".cv-table-cell-input").inputValue().catch(() => "(closed)")} server=${(await attr(ids.Alpha, "status"))?.value}`;
  await page.locator(".cv-table-cell-input").press("Escape").catch(() => {});
  await page.waitForTimeout(300);
  out.after422Escape = `cell=${await cell(page, "Alpha", "status").innerText()} bogusAt=${await page.evaluate(() => [...document.querySelectorAll("body *")].filter((e) => e.children.length === 0 && (e.textContent ?? "").includes("bogus")).map((e) => `${e.tagName}.${(e as HTMLElement).className}:${(e.textContent ?? "").slice(0, 80)}`).join(" | "))}`;
  await editCell(page, "Alpha", "score", "abc", "Enter");
  await page.waitForTimeout(1000);
  out.rejectNumber = `error=${JSON.stringify(await page.locator(".cv-table-cell-error").innerText().catch(() => ""))} server=${(await attr(ids.Alpha, "score"))?.value}`;
  await page.locator(".cv-table-cell-input").press("Escape").catch(() => {});
  // Each refusal also keeps its input as a recovery card fixed over the top of
  // the table (FailedWriteRecovery); record them and clear them before clicking on.
  out.recoveryCardsAfterRejects = String(await clearRecoveryCopies(page));

  // 503 then retry: draft kept, one row per node, value lands once.
  await page.route("**/api/nodes/*/attributes/*", (r) => r.request().method() === "PUT" ? r.fulfill({ status: 503, body: '{"error":"down"}' }) : r.continue());
  await editCell(page, "Beta", "score", "7", "Enter");
  await page.waitForTimeout(2500);
  out.on503Toasts = JSON.stringify(await page.locator("[role=status], [role=alert], .toast, [class*=toast]").allInnerTexts());
  out.on503 = `error=${JSON.stringify(await page.locator(".cv-table-cell-error").innerText().catch(() => ""))} inputValue=${await page.locator(".cv-table-cell-input").inputValue().catch(() => "(closed)")} cell=${await cell(page, "Beta", "score").innerText().catch(() => "?")} server=${(await attr(ids.Beta, "score"))?.value}`;
  await page.unroute("**/api/nodes/*/attributes/*");
  puts.length = 0;
  if (await page.locator(".cv-table-cell-input").count()) await page.locator(".cv-table-cell-input").press("Enter");
  else await editCell(page, "Beta", "score", "7", "Enter");
  await page.waitForTimeout(3000);
  const t0 = Date.now();
  await expect.poll(async () => (await attr(ids.Beta, "score"))?.value ?? "", { timeout: 60_000 }).toBe("7").catch(() => {});
  out.after503Eventually = `server=${(await attr(ids.Beta, "score"))?.value} afterMs=${Date.now() - t0} cell=${await cell(page, "Beta", "score").innerText().catch(() => "?")} syncUi=${JSON.stringify(await page.locator("[class*=sync-status], [class*=syncStatus], [aria-label*=sync i]").allInnerTexts().catch(() => []))}`;
  out.after503Retry = `puts=${JSON.stringify(puts)} server=${(await attr(ids.Beta, "score"))?.value} rows=${await page.locator(".cv-table tbody tr[data-cv-row]").count()} exec=${(await execTitles()).length}`;

  // Offline cell edit.
  await page.context().setOffline(true);
  await editCell(page, "Beta", "memo", "offline-edit", "Enter");
  await page.waitForTimeout(1500);
  out.offline = `error=${JSON.stringify(await page.locator(".cv-table-cell-error").innerText().catch(() => ""))} input=${await page.locator(".cv-table-cell-input").count()} cell=${await cell(page, "Beta", "memo").innerText().catch(() => "?")}`;
  await page.context().setOffline(false);
  await page.waitForTimeout(6000);
  out.afterReconnect = `betaScore=${(await attr(ids.Beta, "score"))?.value} sync=${JSON.stringify((await page.locator("[class*=sync-status], [aria-label*=sync i]").allInnerTexts().catch(() => [])).join("/").slice(0, 80))} memo=${(await attr(ids.Beta, "memo"))?.value} cell=${await cell(page, "Beta", "memo").innerText().catch(() => "?")}`;

  // Quick-add row: normal, tag-apply 503 then retry, lost POST response then retry.
  const qa = page.locator(".cv-quickadd-input");
  await qa.fill(`Gamma ${stamp}`); await qa.press("Enter");
  await expect(cell(page, "Gamma", "status")).toBeVisible();
  out.quickAdd = `rows=${await page.locator(".cv-table tbody tr[data-cv-row]").count()} inputCleared=${(await qa.inputValue()) === ""}`;
  const countTitled = async (t: string) => ((await (await page.request.get(`/api/search?q=${encodeURIComponent(t)}`)).json().catch(() => [])) as unknown[]).length;
  void countTitled;
  const nodesTitled = async (t: string) => {
    const b = await (await page.request.get("/api/bootstrap?bodies=none")).json().catch(() => null);
    const list = (b?.nodes ?? []) as { title: string; deleted_at?: string | null }[];
    return list.filter((n) => n.title === t && !n.deleted_at).length;
  };
  await page.route(`**/api/nodes/*/tags/${tag.id}`, (r) => r.request().method() === "PUT" ? r.fulfill({ status: 503, body: '{"error":"down"}' }) : r.continue());
  await qa.fill(`Delta ${stamp}`); await qa.press("Enter");
  await page.waitForTimeout(1500);
  out.tag503 = `error=${JSON.stringify(await page.locator(".cv-quickadd-error").innerText().catch(() => ""))} kept=${await qa.inputValue()} nodes=${await nodesTitled(`Delta ${stamp}`)}`;
  await page.unroute(`**/api/nodes/*/tags/${tag.id}`);
  await qa.press("Enter");
  await page.waitForTimeout(2000);
  out.tag503Retry = `nodesTitledDelta=${await nodesTitled(`Delta ${stamp}`)} rowsDelta=${(await execTitles()).filter((t) => t === `Delta ${stamp}`).length}`;

  await page.route("**/api/nodes", async (r) => {
    if (r.request().method() !== "POST") return r.continue();
    await r.fetch(); // server commits
    await r.abort("connectionreset"); // client never sees the response
  });
  await qa.fill(`Epsilon ${stamp}`); await qa.press("Enter");
  await page.waitForTimeout(1500);
  out.lostResponse = `error=${JSON.stringify(await page.locator(".cv-quickadd-error").innerText().catch(() => ""))} kept=${await qa.inputValue()} nodes=${await nodesTitled(`Epsilon ${stamp}`)}`;
  await page.unroute("**/api/nodes");
  await qa.press("Enter");
  await page.waitForTimeout(2000);
  out.lostResponseRetry = `nodesTitledEpsilon=${await nodesTitled(`Epsilon ${stamp}`)} rowsEpsilon=${(await execTitles()).filter((t) => t === `Epsilon ${stamp}`).length}`;

  // Phone viewport.
  const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const pp = await phone.newPage();
  await open(pp);
  const geo = await pp.evaluate(() => {
    const w = document.querySelector(".cv-table-wrap") as HTMLElement | null;
    const btn = document.querySelector(".cv-table-cell-edit") as HTMLElement | null;
    return { doc: document.documentElement.scrollWidth, wrapClient: w?.clientWidth, wrapScroll: w?.scrollWidth, wrapOverflowX: w ? getComputedStyle(w).overflowX : null, cellBtnH: btn ? Math.round(btn.getBoundingClientRect().height) : null };
  });
  out.phoneGeo = JSON.stringify(geo);
  await cell(pp, "Gamma", "memo").locator("button").scrollIntoViewIfNeeded();
  await cell(pp, "Gamma", "memo").locator("button").tap().catch(async () => cell(pp, "Gamma", "memo").locator("button").click());
  await pp.locator(".cv-table-cell-input").fill("phone");
  await pp.locator(".cv-table-cell-input").press("Enter");
  await pp.waitForTimeout(1500);
  const gammaId = ((await (await pp.request.get(`/api/tags/${tag.id}/views/${viewId}/exec`)).json()).rows as { id: string; title: string }[]).find((r) => r.title === `Gamma ${stamp}`)?.id ?? "";
  out.phoneEdit = `server=${(await attr(gammaId, "memo"))?.value}`;
  await pp.screenshot({ path: "/tmp/pw-output/col03-phone.png", fullPage: true });
  await phone.close();
  console.log(`AUDIT COL-03 ${JSON.stringify(out, null, 1)}`);
});
