// Feature-audit deepening (2026-10-07): COL-05 — the saved-view Board (kanban):
// real HTML5 drag between columns, keyboard "Move to column", only the group
// field changes, unknown (stale) and empty groups, empty declared stages,
// moving to "No value", rejected/failed moves, no group field, phone.
//
// 2026-11-18: every observation the probe printed is a check now (owner's order 「都改成檢查」). Columns are checked by name (never the
// whole board) because the workspace is shared. The rules: groupRows.ts (declared options first in their order, a stale value after
// them, 「No value」 last, cards in the view's title order), KanbanLayout.tsx (one attribute write per move, a move to the column it is
// in writes nothing, 「No value」 clears the field), full-feature-audit.md COL-05 and GAP-155 / GAP-126.
import { test, expect, type Page } from "@playwright/test";
import { ready, openSavedViewTab, clearRecoveryCopies, BASE, H } from "./helpers";
import { contextsClosedAfterEach, clickableSize } from "./viewChecks";

// Every extra browser context a test opens is closed when the test ends, also when it stops at a failing line (see viewChecks.ts).
const newContext = contextsClosedAfterEach(test);

const QUEUED_5XX = "Still trying — your changes are safe on this device. The server answered with an error."; // components/SyncStatus.tsx

async function setUp(page: Page) {
  const stamp = Date.now();
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `C05T${stamp}`, fields: [
    { name: "stage", type: "select", options: ["todo", "doing", "review", "done"] },
    { name: "score", type: "number" },
  ] } })).json();
  const mk = async (title: string, stage?: string, score?: string) => {
    const n = await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: `${title} body` } })).json();
    await page.request.put(`/api/nodes/${n.id}/tags/${tag.id}`, { ...H, data: {} });
    if (stage !== undefined) expect((await page.request.put(`/api/nodes/${n.id}/attributes/stage`, { ...H, data: { value: stage, value_type: "text" } })).status()).toBe(200);
    if (score !== undefined) await page.request.put(`/api/nodes/${n.id}/attributes/score`, { ...H, data: { value: score, value_type: "number" } });
    return n.id as string;
  };
  const idA = await mk(`Alpha ${stamp}`, "todo", "3");
  const idB = await mk(`Beta ${stamp}`, "done", "0");
  const idN = await mk(`Nobody ${stamp}`); // no stage
  // A stale value: put "legacy" while it is still an option, then drop the option from the schema.
  const fields = (options: string[]) => ({ fields: [{ name: "stage", type: "select", options }, { name: "score", type: "number" }] });
  expect((await page.request.patch(`/api/tags/${tag.id}/schema`, { ...H, data: fields(["todo", "doing", "review", "done", "legacy"]) })).status()).toBe(200);
  const idL = await mk(`Legacy ${stamp}`, "legacy");
  expect((await page.request.patch(`/api/tags/${tag.id}/schema`, { ...H, data: fields(["todo", "doing", "review", "done"]) })).status()).toBe(200);
  const attrs = async (id: string) => Object.fromEntries(((await (await page.request.get(`/api/nodes/${id}/attributes`)).json()) as Array<{ key: string; value: string }>).map((a) => [a.key, a.value]));
  await page.request.post(`/api/tags/${tag.id}/views`, { ...H, data: { name: "B", layout: "kanban", group_by: "stage", visible_fields: ["title", "stage", "score"] } });

  const openBoard = async (p: Page) => {
    await ready(p, `/?view=notes&node=${tag.id}`);
    await openSavedViewTab(p);
    await expect(p.locator(".cv-kanban")).toBeVisible();
    await expect(p.locator(".cv-kanban-card").first()).toBeVisible();
  };
  const cols = (p: Page) => p.locator(".cv-kanban-col");
  const colOf = (p: Page, label: string) => cols(p).filter({ has: p.locator(".cv-kanban-col-title", { hasText: new RegExp(`^${label}$`) }) });
  // Column label -> the first words of the cards in it (raw text: the headings are upper-cased only by CSS).
  const board = async (p: Page) => p.locator(".cv-kanban-col").evaluateAll((els) => Object.fromEntries(els.map((c) => [
    c.querySelector(".cv-kanban-col-title")!.textContent!,
    Array.from(c.querySelectorAll(".cv-kanban-card-title")).map((b) => b.textContent!.split(" ")[0]),
  ])));
  const card = (p: Page, title: string) => p.locator(".cv-kanban-card", { hasText: `${title} ${stamp}` });
  return { stamp, tag, idA, idB, idN, idL, attrs, openBoard, cols, colOf, board, card };
}

test.describe("COL-05: saved-view board", () => {
  test.setTimeout(240_000);

  test("drag, keyboard move, no value, stale column, rejection, no group field, phone", async ({ page, browser }) => {
    const { stamp, tag, idA, idB, idN, idL, attrs, openBoard, colOf, board, card } = await setUp(page);
    const beforeNode = await (await page.request.get(`/api/nodes/${idA}`)).json();
    expect(await attrs(idL)).toEqual({ stage: "legacy" }); // the schema dropped the option, the value stays on the note
    await openBoard(page);

    // The columns in the order groupRows.ts gives: the declared stages in their order, then a value the schema no longer has, then 「No value」;
    // the cards of a column in the view's own order (title). (A stage no card is in gets no column today: see the FINDING tests below.)
    await expect.poll(() => board(page)).toMatchObject({ todo: [`Alpha`], done: [`Beta`], legacy: [`Legacy`], "No value": [`Nobody`] });
    const headings = await page.locator(".cv-kanban-col-title").allTextContents();
    expect(headings.indexOf("todo")).toBeLessThan(headings.indexOf("done")); // declared order, however the rows arrive
    expect(headings.indexOf("done")).toBeLessThan(headings.indexOf("legacy")); // a stale value after the declared ones
    expect(headings.at(-1)).toBe("No value"); // the empty bucket last
    // The keyboard path offers exactly the columns the board has, in its order (KanbanLayout.tsx: the select's options are `columns`).
    expect(await card(page, "Alpha").locator("select option").allTextContents()).toEqual(headings);

    // Real drag: Alpha todo → done. One attribute write: only the group field changes (KanbanLayout.tsx header; COL-05 in full-feature-audit.md).
    await card(page, "Alpha").dragTo(colOf(page, "done"));
    await expect.poll(async () => (await attrs(idA)).stage, { timeout: 10_000 }).toBe("done");
    await expect.poll(() => board(page)).toMatchObject({ done: ["Alpha", "Beta"], legacy: ["Legacy"], "No value": ["Nobody"] });
    const afterNode = await (await page.request.get(`/api/nodes/${idA}`)).json();
    expect(await attrs(idA)).toEqual({ score: "3", stage: "done" });
    expect(afterNode.title).toBe(beforeNode.title);
    expect(afterNode.markdown ?? afterNode.body).toBe(beforeNode.markdown ?? beforeNode.body);
    expect(await attrs(idB)).toEqual({ score: "0", stage: "done" }); // the other card is untouched

    // Drag onto the column the card is in → no write (KanbanLayout.tsx moveCard: 「already in this column — no-op」).
    let puts = 0;
    page.on("request", (r) => { if (r.method() === "PUT" && r.url().includes("/attributes/")) puts++; });
    await card(page, "Beta").dragTo(colOf(page, "done"));
    await expect(card(page, "Beta")).toBeVisible();
    expect(puts).toBe(0);

    // Beta → 「No value」 by drag clears the field: PUT with an empty value, and the card joins that column (KanbanLayout.tsx: 「delete-shaped write of ""」).
    const putNo = page.waitForResponse((r) => r.url().includes(`/api/nodes/${idB}/attributes/stage`));
    await card(page, "Beta").dragTo(colOf(page, "No value"));
    const r0 = await putNo;
    expect(r0.status()).toBe(200);
    expect(r0.request().method()).toBe("PUT");
    expect(JSON.parse(r0.request().postData()!).value).toBe("");
    expect((await attrs(idB)).stage).toBe("");
    await expect(page.locator(".cv-error")).toHaveCount(0);
    await expect.poll(() => board(page)).toMatchObject({ done: ["Alpha"], legacy: ["Legacy"], "No value": ["Beta", "Nobody"] });

    // Keyboard path: Nobody (No value) → done through its select; the options are the board's columns.
    const sel = card(page, "Nobody").locator("select");
    expect(await sel.locator("option").allTextContents()).toEqual(await page.locator(".cv-kanban-col-title").allTextContents());
    await sel.focus();
    await sel.selectOption({ label: "done" });
    await expect.poll(async () => (await attrs(idN)).stage, { timeout: 10_000 }).toBe("done");
    await expect.poll(() => board(page)).toMatchObject({ done: ["Alpha", "Nobody"], legacy: ["Legacy"], "No value": ["Beta"] });

    // Move Alpha INTO the stale 「legacy」 column (no longer a declared option): the server refuses (422), the reason is said, the card stays
    // where it was and the refused move is kept in a recovery card (COL-05: 「拖入時伺服器 422 並顯示『must be one of…』、卡片留原位」).
    const toLegacy = page.waitForResponse((r) => r.url().includes(`/api/nodes/${idA}/attributes/stage`));
    await card(page, "Alpha").dragTo(colOf(page, "legacy"));
    const r1 = await toLegacy;
    expect(r1.status()).toBe(422);
    await expect(page.locator(".cv-error")).toHaveText('"stage" must be one of: todo, doing, review, done');
    expect((await attrs(idA)).stage).toBe("done");
    await expect.poll(() => board(page)).toMatchObject({ done: ["Alpha", "Nobody"], legacy: ["Legacy"], "No value": ["Beta"] });
    expect(await clearRecoveryCopies(page)).toBe(1); // the move carried a value ("legacy"), so it is kept for recovery; the card would cover the view chips below

    // Failure: the attribute PUT returns 503 → the write is queued (writeErrors.ts: any 5xx is retryable): said once by the sync status,
    // no error on the board, nothing on the server yet; when the connection is back it lands and the board agrees with the server.
    // (That the card does not move meanwhile is the FINDING below.)
    await openBoard(page);
    await page.route("**/api/nodes/*/attributes/stage", (r) => r.request().method() === "PUT" ? r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"down"}' }) : r.continue());
    await card(page, "Legacy").dragTo(colOf(page, "done"));
    await expect(page.getByText(QUEUED_5XX)).toHaveCount(1);
    await expect(page.locator(".cv-error")).toHaveCount(0);
    expect((await attrs(idL)).stage).toBe("legacy");
    await page.unroute("**/api/nodes/*/attributes/stage");
    await page.context().setOffline(true); // a reconnect makes the queue send what it holds
    await page.context().setOffline(false);
    await expect.poll(async () => (await attrs(idL)).stage, { timeout: 30_000 }).toBe("done");
    await openBoard(page);
    await expect.poll(() => board(page)).toMatchObject({ done: ["Alpha", "Legacy", "Nobody"], "No value": ["Beta"] });
    expect((await board(page)).legacy).toBeUndefined(); // no card holds the stale value any more: no column

    // Failure: 403 (a permanent refusal) on a select move: the permission sentence (lib/serverErrors.ts), the card stays, nothing changed.
    // The probe picked the option the card was already in, so it never sent anything (the select's value is a column key, not its label).
    await page.route("**/api/nodes/*/attributes/stage", (r) => r.request().method() === "PUT" ? r.fulfill({ status: 403, contentType: "application/json", body: '{"error":"forbidden"}' }) : r.continue());
    await card(page, "Alpha").locator("select").selectOption({ label: "No value" });
    await expect(page.locator(".cv-error")).toHaveText("You don't have permission to do that.");
    expect((await attrs(idA)).stage).toBe("done");
    await expect.poll(() => board(page)).toMatchObject({ done: ["Alpha", "Legacy", "Nobody"], "No value": ["Beta"] });
    await page.unroute("**/api/nodes/*/attributes/stage");
    // A move to 「No value」 sends an empty value: nothing the person typed, so nothing is left to recover (writeRecovery.ts preserveDirectRejection).
    expect(await clearRecoveryCopies(page)).toBe(0);

    // No group field: a board without one says what to add (KanbanLayout.tsx), and the other view is untouched.
    const v2 = await (await page.request.post(`/api/tags/${tag.id}/views`, { ...H, data: { name: "NoGroup", layout: "kanban", visible_fields: ["title"] } })).json();
    await openBoard(page);
    await page.getByRole("tab", { name: /^NoGroup$/ }).click();
    await expect(page.getByText("Kanban needs a field to group by. Add a single-select / status field to this view (or set its group by) to see columns.")).toBeVisible();
    await expect(page.locator(".cv-kanban")).toHaveCount(0);
    await page.request.delete(`/api/tags/${tag.id}/views/${v2.id}`, H);

    // Phone: the page itself does not get wider and the board scrolls inside its own container (COL-05: 390px 看板在容器內橫向捲動、頁面無溢出);
    // the move select has an accessible name (the visible label is hidden on purpose, for screen readers: kanban-cards-mouse-only-a11y in
    // KanbanLayout.tsx) and moves the card the same way.
    const phone = await newContext(browser, { storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE, hasTouch: true, isMobile: true });
    const pp = await phone.newPage();
    await openBoard(pp);
    expect(await pp.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const geo = await pp.locator(".cv-kanban").evaluate((b) => ({ scroll: b.scrollWidth, client: b.clientWidth }));
    expect(geo.client).toBeLessThanOrEqual(390);
    expect(geo.scroll).toBeGreaterThan(geo.client);
    const psel = pp.getByRole("combobox", { name: `Move Alpha ${stamp} to column` });
    expect(await psel.locator("option").allTextContents()).toEqual(await pp.locator(".cv-kanban-col-title").allTextContents());
    const labelBox = await pp.locator(".cv-kanban-card", { hasText: `Alpha ${stamp}` }).locator(".cv-kanban-move-label").boundingBox();
    expect(labelBox!.width <= 2 && labelBox!.height <= 2).toBe(true); // pinned: today's behaviour, no written rule (the label is visually hidden: 1px)
    await psel.selectOption({ label: "No value" });
    await expect.poll(async () => (await attrs(idA)).stage).toBe("");
    await phone.close();
  });

  // FINDING: full-feature-audit.md GAP-155 (「未修；`group_field_options` 存在時永遠渲染全部宣告欄（含空欄）」; also scan-2026-11-14/07 M3): the
  // stages a field declares are all columns, empty or not, and a card can be moved into any of them. What the app does instead
  // (groupRows.ts 「Declared options no row holds get no bucket」): only a stage some card is in gets a column, so 「doing」 and
  // 「review」 are missing and a card cannot be moved into them, by drag or by the select.
  test("FINDING: a declared stage without a card still has a column and the move select offers it", async ({ page }) => {
    test.fail();
    const { stamp, openBoard, colOf, card } = await setUp(page);
    await openBoard(page);
    await expect(colOf(page, "doing")).toHaveCount(1);
    await expect(colOf(page, "review")).toHaveCount(1);
    expect(await card(page, "Alpha").locator("select option").allTextContents()).toEqual(expect.arrayContaining(["todo", "doing", "review", "done"]));
    void stamp;
  });

  // FINDING: same rule (GAP-155: 「todo 清空後即消失，拖曳與 select 都無法再移入」). What the app does instead: when the last card leaves a
  // stage its column is gone, and the card cannot be moved back there (the probe's `todoReachable`: no drop target, no option).
  test("FINDING: the stage a card just left stays a column the card can be moved back to", async ({ page }) => {
    test.fail();
    const { idA, attrs, openBoard, colOf, card } = await setUp(page);
    await openBoard(page);
    await card(page, "Alpha").dragTo(colOf(page, "done"));
    await expect.poll(async () => (await attrs(idA)).stage, { timeout: 10_000 }).toBe("done");
    await expect(colOf(page, "todo")).toHaveCount(1);
    expect(await card(page, "Alpha").locator("select option").allTextContents()).toContain("todo");
  });

  // FINDING: GAP-126 in full-feature-audit.md (COL-05: 「503 時卡片不動、無錯誤、無同步提示」, 「同 GAP-126」; fix: keep what was done and mark it
  // as waiting). While a card move waits in the queue the card should stay where it was put. What the app does instead: the board
  // re-reads the server and puts the card back in its old column, although the sync status says the change is safe on this device.
  test("FINDING: a card move that waits (503) stays in its new column", async ({ page }) => {
    test.fail();
    const { openBoard, colOf, card, board } = await setUp(page);
    await openBoard(page);
    await page.route("**/api/nodes/*/attributes/stage", (r) => r.request().method() === "PUT" ? r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"down"}' }) : r.continue());
    await card(page, "Alpha").dragTo(colOf(page, "done"));
    await expect(page.getByText(QUEUED_5XX)).toHaveCount(1);
    expect((await board(page)).done).toContain("Alpha");
  });

  // FINDING: layout-audit R7 / `--ac-tap` (44px): the card's move select is a control a finger must hit on a phone. What the app does
  // instead: it is 24px high (the probe's selectH) and nothing widens its target.
  test("FINDING: the kanban move select is a 44px target on a phone", async ({ page, browser }) => {
    test.fail();
    const { stamp, openBoard } = await setUp(page);
    const phone = await newContext(browser, { storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE, hasTouch: true, isMobile: true });
    const pp = await phone.newPage();
    await openBoard(pp);
    expect((await clickableSize(pp.getByRole("combobox", { name: `Move Alpha ${stamp} to column` }))).h).toBeGreaterThanOrEqual(44);
    await phone.close();
  });
});
