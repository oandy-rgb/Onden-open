import { test, expect, type Page } from "@playwright/test";
import { createAgent, ready, requireAdmin, openSidebarSearch, defaultSpaceId, addToDefaultSpace, createPublishingSpace, keepOffSite, BASE, H, FEED_ORIGIN, closeSideBySide, openNavDestination, publishRequest } from "./helpers";
import { makeReviewCard } from "./reviewFixtures";

// COMPOSITION — braided end-to-end journeys. Single-feature specs walk one
// corridor each; these three braids cross MANY capabilities on the same nodes,
// because orthogonality is proven at intersections:
//
//   braid 1 LEARNING:   rss subscribe → inbox batch → reader → 寫點什麼
//                       draft → #review → grade Good → HomeStart count drops →
//                       today lens lists the draft under Created.
//   braid 2 GOVERNANCE: scoped agent token → MCP createNode (behaviour tag
//                       sets an attr in the same cascade) + applyTag → inbox
//                       GROUP card → a second browser context sees it arrive
//                       LIVE (SSE tick) → reject the whole group → node gone
//                       from sidebar/search, cascade reverted, agenda unchanged.
//   braid 3 PUBLISH:    rich note (task checkbox + mermaid + math + wikilink +
//                       seeded ink_data) → UI publish-preview dialog → /site
//                       renders mermaid svg + KaTeX + the wikilink; ink degrades
//                       silently → the private sibling is absent from the /site
//                       page, feed.xml, sitemap.xml AND the site search panel.
//
// Backend twin: packages/backend/src/test/compositionLaws.integration.test.ts
// (ten decorated-node variants × universal law sweeps — that file is the
// append-point for new read surfaces).
//
// Conventions: helpers.ready(), per-run timestamp stamps (persistent
// onden_test), API-seed where the UI adds nothing. Desktop sidebar surface →
// chromium only (the config keeps non-crossbrowser specs off other engines).


// ── shared fixtures ──────────────────────────────────────────────────────────

// The backend fetch has no browser session, so a private media URL cannot be a
// feed fixture. Publish two origin notes to the stack's public site feed.
// Published notes live in a space whose publish switch is on: a personal space never publishes.
async function publishFeedNotes(page: Page, stamp: number): Promise<string> {
  const space_id = await createPublishingSpace(page.request);
  for (const n of [1, 2]) {
    const created = await page.request.post("/api/nodes", {
      ...H, data: {
        space_id,
        title: `Braided article ${n} (${stamp})`,
        markdown: `Quotable insight ${n} of run ${stamp}.\n\nSecond paragraph.`,
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const node = await created.json() as { id: string };
    const published = await page.request.put(`/api/nodes/${node.id}/attributes/_published`, {
      ...H, data: { value: "true", value_type: "bool" },
    });
    expect(published.ok(), await published.text()).toBeTruthy();
  }
  // The site (and its feed.xml) serves the last publish's snapshot (W38
  // model B): marking a note published only queues it until a publish.
  const pub = await publishRequest(page.request, {});
  requireAdmin(pub.status() !== 403, "publish needs the owner; run on a fresh stack");
  expect(pub.status(), `POST /api/publish: ${await pub.text()}`).toBe(201);
  return `${FEED_ORIGIN}/site/feed.xml?run=${stamp}`;
}


async function bootstrapNodes(page: Page): Promise<Array<{ id: string; title: string; hidden: boolean }>> {
  const b = (await (await page.request.get("/api/bootstrap")).json()) as { nodes: Array<{ id: string; title: string; hidden: boolean }> };
  return b.nodes;
}

// An agent whose write token reaches 共用 (its one space: tokens follow the
// agent's memberships since 2026-10-22, they carry no scope of their own).
async function agentHeaders(page: Page, name: string) {
  // An AI role that edits directly (「直接編輯」): a new agent may only suggest, and a suggest-only agent cannot apply tags or create notes (suggest_only, 2026-10-30).
  const agent = await createAgent(page.request, name, { reviewRule: "apply" });
  return { actorId: agent.id, headers: agent.headers };
}

// ─────────────────────────────────────────────────────────────────────────────
// BRAID 1 — the learning chain: feed → inbox → reader → 寫點什麼 draft → #review →
// grade → home count drops → today lens shows the card under Created.
// ─────────────────────────────────────────────────────────────────────────────
test("braid 1 — learning chain: rss → highlight card → review grade → home count drops → today lens", async ({ page }) => {
  test.setTimeout(150_000);
  const stamp = Date.now();
  const feedUrl = await publishFeedNotes(page, stamp);

  // A home node so HomeStart (and its review line) has a stage.
  const home = (await (await page.request.post("/api/nodes", {
    ...H, data: { title: `Braid home ${stamp}`, markdown: "## home" },
  })).json()) as { id: string };
  const patched = await page.request.patch("/api/workspace", { ...H, data: { home_node_id: home.id } });
  expect(patched.ok()).toBeTruthy();

  // Subscribe via API (the subscribe UI is rssReader.spec's corridor) and
  // nudge the outbox fetch; wait for both stamped articles to land.
  const sub = await page.request.post("/api/rss/subscribe", { ...H, data: { url: feedUrl } });
  expect(sub.ok(), `subscribe → ${sub.status()}`).toBeTruthy();
  const { id: sourceId } = (await sub.json()) as { id: string };
  // Re-nudge inside the poll: under the FULL suite the outbox can be busy
  // with earlier tests' jobs and a single refresh request may be debounced —
  // refresh is idempotent (items dedup by guid), so repeating is safe.
  await expect.poll(async () => {
    await page.request.post(`/api/rss/sources/${sourceId}/refresh`, { ...H, data: {} }).catch(() => null);
    const r = await page.request.get("/api/rss/items");
    if (!r.ok()) return 0;
    const items = ((await r.json()) as { items: Array<{ title: string }> }).items;
    return items.filter((it) => it.title.includes(`(${stamp})`)).length;
  }, { timeout: 45_000, intervals: [3000] }).toBeGreaterThanOrEqual(2);

  await ready(page, "/?view=notes");

  // 1. The subscription is read in the RSS reader (new articles left the
  // inbox, which is for approvals — b8fd2864): open it from the palette,
  // pick this run's source, then this run's article. The public site feed
  // includes earlier runs' notes, so the source holds more than these two.
  await expect(async () => {
    await page.keyboard.press("Control+k");
    await expect(page.locator(".palette-input-wrap input")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await page.locator(".palette-input-wrap input").fill(">reading");
  await page.locator(".palette-item", { hasText: "Go to Reading" }).click(); // modules/rss openCommand
  const reader = page.locator(".rss-reader");
  await expect(reader).toBeVisible();
  // The feed is a tag in the row above the list (the 來源 sheet only manages sources).
  await reader.locator(`.ui-filter-chip[data-value="${sourceId}"]`).click();
  await page.locator(".rss-item", { hasText: `Braided article 1 (${stamp})` }).click();
  await expect(page.locator(".rss-article-body")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".rss-article-body")).toContainText(`Quotable insight 1 of run ${stamp}`);

  // 2. Write about it: 寫點什麼 › 新草稿 starts a note carrying the article's
  //    link (quotes, when any, ride along); that note is the review card.
  //    (Quote cards were replaced by 引用到筆記 — quote, don't hoard.)
  await page.locator(".rss-article-end").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Write something" }).click();
  await page.getByRole("button", { name: "New draft" }).click();
  let quote: { id: string; title: string } | undefined;
  await expect.poll(async () => {
    const nodes = await bootstrapNodes(page);
    quote = nodes.find((n) => n.title.startsWith("On “Braided article 1") && n.title.includes(`${stamp}`));
    return !!quote;
  }, { timeout: 10_000 }).toBeTruthy();
  // The Reader is the main view here; navigating to Home below exits it.

  // 3. Enrol the quote card: make it a review card (its own reference;
  //    API-seeded, same as reviewLoop.spec).
  await makeReviewCard(page.request, quote!.id);

  // 4. Home shows the review line; remember its count.
  await page.goto(`/?view=notes&node=${home.id}`, { waitUntil: "load" });
  const line = page.locator(".home-start-review");
  await expect(line).toBeVisible({ timeout: 15_000 });
  await expect(line).toContainText(/ready to review/);
  const dueBefore = parseInt((await line.locator("button").first().textContent())!, 10);
  expect(dueBefore).toBeGreaterThanOrEqual(1);

  // 5. Grade through the drawer until OUR quote card has been graded Good
  //    (prior runs' due cards may queue ahead); count decrements every grade.
  //    Each card greets you front-side-up: reveal the answer before the grade
  //    buttons appear (the review module's recall-then-reveal UX) — the gate
  //    resets per card, so reveal inside the loop.
  await line.locator("button").first().click();
  const panel = page.locator(".review-panel");
  await expect(panel).toBeVisible();
  let remaining = parseInt((await panel.locator(".review-count").textContent())!, 10);
  expect(remaining).toBeGreaterThanOrEqual(1);
  let gradedOurs = false;
  while (remaining > 0 && !gradedOurs) {
    gradedOurs = ((await panel.locator(".review-card-title").textContent()) ?? "").includes(`${stamp}`);
    await panel.locator(".review-reveal").click();
    await panel.getByRole("button", { name: /Good/ }).click();
    remaining -= 1;
    if (remaining > 0) {
      await expect(panel.locator(".review-count")).toHaveText(`${remaining} left`);
    } else {
      await expect(panel.getByText(/Done — \d+ reviewed/)).toBeVisible();
    }
  }
  expect(gradedOurs, "our quote card came up and was graded").toBe(true);

  // 6. HomeStart count decrements (re-land on home → fresh stats fetch).
  await page.goto(`/?view=notes&node=${home.id}`, { waitUntil: "load" });
  await expect(page.locator(".home-start")).toBeVisible(); // home stats fetched + rendered
  const lineAfter = page.locator(".home-start-review");
  if (await lineAfter.count()) {
    const dueAfter = parseInt((await lineAfter.locator("button").first().textContent())!, 10);
    expect(dueAfter, "the home review count dropped").toBeLessThan(dueBefore);
  } // else: everything due was graded → the line correctly disappeared

  // 7. The quote card was CREATED today → the Journal's 「Happened this day」
  //    lists it as Created (the day's page, modules/daily/day/DaySections).
  await openNavDestination(page, "Daily notes");
  const happened = page.getByRole("region", { name: "Happened this day" });
  const more = happened.getByRole("button", { name: /more notes$/ });
  const row = happened.locator(".day-happened-row").filter({ hasText: `${stamp}` }).first();
  await expect(row.or(more).first()).toBeVisible({ timeout: 15_000 });
  if (await more.isVisible()) await more.click();
  await expect(row).toBeVisible();
  // Made under the day's note (the article's 寫點什麼 draft), it lists as a quick note of the day, else as Created.
  await expect(row.locator(".day-happened-kind")).toHaveText(/^(Quick note|Created)$/);
});

// ─────────────────────────────────────────────────────────────────────────────
// BRAID 2 — the governance chain: scoped token → MCP create (behaviour-tag
// cascade) → live inbox group in a SECOND context → reject all → full rollback.
// ─────────────────────────────────────────────────────────────────────────────
test("braid 2 — governance chain: scoped agent cascade → live inbox group → reject reverts everything", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const stamp = Date.now();
  const agentName = `Braid agent ${stamp}`;
  const title = `Braid seed ${stamp}`;

  // A tag whose field default seeds an attribute on apply, plus a plain label tag; the token is scoped to the default space. Tag import is
  // owner-only; skip on a non-fresh stack like the other governance specs.
  const behaviourRes = await page.request.post("/api/tags/import", {
    ...H,
    data: {
      name: `braidstatus${stamp}`,
      fields: [{ key: "status", type: "text", label: "Status", default: "incubating" }],
    },
  });
  requireAdmin(behaviourRes.status() !== 403, "tag import needs the owner; reset the stack");
  expect(behaviourRes.status()).toBe(201);
  const behaviourTagId = ((await behaviourRes.json()) as { id: string }).id;
  const labelRes = await page.request.post("/api/tags/resolve-path", { ...H, data: { path: `braidlabel${stamp}` } });
  expect(labelRes.ok()).toBeTruthy();
  const labelTagId = ((await labelRes.json()) as { leaf_id: string }).leaf_id;

  const agent = await agentHeaders(page, agentName);
  requireAdmin(!!agent, "actor creation needs admin; reset the stack");

  const agendaBefore = ((await (await page.request.get("/api/tasks/agenda")).json()) as { count: number }).count;

  // Context B is ALREADY watching the inbox — the group card must arrive via
  // the SSE-driven tick, not a navigation reload (liveUpdates.spec posture).
  // Side by side is remembered per account on the server (`splitPane`,
  // lib/splitViewStore) and a right pane folds the notes sidebar away
  // (decisions-ui 並排) — braid 1's 寫點什麼 draft, or another spec, may have
  // left one open. B starts on one pane so the sidebar's Inbox tab is there.
  const ctxB = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json" });
  await closeSideBySide(page.request, ctxB);
  const pageB = await ctxB.newPage();
  try {
    await ready(pageB);
    await pageB.locator('.sidebar-tab:has-text("Inbox")').click();
    // The inbox has loaded (its region is there) before the negative check.
    await expect(pageB.getByRole("region", { name: "Inbox", exact: true })).toBeVisible();
    const decideRow = pageB.getByRole("button", { name: `Open “${title}” to decide`, exact: true });
    await expect(decideRow).toHaveCount(0);

    // The agent acts through MCP only: createNode with the behaviour tag →
    // ONE triggered_by chain (NODE_CREATED → TAG_APPLIED → ATTRIBUTE_SET);
    // then applyTag adds the label tag as a second reviewable action.
    const created = await page.request.post("/api/mcp/tools/createNode", {
      headers: agent!.headers,
      data: { args: { title, markdown: "agent draft", tag_id: behaviourTagId } },
    });
    expect(created.ok(), `createNode → ${created.status()}`).toBeTruthy();
    const nodeId = ((await created.json()) as { result: { id: string } }).result.id;
    const tagged = await page.request.post("/api/mcp/tools/applyTag", {
      headers: agent!.headers,
      data: { args: { nodeId, tagId: labelTagId } },
    });
    expect(tagged.ok(), `applyTag → ${tagged.status()}`).toBeTruthy();

    // The behaviour cascade actually ran: the attr is set, apply-then-review.
    const attrs = (await (await page.request.get(`/api/nodes/${nodeId}/attributes`)).json()) as Array<{ key: string; value: string }>;
    expect(attrs.find((a) => a.key === "status")?.value).toBe("incubating");

    // B's open inbox lists the note under 「等你決定」 — live, via SSE. Its
    // changes are decided in the note (review → inbox, 2026-10-30).
    await expect(decideRow, "the agent's note arrives in the open inbox").toBeVisible({ timeout: 20_000 });
    await decideRow.click();
    const cards = pageB.locator(".inbox-review-item");
    await expect(cards.first()).toBeVisible();

    // Reject everything, newest first (the inverse-undo order): attr unset,
    // tag unapplied, node soft-deleted.
    await expect(async () => {
      const n = await cards.count();
      if (n > 0) await cards.nth(n - 1).locator(".inbox-review-reject").click();
      await expect(cards).toHaveCount(0, { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    // The node is gone from the store/sidebar/search…
    await expect.poll(async () => (await bootstrapNodes(pageB)).some((n) => n.id === nodeId), { timeout: 15_000 }).toBe(false);
    // The reject changed what B may read: each event of the chain raises B's
    // membership gate (the workspace goes inert) until B's sync reconciles,
    // and it can rise a few times in a row. Typing while it is up is dropped,
    // so wait for it to settle and retype if a late tick raised it again.
    await expect(pageB.locator(".workspace-grid[inert]")).toHaveCount(0, { timeout: 15_000 });
    // Back to the Notes tab — the review left the sidebar on Inbox, where the
    // search input is hidden.
    await pageB.locator('.sidebar-tab:has-text("Notes")').click();
    const searchInput = await openSidebarSearch(pageB);
    await expect(async () => {
      await expect(pageB.locator(".workspace-grid[inert]")).toHaveCount(0);
      await searchInput.fill(title);
      await expect(searchInput).toHaveValue(title, { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await expect(pageB.locator(".obsidian-search-count")).toContainText("0 results");
    // Match the reverted note's full title; the server checks below ensure
    // the zero-result UI is consistent with committed state.
    await expect(pageB.locator(".sb-item-title", { hasText: title })).toHaveCount(0);
    const search = (await (await page.request.get(`/api/nodes/search?q=${encodeURIComponent(title)}`)).json()) as Array<{ id: string }>;
    expect(search.some((r) => r.id === nodeId), "server search no longer lists it").toBe(false);

    // …the leftover single applyTag row left the queue with it (its target
    // node is trashed → filtered), and the agenda never moved.
    await expect(pageB.locator(".inbox-review-item", { hasText: title })).toHaveCount(0);
    const agendaAfter = ((await (await page.request.get("/api/tasks/agenda")).json()) as { count: number }).count;
    expect(agendaAfter).toBe(agendaBefore);
  } finally {
    await ctxB.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BRAID 3 — the publish chain: rich note through the UI publish dialog; the
// public surfaces render the riches and never mention the private sibling.
// ─────────────────────────────────────────────────────────────────────────────
test("braid 3 — publish chain: rich note renders on /site; the private sibling is absent everywhere public", async ({ page }) => {
  test.setTimeout(150_000);
  const stamp = Date.now();
  const secret = `TOPSECRETBRAID${stamp}`;

  const space_id = await createPublishingSpace(page.request); // a personal space never publishes, nor does the default one
  const mk = async (title: string, markdown: string) =>
    (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown, space_id } })).json()) as { id: string; slug: string; title: string };

  const pubB = await mk(`Braid garden ${stamp}`, `# Garden\n\nthe wikilink target.`);
  const rich = await mk(
    `Braid rich ${stamp}`,
    [
      `# Rich ${stamp}`,
      "",
      "- [ ] ship the braid",
      "",
      "```mermaid",
      "graph TD; A-->B;",
      "```",
      "",
      "$$E = mc^2$$",
      "",
      `See [[Braid garden ${stamp}]].`,
    ].join("\n"),
  );
  const priv = await mk(`Braid private ${stamp}`, `# Private\n\n${secret} must never leak.`);

  // Seeded ink_data (the handwriting attribute) — the published payload carries
  // markdown only, so the site must DEGRADE SILENTLY, not error.
  const ink = await page.request.put(`/api/nodes/${rich.id}/attributes/ink_data`, {
    ...H, data: { value: JSON.stringify({ version: 1, strokes: [], erased: {}, page: { width: 1000 } }), value_type: "text" },
  });
  expect(ink.ok()).toBeTruthy();

  // The space publishes: the private sibling is the one that is kept off.
  await keepOffSite(page.request, priv.id);

  // Site language and the default design (no saved design; the search lives in
  // every page's header) — owner-gated, skip on a non-fresh stack.
  const chrome = await page.request.patch("/api/workspace/config", {
    ...H,
    data: { config: { locale: "en" }, chrome: null },
  });
  requireAdmin(chrome.status() !== 403, "workspace config needs the owner; reset the stack");
  // Live chrome config PERSISTS and overlays every later publish (shared-DB
  // suite!) — guarantee cleanup whatever happens below.
  const clearChrome = async () => {
    await page.request.patch("/api/workspace/config", { ...H, data: { chrome: null } }).catch(() => null);
  };

  // Publish through the REAL UI: the studio's publish button first shows the
  // what's-public list (rich in, private out), then confirming runs it.
  await ready(page, "/?view=website");
  await page.locator(".pub-publish-button").click();
  const dialog = page.locator(".publish-preview-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".publish-preview-list li", { hasText: `Braid rich ${stamp}` })).toBeVisible();
  await expect(dialog.locator(".publish-preview-list li", { hasText: `Braid private ${stamp}` })).toHaveCount(0);
  await dialog.locator(".publish-preview-confirm").click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => {
    const s = (await (await page.request.get("/api/site")).json()) as { payload?: { nodes?: Array<{ id: string }> } };
    return (s.payload?.nodes ?? []).some((n) => n.id === rich.id);
  }, { timeout: 15_000 }).toBe(true);

  // The served page renders the riches on the server (KaTeX → .katex, wikilink →
  // a real link, task → md-checkbox). Mermaid diagrams are drawn in the browser and
  // the published pages ship no script but the search, so the fence stays code.
  await page.goto(`/site/${rich.slug}`, { waitUntil: "load" });
  await expect(page.locator(".katex").first()).toBeVisible();
  await expect(page.locator("a.published-inline-link", { hasText: `Braid garden ${stamp}` })).toBeVisible();
  await expect(page.locator(".md-checkbox").first()).toBeVisible();
  // Ink degrades silently: the page rendered (above) and mentions no ink/error.
  const richHtml = await page.content();
  expect(richHtml).not.toContain("ink_data");
  expect(richHtml.toLowerCase()).not.toContain("something went wrong");

  // The private sibling is absent from EVERY public surface:
  // (a) its own /site page serves no secret content…
  const privPage = await (await page.request.get(`/site/${priv.slug}`)).text();
  expect(privPage).not.toContain(secret);
  // …(b) nor does the rich page leak it, (c) feed.xml, (d) sitemap.xml…
  expect(richHtml).not.toContain(secret);
  const feed = await (await page.request.get("/site/feed.xml")).text();
  expect(feed).toContain(`Braid rich ${stamp}`);
  expect(feed).not.toContain(`Braid private ${stamp}`);
  expect(feed).not.toContain(secret);
  const sitemap = await (await page.request.get("/site/sitemap.xml")).text();
  expect(sitemap).toContain(`/site/${rich.slug}`);
  expect(sitemap).not.toContain(`/site/${priv.slug}`);
  // …(e) and the site search index (Pagefind, bbff7215). The box shows once
  // the publish's index is built — the site_bundle job, after the response —
  // so reload until it is there (sitePages.spec does the same).
  await expect(async () => {
    await page.goto(`/site/${rich.slug}`, { waitUntil: "load" });
    await expect(page.locator(".s-search")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 90_000 });
  const search = page.locator(".s-search__input");
  await search.fill(`Braid rich ${stamp}`);
  await expect(page.locator(".s-search__hit", { hasText: `Braid rich ${stamp}` }).first()).toBeVisible({ timeout: 15_000 });
  // The private note's own word: Pagefind matches words, so a query sharing
  // "Braid" would still list the rich note; the secret is in no published text.
  await search.fill(secret);
  // The re-query has run when the PREVIOUS query's hit is gone (positive
  // control for the negative assertion that follows).
  await expect(page.locator(".s-search__hit", { hasText: `Braid rich ${stamp}` })).toHaveCount(0);
  await expect(page.locator(".s-search__hit", { hasText: `Braid private ${stamp}` })).toHaveCount(0);

  await clearChrome();
});

// Shared-DB hygiene: braid 3 writes LIVE chrome config, which overlays every
// later publish in the run — clear it even when the test fails mid-way.
test.afterAll(async ({ request }) => {
  await request.patch(`${BASE}/api/workspace/config`, {
    headers: H.headers,
    // chrome is a TOP-LEVEL param of this endpoint (setChromeBlocks); null
    // deletes the stored presentation. config.chrome would be a dead key.
    data: { chrome: null },
  }).catch(() => null);
});
