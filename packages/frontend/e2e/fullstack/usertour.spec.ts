import { test, expect, type Page } from "@playwright/test";
import { ready, renderSettled, pollBootstrap, openPublishRow, openNoteHistory, openNoteEditor, defaultSpaceId, addToDefaultSpace, BASE, H } from "./helpers";

// Ad-hoc USER-FLOW tour (run with USERTOUR=1 against a fresh stack): walk the
// flow 「canvas 腦力激盪 → graph 看趨勢 → timeline 回滾 → tag 權限 → 發布成網站」
// like a person, screenshot every leg, and log friction (clicks, fallbacks).
const S = "/tmp/pw-output/shots";
const shot = async (page: Page, name: string) => {
  await renderSettled(page); // fonts + frames flushed — shots stay comparable without sleeps
  await page.screenshot({ path: `${S}/ut-${name}.png`, fullPage: false });
};
const friction: string[] = [];
const note = (s: string) => { friction.push(s); console.log("FRICTION| " + s); };

test("user flow: tag style → canvas+agent → graph → timeline rollback → tag access → publish", async ({ page }) => {
  test.skip(!process.env.USERTOUR, "ad-hoc user-flow tour — USERTOUR=1 on a fresh stack");
  test.setTimeout(360_000);
  const stamp = Date.now();
  page.on("console", (m) => { if (m.type() === "error") console.log("PAGE_ERR| " + m.text().slice(0, 200)); });
  page.on("request", (r) => {
    if (["POST", "PATCH", "PUT"].includes(r.method()) && r.url().includes("/api/") && !r.url().includes("/api/auth"))
      console.log(`REQ| ${r.method()} ${new URL(r.url()).pathname}`);
  });

  // ── Leg 0 — create a tag THROUGH THE UI (the sidebar tag panel's quiet
  //    "+", TagsMode retired), then check the notes sidebar renders the tag
  //    node with the # prefix + muted style.
  await ready(page, "/?view=notes");
  await page.locator(".sidebar-tag-new").click();
  await page.locator(".sidebar-tag-new-input").fill("ideas");
  await page.locator(".sidebar-tag-new-input").press("Enter");
  // Creating the tag lands on its schema lens — wait for it instead of sleeping.
  await expect(page.locator(".schema-lens-title")).toBeVisible();
  await shot(page, "00-tag-created-schema-lens");
  // The sidebar lists tags that notes carry; a #word in a note's text is not a
  // tag (T10). Give #ideas a member the way "+ Tag" does (stored membership).
  const ideasCatalog = await (await page.request.get("/api/tags")).json();
  const ideas = ((ideasCatalog.tags ?? ideasCatalog) as Array<{ id: string; name: string }>).find((t) => t.name === "ideas");
  expect(ideas, "the #ideas tag exists after the UI create").toBeTruthy();
  const ideasNote = await (await page.request.post("/api/nodes", { ...H, data: { title: `Ideas seed ${stamp}`, markdown: "", space_id: await defaultSpaceId(page.request) } })).json();
  expect((await page.request.put(`/api/nodes/${ideasNote.id}/tags/${ideas!.id}`, { ...H, data: {} })).ok()).toBe(true);

  await ready(page, "/?view=notes");
  // Tags are listed once, under TAGS (not again among the notes).
  const tagRow = page.locator(".sidebar-tag-chip", { hasText: "#ideas" }).first();
  await expect(tagRow).toBeVisible();
  await expect(page.locator(".obsidian-page-button.sb-tag-node", { hasText: "ideas" })).toHaveCount(0);
  await shot(page, "01-sidebar-tag-node");

  // ── Leg 1 — canvas 腦力激盪. Seed the project note via API (setup), then
  //    every brainstorm gesture is real UI.
  // Root notes go to the default space: the agent reaches it and it publishes.
  const space_id = await defaultSpaceId(page.request);
  const mk = async (title: string, markdown: string, parent_id?: string) =>
    (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown, ...(parent_id ? { parent_id } : { space_id }) } })).json());
  const project = await mk(`方向激盪 ${stamp}`, "# 方向激盪\n\n關於 onden 下一步的發想。");

  await ready(page, `/?view=notes&node=${project.id}`);
  // A board is opened on purpose: More → Canvas lists boards, and "New canvas"
  // creates one (viewing never creates data — canvas-navigation-2026-09-30).
  // NOTE: the react-flow pane's bounding box spans the viewport, so
  // position-relative clicks land on the sidebar; aim with absolute coords
  // off .kw-canvas-wrap.
  // The board list opens from the 白板 card under Tags › feature tags.
  await page.locator(".app-primary-nav").getByRole("button", { name: "Tags", exact: true }).click();
  await page.getByRole("button", { name: "Open “Canvas”", exact: true }).click();
  await expect(page.locator(".canvas-empty-state")).toBeVisible();
  await shot(page, "02a-canvas-chooser");
  await page.getByRole("button", { name: "New canvas" }).click();
  const wrap = page.locator(".kw-canvas-wrap").first();
  await wrap.waitFor({ timeout: 15_000 });
  // The new board is its own node; its id is the `node` in the URL.
  await page.waitForURL((u) => !!u.searchParams.get("node"), { timeout: 15_000 });
  const boardId = new URL(page.url()).searchParams.get("node")!;
  await shot(page, "02-canvas-lens");

  // Double-click empty canvas to create cards, then retitle the fresh
  // "New Note" card in place — the real brainstorm gesture.
  const mkCard = async (relX: number, relY: number, title: string) => {
    const box = await wrap.boundingBox();
    if (!box) { note("canvas wrap has no bounding box"); return; }
    const inputs = page.locator(".card-node-title-input");
    const before = await inputs.count();
    await page.mouse.dblclick(box.x + relX, box.y + relY);
    // POST /api/nodes + canvas save + refresh → a fresh card materializes.
    await expect(inputs).toHaveCount(before + 1, { timeout: 10_000 }).catch(() => {});
    const cnt = await inputs.count();
    let renamed = false;
    for (let i = 0; i < cnt; i++) {
      if ((await inputs.nth(i).inputValue()) === "New Note") {
        await inputs.nth(i).fill(title);
        await inputs.nth(i).press("Enter");
        renamed = true;
        break;
      }
    }
    if (!renamed) note(`card "${title}": no fresh "New Note" card appeared after double-click`);
    // The rename persists via a debounced save — poll the server, don't sleep.
    else await pollBootstrap(page, (b) => b.nodes.find((n: { title: string }) => n.title === title),
      { message: `card rename "${title}" persisted` });
  };
  await mkCard(140, 120, "插件系統：tag-pack 先行");
  await mkCard(700, 160, "行動版 capture 快速入口");
  await mkCard(180, 520, "agent 例行整理孤兒節點");
  await shot(page, "03-canvas-three-cards");
  const cardCount = await page.locator(".react-flow__node").count();
  console.log("CANVAS_CARDS=" + cardCount);
  if (cardCount < 3) note(`double-click card creation produced ${cardCount}/3 cards`);

  // A second brainstormer: an MCP agent drops an idea; it lands in Inbox for review.
  const actor = await (await page.request.post("/api/actors", { ...H, data: { name: `Tour Agent ${stamp}`, type: "agent", role: "editor" } })).json();
  await addToDefaultSpace(page.request, actor.id); // agents join no space by themselves (097)
  const tok = await (await page.request.post(`/api/actors/${actor.id}/tokens`, { ...H, data: {} })).json();
  const AH = { headers: { origin: BASE, "content-type": "application/json", authorization: `Bearer ${tok.token}` } };
  await page.request.post("/api/mcp/tools/createNode", { ...AH, data: { args: { title: `Agent 點子 ${stamp}: 把 graph 當權限儀表板`, markdown: "agent 在激盪時補充的想法。" } } });
  await ready(page, "/");
  await page.locator('.sidebar-tab:has-text("Inbox")').click();
  const approve = page.locator(".inbox-review-approve").first();
  await approve.waitFor({ timeout: 10_000 }).catch(() => {}); // absence is friction, noted below
  await shot(page, "07-inbox-agent-idea");
  if (await approve.count()) {
    const cardsBefore = await page.locator(".inbox-review-approve").count();
    await approve.click();
    // Decided → the card leaves the review queue.
    await expect(page.locator(".inbox-review-approve")).toHaveCount(cardsBefore - 1, { timeout: 10_000 });
  }
  else note("agent-created idea did not surface an approve card in Inbox");

  // ── Leg 2 — graph 看整體趨勢: All Cards + tag edges.
  await ready(page, `/?view=notes&node=${boardId}&lens=canvas`);
  // All Cards retired — the global graph is the top bar's Graph now.
  await page.locator(".app-primary-nav").getByRole("button", { name: "Graph", exact: true }).click();
  // The everything-graph draws on a canvas; wait for it before shooting.
  await page.locator(".all-cards-graph-wrap canvas").first().waitFor({ timeout: 20_000 });
  await shot(page, "08-graph-all-cards");
  const tagEdges = page.getByRole("button", { name: "Tag edges" });
  if (await tagEdges.count()) {
    await tagEdges.click();
    // Edges fade in; there may legitimately be few/none, so don't fail on absence.
    await page.locator(".react-flow__edge").first().waitFor({ timeout: 10_000 }).catch(() => {});
    await shot(page, "09-graph-tag-edges");
  } else note("Tag-edges toggle not present on the All Cards graph");

  // ── Leg 3 — timeline 回滾: real edits in the editor, then restore v1.
  const draft = await mk(`結論草稿 ${stamp}`, "V1 結論：先做 tag-pack 插件。");
  await ready(page, `/?view=notes&node=${draft.id}`);
  const cm = page.locator(".cm-content").first();
  await expect(cm).toBeVisible(); // editor mounted
  await cm.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("V2 結論：改成先做行動版 capture。", { delay: 10 });
  // Autosave is debounced and versions the edit — poll the versions API for the
  // persisted V2 body instead of sleeping past the debounce.
  await expect.poll(async () => {
    const r = await page.request.get(`/api/nodes/${draft.id}/versions`);
    const versions = r.ok() ? await r.json() : [];
    return versions[0]?.markdown ?? "";
  }, { timeout: 15_000, message: "autosave versioned the V2 edit" }).toContain("V2");
  await shot(page, "10-draft-v2");

  await openNoteHistory(page);
  await page.locator(".ov-history-open").first().click();
  await expect(page.locator(".nh")).toBeVisible();
  const entries = page.locator(".nh-versions .nh-row");
  const n = await entries.count();
  console.log("HISTORY_ENTRIES=" + n);
  await entries.nth(n - 1).click();
  // Moving to an older stop surfaces the "go back" affordance.
  await expect(page.locator(".nh-actions .ui-btn--primary")).toBeVisible();
  await shot(page, "11-history-modal");
  await page.locator(".nh-actions .ui-btn--primary").click();
  await expect(page.locator(".nh-notice")).toBeVisible();
  await page.getByRole("button", { name: /^(Back|返回)$/ }).click();
  await openNoteEditor(page);
  // The history screen stays open after a restore; closing it shows the restored body.
  await expect.poll(async () => (await page.locator(".cm-content").first().innerText().catch(() => "")),
    { timeout: 10_000 }).toContain("V1").catch(() => {}); // absence falls through to the friction note
  const body = await page.locator(".cm-content").first().innerText().catch(() => "");
  console.log("AFTER_RESTORE=" + body.replace(/\n/g, "\\n"));
  if (!body.includes("V1")) note("timeline restore did not bring back the V1 body");
  await shot(page, "12-after-rollback");

  // The global Timeline place, for the trend-over-time read.
  await ready(page, "/?view=timeline");
  await expect(page.locator(".node-lens-title")).toHaveText("History"); // the workspace history page rendered
  await shot(page, "13-global-timeline");

  // ── Leg 4 — tag 權限: open the #ideas tag NODE from the sidebar tree
  //    (TagsMode retired — a tag is a node). Tags no longer decide access
  //    (spaces do), so the tag page has nothing about access: only its notes,
  //    fields and functions.
  await ready(page, "/?view=notes");
  await page.locator(".sidebar-tag-chip", { hasText: "#ideas" }).first().click();
  await expect(page.locator(".schema-lens-section").first()).toBeVisible(); // schema lens rendered
  await shot(page, "14-tag-access");

  // ── Leg 5 — 發布成網站: publish the conclusion note via the info panel's
  //    publish row, let the AGENT request the site build, approve it in
  //    Inbox, then visit the public page.
  await ready(page, `/?view=notes&node=${draft.id}`);
  const { mark, unpublish } = await openPublishRow(page);
  await expect(unpublish).toHaveCount(0);
  await mark.click();
  await expect(unpublish).toBeVisible();
  await shot(page, "16-publish-toggle");

  const held = await page.request.post("/api/mcp/tools/publishSite", { ...AH, data: { args: { title: `Tour site ${stamp}` } } });
  expect(held.ok(), await held.text()).toBeTruthy();
  await ready(page, "/");
  await page.locator('.sidebar-tab:has-text("Inbox")').click();
  const heldCard = page.locator(".inbox-review-item-held").first();
  await expect(heldCard).toBeVisible();
  await shot(page, "17-inbox-held-publish");
  await heldCard.locator(".inbox-review-approve").click();

  // The approved publish runs async — the poll below IS the wait.
  await expect.poll(async () => (await page.request.get(`/site/${draft.slug}`)).status(), { timeout: 20_000 }).toBe(200);
  await page.goto(`/site/${draft.slug}`);
  await shot(page, "18-published-page");
  await page.goto("/site/");
  await shot(page, "19-published-index");

  console.log("FRICTION_TOTAL=" + friction.length);
});
