// Feature-audit deepening (2026-10-07): COL-05 — the saved-view Board (kanban):
// real HTML5 drag between columns, keyboard "Move to column", only the group
// field changes, unknown (stale) and empty groups, empty declared stages,
// moving to "No value", rejected/failed moves, no group field, phone.
import { test, expect, type Page } from "@playwright/test";
import { ready, openSavedViewTab, clearRecoveryCopies, BASE, H } from "./helpers";


test("COL-05: board drag, keyboard move, unknown/empty groups, rejection, phone", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, string> = {};
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `C05T${stamp}`, fields: [
    { name: "stage", type: "select", options: ["todo", "doing", "review", "done"] },
    { name: "score", type: "number" },
  ] } })).json();
  const mk = async (title: string, stage?: string, score?: string) => {
    const n = await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: `${title} body` } })).json();
    await page.request.put(`/api/nodes/${n.id}/tags/${tag.id}`, { ...H, data: {} });
    if (stage !== undefined) out[`seed_${title.split(" ")[0]}`] = String((await page.request.put(`/api/nodes/${n.id}/attributes/stage`, { ...H, data: { value: stage, value_type: "text" } })).status());
    if (score !== undefined) await page.request.put(`/api/nodes/${n.id}/attributes/score`, { ...H, data: { value: score, value_type: "number" } });
    return n.id as string;
  };
  const idA = await mk(`Alpha ${stamp}`, "todo", "3");
  const idB = await mk(`Beta ${stamp}`, "done", "0");
  const idN = await mk(`Nobody ${stamp}`);           // no stage
  // A stale value: put "legacy" while it is still an option, then drop the option.
  await page.request.patch(`/api/tags/${tag.id}/schema`, { ...H, data: { fields: [
    { name: "stage", type: "select", options: ["todo", "doing", "review", "done", "legacy"] }, { name: "score", type: "number" } ] } }).catch(() => null);
  const idL = await mk(`Legacy ${stamp}`, "legacy");
  const schemaRes = await page.request.patch(`/api/tags/${tag.id}/schema`, { ...H, data: { fields: [
    { name: "stage", type: "select", options: ["todo", "doing", "review", "done"] }, { name: "score", type: "number" } ] } }).catch(() => null);
  out.schemaPatch = String(schemaRes?.status());
  const attrs = async (id: string) => Object.fromEntries(((await (await page.request.get(`/api/nodes/${id}/attributes`)).json()) as Array<{ key: string; value: string }>).map((a) => [a.key, a.value]));
  out.legacySeed = JSON.stringify(await attrs(idL));

  const view = await (await page.request.post(`/api/tags/${tag.id}/views`, { ...H, data: { name: "B", layout: "kanban", group_by: "stage", visible_fields: ["title", "stage", "score"] } })).json();
  const vPath = `/api/tags/${tag.id}/views/${view.id}`;
  const openBoard = async (p: Page) => {
    await ready(p, `/?view=notes&node=${tag.id}`);
    await openSavedViewTab(p);
    await expect(p.locator(".cv-root")).toBeVisible();
    await p.waitForTimeout(800);
  };
  const cols = (p: Page) => p.locator(".cv-kanban-col");
  const colOf = (p: Page, label: string) => cols(p).filter({ has: p.locator(".cv-kanban-col-title", { hasText: new RegExp(`^${label}$`) }) });
  const layoutState = async (p: Page) => JSON.stringify(await cols(p).evaluateAll((els) => els.map((c) => ({
    col: (c.querySelector(".cv-kanban-col-title") as HTMLElement).innerText,
    n: (c.querySelector(".cv-kanban-col-count") as HTMLElement).innerText,
    cards: Array.from(c.querySelectorAll(".cv-kanban-card-title")).map((b) => (b as HTMLElement).innerText.split(" ")[0]),
  }))));
  const beforeNode = await (await page.request.get(`/api/nodes/${idA}`)).json();

  try {
    await openBoard(page);
    await expect(cols(page).first()).toBeVisible();
    out.initial = await layoutState(page);
    out.emptyStagesShown = String(await colOf(page, "doing").count()) + "/" + String(await colOf(page, "review").count());
    out.moveOptionsAlpha = JSON.stringify(await page.locator(".cv-kanban-card", { hasText: `Alpha ${stamp}` }).locator("select option").allInnerTexts());

    // Real drag: Alpha todo → done.
    await page.locator(".cv-kanban-card", { hasText: `Alpha ${stamp}` }).dragTo(colOf(page, "done"));
    await expect.poll(async () => (await attrs(idA)).stage, { timeout: 10_000 }).toBe("done");
    await page.waitForTimeout(800);
    out.afterDrag = await layoutState(page);
    const afterNode = await (await page.request.get(`/api/nodes/${idA}`)).json();
    out.onlyGroupChanged = JSON.stringify({ attrs: await attrs(idA), title: afterNode.title === beforeNode.title, body: (afterNode.markdown ?? afterNode.body) === (beforeNode.markdown ?? beforeNode.body) });
    out.otherCardUntouched = JSON.stringify(await attrs(idB));

    // Drag onto the same column → no write.
    let puts = 0;
    page.on("request", (r) => { if (r.method() === "PUT" && r.url().includes("/attributes/")) puts++; });
    await page.locator(".cv-kanban-card", { hasText: `Beta ${stamp}` }).dragTo(colOf(page, "done"));
    await page.waitForTimeout(800);
    out.sameColumnPuts = String(puts);

    // Beta → "No value" by drag (clears the field) while that column exists.
    const putNo = page.waitForResponse((r) => r.url().includes(`/api/nodes/${idB}/attributes/stage`), { timeout: 8000 }).catch(() => null);
    await page.locator(".cv-kanban-card", { hasText: `Beta ${stamp}` }).dragTo(colOf(page, "No value"));
    const r0 = await putNo;
    await page.waitForTimeout(1000);
    out.toNoValue = `status=${r0?.status()} req=${r0?.request().method()} body=${r0?.request().postData()} serverAttrs=${JSON.stringify(await attrs(idB))} err=${JSON.stringify(await page.locator(".cv-error").innerText().catch(() => ""))}`;
    out.afterNoValue = await layoutState(page);

    // Keyboard path: Nobody (No value) → done via the select. Which targets are offered?
    const sel = page.locator(".cv-kanban-card", { hasText: `Nobody ${stamp}` }).locator("select");
    out.moveOptionsNobody = JSON.stringify(await sel.locator("option").allInnerTexts());
    await sel.focus();
    await sel.selectOption({ label: "done" });
    await expect.poll(async () => (await attrs(idN)).stage, { timeout: 10_000 }).toBe("done");
    await page.waitForTimeout(800);
    out.afterKeyboard = await layoutState(page);
    out.todoReachable = `drag-target=${await colOf(page, "todo").count()} option=${(await page.locator(".cv-kanban-card select").first().locator("option").allInnerTexts()).includes("todo")}`;

    // Move Alpha INTO the stale "legacy" column (no longer a declared option).
    const toLegacy = page.waitForResponse((r) => r.url().includes(`/api/nodes/${idA}/attributes/stage`), { timeout: 8000 }).catch(() => null);
    await page.locator(".cv-kanban-card", { hasText: `Alpha ${stamp}` }).dragTo(colOf(page, "legacy"));
    const r1 = await toLegacy;
    await page.waitForTimeout(1200);
    out.intoStale = `status=${r1?.status()} resp=${(await r1?.text().catch(() => ""))?.slice(0, 120)} server=${(await attrs(idA)).stage} err=${JSON.stringify(await page.locator(".cv-error").innerText().catch(() => ""))}`;
    out.afterIntoStale = await layoutState(page);
    // The refusal also keeps its input as a recovery card fixed over the top of
    // the page (FailedWriteRecovery); it would cover the view chips below.
    out.recoveryCardsAfterStale = String(await clearRecoveryCopies(page));

    // Failure: the attribute PUT returns 503.
    await openBoard(page);
    const s503 = await layoutState(page);
    out.before503 = s503;
    await page.route("**/api/nodes/*/attributes/stage", (r) => r.request().method() === "PUT" ? r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"down"}' }) : r.continue());
    const mover = (await attrs(idL)).stage === "legacy" ? idL : idA;
    const moverTitle = mover === idL ? `Legacy ${stamp}` : `Alpha ${stamp}`;
    await page.locator(".cv-kanban-card", { hasText: moverTitle }).dragTo(colOf(page, "done"));
    await page.waitForTimeout(1500);
    out.on503 = `mover=${moverTitle.split(" ")[0]} server=${(await attrs(mover)).stage} err=${JSON.stringify(await page.locator(".cv-error").innerText().catch(() => ""))}`;
    out.afterOn503 = await layoutState(page);
    out.syncIndicator = JSON.stringify((await page.locator("body").innerText()).match(/\d+ change\(s\)[^\n]*|Waiting to sync[^\n]*|saved locally[^\n]*|offline[^\n]*/i)?.[0] ?? null);
    await page.unroute("**/api/nodes/*/attributes/stage");
    await page.waitForTimeout(8000);
    out.after503Unroute8s = `server=${(await attrs(mover)).stage} board=${await layoutState(page)}`;
    await openBoard(page);
    out.after503Reopen = await layoutState(page);

    // Failure: 403 (permanent rejection) on a select move.
    await page.route("**/api/nodes/*/attributes/stage", (r) => r.request().method() === "PUT" ? r.fulfill({ status: 403, contentType: "application/json", body: '{"error":"forbidden"}' }) : r.continue());
    const card403 = page.locator(".cv-kanban-card").first();
    const t403 = (await card403.locator(".cv-kanban-card-title").innerText()).split(" ")[0];
    const opts403 = await card403.locator("select option").allInnerTexts();
    const cur403 = await card403.locator("select").inputValue();
    const pick403 = opts403.find((o) => o.toLowerCase() !== cur403.toLowerCase());
    if (pick403) {
      await card403.locator("select").selectOption({ label: pick403 });
      await page.waitForTimeout(1500);
    }
    out.on403 = `card=${t403} to=${pick403} err=${JSON.stringify(await page.locator(".cv-error").innerText().catch(() => ""))} board=${await layoutState(page)}`;
    await page.unroute("**/api/nodes/*/attributes/stage");
    out.recoveryCardsAfter403 = String(await clearRecoveryCopies(page));

    // No group field.
    const v2 = await (await page.request.post(`/api/tags/${tag.id}/views`, { ...H, data: { name: "NoGroup", layout: "kanban", visible_fields: ["title"] } })).json();
    await openBoard(page);
    await page.locator(".view-tab", { has: page.locator(".view-tab-name", { hasText: /^NoGroup$/ }) }).click();
    await page.waitForTimeout(800);
    out.noGroupMsg = JSON.stringify(await page.locator(".cv-empty").allInnerTexts());
    await page.request.delete(`/api/tags/${tag.id}/views/${v2.id}`);

    // Phone.
    const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE, hasTouch: true, isMobile: true });
    const pp = await phone.newPage();
    await openBoard(pp);
    out.phone = JSON.stringify(await pp.evaluate(() => {
      const board = document.querySelector(".cv-kanban") as HTMLElement | null;
      const sel = document.querySelector(".cv-kanban-move-select") as HTMLElement | null;
      const labelVisible = (() => { const l = document.querySelector(".cv-kanban-move-label") as HTMLElement | null; if (!l) return null; const r = l.getBoundingClientRect(); return r.width > 2 && r.height > 2; })();
      return { doc: document.documentElement.scrollWidth, win: innerWidth, boardScrollW: board?.scrollWidth, boardClientW: board?.clientWidth, cols: document.querySelectorAll(".cv-kanban-col").length, selectH: sel ? Math.round(sel.getBoundingClientRect().height) : null, moveLabelVisible: labelVisible };
    }));
    const psel = pp.locator(".cv-kanban-card", { hasText: `Alpha ${stamp}` }).locator("select");
    const curA = (await attrs(idA)).stage;
    const target = curA === "review" ? "doing" : "review";
    const canPick = (await psel.locator("option").allInnerTexts()).includes(target);
    out.phoneMoveTarget = `${target} offered=${canPick}`;
    const fallback = (await psel.locator("option").allInnerTexts()).find((o) => o !== curA) ?? "No value";
    out.phoneOptions = JSON.stringify(await psel.locator("option").allInnerTexts());
    await psel.selectOption({ label: canPick ? target : fallback });
    await page.waitForTimeout(1500);
    out.phoneMoved = `server=${(await attrs(idA)).stage}`;
    await pp.screenshot({ path: "/tmp/pw-output/col05-phone.png", fullPage: true });
    await phone.close();
    void vPath;
  } finally {
    console.log(`AUDIT COL-05 ${JSON.stringify(out, null, 1)}`);
  }
});
