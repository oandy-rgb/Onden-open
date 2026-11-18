import { type APIRequestContext, type APIResponse, type BrowserContext, type Locator, type Page, expect, test } from "@playwright/test";
import { execFileSync, execSync } from "node:child_process";
import { E2E_CLIENT_PROTOCOL, E2E_CLIENT_PROTOCOL_HEADER } from "./hostContract";

/** The e2e stack's Postgres container, for the audit specs that read or
 *  stage the database directly. Resolution order: E2E_PG_CONTAINER (the exact
 *  container name), else `${E2E_COMPOSE_PROJECT}-postgres-1` (the compose
 *  project the stack was started with, e.g. `onden-e2e`), else the calling
 *  test is skipped with instructions: a hard-coded name silently targets
 *  nobody's stack. Call it inside a test body. */
export function e2ePostgresContainer(): string {
  return e2eContainer("postgres");
}

/** The stack's container for a compose service (postgres, backend, frontend):
 *  E2E_PG_CONTAINER names postgres directly; otherwise E2E_COMPOSE_PROJECT
 *  gives `<project>-<service>-1`. Neither set: the test is skipped. */
export function e2eContainer(service: "postgres" | "backend" | "frontend"): string {
  const container = service === "postgres" ? process.env.E2E_PG_CONTAINER?.trim() : undefined;
  if (container) return container;
  const project = process.env.E2E_COMPOSE_PROJECT?.trim();
  if (project) return `${project}-${service}-1`;
  test.skip(true, `needs direct container access: set E2E_COMPOSE_PROJECT=<compose project> (containers \`<project>-<service>-1\`)${service === "postgres" ? " or E2E_PG_CONTAINER=<postgres container name>" : ""}; see e2e/README.md`);
  throw new Error("unreachable: test.skip ends the test");
}

// Gate for tests whose precondition is a privileged (first-human/admin/owner)
// e2e user — i.e. a FRESH stack. By default a missing precondition skips the
// test (local convenience: an already-used stack shouldn't fail your run).
// Under E2E_REQUIRE_ADMIN=1 (CI) the same situation FAILS loudly instead, so a
// stale stack can never produce a green run that silently skipped the
// governance/publishing suites.
export function requireAdmin(ok: boolean, reason: string): void {
  if (ok) return;
  if (process.env.E2E_REQUIRE_ADMIN === "1") {
    throw new Error(`E2E_REQUIRE_ADMIN=1: refusing to skip — ${reason}`);
  }
  test.skip(true, reason);
}

/** Run SQL in the e2e stack's Postgres (`onden_test`) and return trimmed rows,
 *  one per line, columns joined by `fieldSeparator` (default psql's `|`). Args go
 *  to execFileSync as an array, so the SQL never passes through a shell. */
export function psql(sql: string, opts: { fieldSeparator?: string } = {}): string {
  const args = ["exec", e2ePostgresContainer(), "psql", "-U", "onden", "-d", "onden_test", "-At"];
  if (opts.fieldSeparator) args.push("-F", opts.fieldSeparator);
  return execFileSync("docker", [...args, "-c", sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

// Poll the server until `pick` finds what it's looking for in the bootstrap
// payload — the standard way to wait out the editor's debounced autosave or an
// async projection instead of sleeping. Returns the picked value.
export async function pollBootstrap<T>(
  page: Page,
  pick: (b: any) => T | undefined,
  opts: { timeout?: number; message?: string } = {},
): Promise<T> {
  let found: T | undefined;
  await expect
    .poll(
      async () => {
        const res = await page.request.get("/api/bootstrap");
        if (!res.ok()) return undefined;
        found = pick(await res.json());
        return found;
      },
      { timeout: opts.timeout ?? 15_000, message: opts.message },
    )
    .toBeTruthy();
  return found as T;
}

// Land on the app, authenticated + past the first-run gate, on ANY engine.
// Auth rides in via storageState (cookies). The onboarding storage picker,
// however, isn't part of storageState on non-chromium engines, so dismiss it
// defensively here rather than assuming global-setup covered it. Then wait for
// a stable app-shell anchor.
export async function ready(page: Page, url = "/?view=notes"): Promise<void> {
  await page.goto(url, { waitUntil: "load" });
  // The app mounts asynchronously after `load` (a persistent SSE connection
  // means networkidle never fires, so it can't be used as a settle signal).
  // Race the app shell against the first-run storage picker: wait for whichever
  // surfaces first, dismiss the picker if it won, then REQUIRE the shell —
  // failing loudly here beats every test timing out 15s deeper in. The shell
  // selector covers BOTH layouts: desktop (the topbar navigation, hidden
  // on a phone viewport) and mobile (.mobile-bottom-nav) — so a mobile-viewport
  // ready() doesn't hang waiting on a desktop-only chrome element. .filter({
  // visible: true }) BEFORE .first() is load-bearing: a plain .first() resolves
  // to the DOM-first match (the desktop navigation, which is present but
  // hidden on a phone viewport) and would wait forever for it to become visible.
  const shell = page.locator(".app-topbar nav, .mobile-bottom-nav").filter({ visible: true }).first();
  const opfs = page.getByText("Use browser storage", { exact: false }).first();
  await shell.or(opfs).waitFor({ timeout: 30_000 });
  if (await opfs.isVisible().catch(() => false)) {
    await opfs.click();
  }
  await shell.waitFor({ state: "visible", timeout: 20_000 });
}

// Fill a field and confirm the text stuck. Every page load runs the cold-start
// membership check, which raises the fail-closed gate and makes the workspace
// inert for a moment; a fill that lands then is dropped silently (no focus, no
// input event), and the gate can rise after a `.membership-gate` count-0 check
// has already passed. Retrying until the value reads back is what a person does.
export async function fillWhenReady(field: Locator, text: string): Promise<void> {
  await expect(async () => {
    await field.fill(text);
    await expect(field).toHaveValue(text, { timeout: 500 });
  }).toPass({ timeout: 20_000 });
}

// Deterministic pre-screenshot settle for the capture/tour specs: wait for
// webfonts to finish loading + two animation frames to paint. This replaces
// the old "sleep 1200ms before every screenshot" pattern with an actual
// render condition (fonts ready + frames flushed) — same visual stability,
// no fixed cost.
export async function renderSettled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready;
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  });
}

// The note's publish row: a row of the info panel's 「功能」 tab where the website module says where the note
// stands on the site (on it, goes live with the next publish, kept off) and offers 「Keep off the site」 /
// 「Put back」. A note in a space that publishes has it without any marking (211dda77); make one with
// createPublishingSpace. Buttons are found by `data-action`, not by label, so the specs hold in any language.
/** The info panel's 「網站」 row (the 功能 tab: the website module's noteFunctionRows). A note in a space that does
 *  not publish, or a hidden one, has no row. `mark` matches nothing now (marking is gone: the space decides). */
export async function openInfoFunctions(page: Page): Promise<void> {
  const inspector = page.locator(".notes-inspector-toggle");
  if ((await inspector.count()) && (await inspector.getAttribute("aria-pressed")) === "false") await inspector.click();
  const tab = page.locator("#info-tab-functions");
  if ((await tab.count()) && (await tab.getAttribute("aria-selected")) !== "true") await tab.click();
}

/** The info panel's 標籤 tab: the fields of the note's tags (`.attr-panel`, InfoTagsTab). The panel opens on 功能
 *  (lib/infoPanel.ts), so a spec that reads or edits field values opens this tab first. Desktop widths only. */
export async function openInfoTags(page: Page): Promise<void> {
  const inspector = page.locator(".notes-inspector-toggle");
  if ((await inspector.count()) && (await inspector.getAttribute("aria-pressed")) === "false") await inspector.click();
  const tab = page.locator(".overview-activity").getByRole("tablist", { name: /^(Info|資訊)$/ }).getByRole("tab", { name: /^(Tags|標籤)$/ });
  await expect(tab).toBeVisible();
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await expect(page.locator(".attr-panel")).toBeVisible();
}

export async function openPublishRow(page: Page) {
  const row = page.locator(".info-publish");
  if (!(await row.isVisible().catch(() => false))) await openInfoFunctions(page);
  await row.waitFor({ state: "visible", timeout: 15_000 });
  const action = (name: string) => row.locator(`[data-action='${name}']`);
  return {
    row,
    status: row.locator(".info-function-text"),
    mark: action("mark"),
    unpublish: action("unpublish"),
    putBack: action("put-back"),
    subtree: action("subtree"),
    publishSite: action("publish-site"),
  };
}

// The stack under test and the {origin, protocol, content-type} headers every JSON write
// to it needs. The only place in specs that reads E2E_BASE or builds these
// headers (guard: src/test/guards/dup-b2-test-helpers.guard.test.ts).
export const BASE = process.env.E2E_BASE || "http://localhost:5099";

/** Where the BACKEND reaches the stack's own site feed (`/site/feed.xml`): the compose network's `nginx` host.
 *  Without docker (cloud-stack.mjs) there is no such host, so it sets E2E_FEED_ORIGIN to the forwarder's loopback address. */
export const FEED_ORIGIN = process.env.E2E_FEED_ORIGIN || "http://nginx";
/** What a page of this build sends with every request: its origin, and the block-identity protocol it speaks — without
 *  that, a session's write to a note is refused 426 client_too_old (backend clientGate.ts). */
export const PAGE = { origin: BASE, [E2E_CLIENT_PROTOCOL_HEADER]: String(E2E_CLIENT_PROTOCOL) };
export const H = { headers: { ...PAGE, "content-type": "application/json" } };

// Bulk-create N nodes via POST /api/nodes at bounded concurrency — the pattern
// duplicated across perf/virtSidebar/nodeSwitchScale/scaleProbe specs, lifted
// here so scale specs stop re-implementing the batching (and the easy-to-get-
// wrong 25-wide throttle that keeps seeding tractable without flooding the API).
//
// SCALE/CONTAINMENT: by default the filler is parented under ONE container note
// (opts.parentId) so a 5k flood stays collapsed and never enters OTHER specs'
// sidebar trees (the trick virtSidebar/nodeSwitchScale rely on). Pass a custom
// `title(i)` to stamp unique, searchable titles; the default already stamps a
// per-call token + zero-padded index so a later `selectNodeByTitle` can find a
// UNIQUE row. Returns the created ids in order.
export async function seedNodes(
  page: Page,
  n: number,
  opts: {
    /** Parent every seeded node under this id (containment). */
    parentId?: string;
    /** Per-index title; default `${token} ${0000-index}`. Make it UNIQUE per node. */
    title?: (i: number) => string;
    /** Per-index markdown body; default a short filler. */
    markdown?: (i: number) => string;
    /** Concurrency width (default 25). */
    concurrency?: number;
    /** Shared token mixed into the default title (default a fresh timestamp). */
    token?: string;
  } = {},
): Promise<string[]> {
  const conc = opts.concurrency ?? 25;
  const token = opts.token ?? `seed-${Date.now()}`;
  const titleOf = opts.title ?? ((i: number) => `${token} ${String(i).padStart(4, "0")}`);
  const bodyOf = opts.markdown ?? ((i: number) => `seeded node ${i} (${token})`);
  const ids: string[] = new Array(n);
  for (let i = 0; i < n; i += conc) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(conc, n - i) }, async (_, j) => {
        const idx = i + j;
        const data: Record<string, unknown> = { title: titleOf(idx), markdown: bodyOf(idx) };
        if (opts.parentId) data.parent_id = opts.parentId;
        const res = await page.request.post("/api/nodes", { ...H, data });
        if (!res.ok()) throw new Error(`seedNodes: POST /api/nodes ${res.status()} at index ${idx}`);
        return { idx, id: (await res.json()).id as string };
      }),
    );
    for (const { idx, id } of batch) ids[idx] = id;
  }
  return ids;
}

// Open the existing sidebar search without changing the selected note or pane.
// Callers that start in phone note detail must return to the list themselves.
/** The note list's search box (OverviewSidebar's SearchField: it has no class of its own since
 *  every search box became one SearchField, 2026-11-01), found by its label in either locale. */
export const sidebarSearch = (page: Page) => page.getByRole("searchbox", { name: /^(Search notes…|搜尋筆記…)$/ });

export async function openSidebarSearch(page: Page) {
  const search = sidebarSearch(page);
  if (!(await search.isVisible())) {
    await page.locator(".sidebar-search-toggle").filter({ visible: true }).click();
  }
  await expect(search).toBeVisible();
  return search;
}

// Robustly focus a node by title — SCALE-SAFE. Clicking a sidebar tree row is
// unreliable past ~300 rows: the tree is VIRTUALIZED (OverviewSidebar.tsx
// `obsidian-page-list`, slice render), so an off-window row simply isn't in the
// DOM to click. Reach it the way a person does in a big workspace — the sidebar
// SEARCH box (sidebarSearch, OverviewSidebar.tsx) — then press
// Enter, which selects the TOP result (OverviewSidebar.tsx:521 — Enter fires
// onSelectNode(overviewSearchResults[searchIdx]) with searchIdx defaulting to
// 0).
//
// CRITICAL: `title` must be a token UNIQUE to the target. A token shared by all
// seeded nodes (e.g. the common timestamp) matches thousands of rows and buries
// the target below them, so Enter selects the wrong node. Seed targets with a
// per-node marker and pass THAT here.
//
// Search is debounced (~120ms, useOverviewSearch.ts) and runs FTS5/LIKE then a
// Fuse fallback, so we poll the result list until it actually populates before
// pressing Enter, rather than racing the debounce.
export async function selectNodeByTitle(page: Page, title: string): Promise<void> {
  await expect(page.locator(".membership-gate")).toHaveCount(0, { timeout: 45_000 });
  if (await page.locator(".omt-back").isVisible()) {
    await page.locator(".omt-back").click();
  }
  const search = await openSidebarSearch(page);
  await search.fill("");
  await search.click();
  await search.pressSequentially(title);
  await expect(search).toHaveValue(title);
  // Wait for the result row that ACTUALLY MATCHES this title to render — not just
  // any (possibly stale) first row. Pressing Enter on searchIdx 0 before the
  // filtered result lands selects the wrong node; clicking the matching row by
  // text removes that race + the searchIdx ambiguity entirely. `title` must be a
  // unique token (OverviewSidebar.tsx:789 renders overviewSearchResults rows).
  // Search RESULTS render as `.obsidian-page-button` inside `.obsidian-search-row`
  // (OverviewSidebar.tsx:789) — NOT under the tree's `.obsidian-page-list`. Match
  // the button by its unique title text in EITHER container.
  const match = page.locator(".obsidian-page-button", { hasText: title }).first();
  await expect(match).toBeVisible({ timeout: 20_000 });
  await match.click();
}

// A REAL cold start: full page reload (worker + OPFS restart), used ONLINE.
//
// IMPORTANT — this is online-only. The SPA cannot boot OFFLINE through the e2e
// harness service worker: the harness does not register/precache the app shell
// for offline navigation, so a reload while `context.setOffline(true)` would
// fail to fetch index.html and never mount. Offline durability specs must
// therefore RECONNECT first (setOffline(false) + dispatch the "online" event),
// let pending writes drain, and only THEN reloadColdStart to prove the data
// survived a genuine worker/OPFS restart (not just an in-app remount).
export async function reloadColdStart(page: Page): Promise<void> {
  await page.reload({ waitUntil: "load" });
  // Same settle as ready(): the shell mounts async after `load`; the storage
  // picker isn't in storageState on non-chromium, so dismiss it defensively,
  // then REQUIRE the app shell.
  const shell = page.locator(".app-topbar nav, .mobile-bottom-nav").filter({ visible: true }).first();
  const opfs = page.getByText("Use browser storage", { exact: false }).first();
  await shell.or(opfs).waitFor({ timeout: 30_000 });
  if (await opfs.isVisible().catch(() => false)) {
    await opfs.click();
  }
  await shell.waitFor({ state: "visible", timeout: 20_000 });
}

// A device that has used Onden online has the lazily loaded screens (quick
// capture, ink, tasks…) on hand offline: the app fetches them on idle once the
// service worker controls the page (lib/offlineWarmup.ts) and marks the build.
// Specs that go offline wait for that mark first, as a real device would have it.
export async function expectOfflineReady(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => localStorage.getItem("onden.offlineWarmBuild")), { timeout: 30_000 }).not.toBeNull();
}

// Open the quick-capture sheet via its global event channel. The QuickCapture
// listener attaches in a mount effect that can land AFTER the app shell is
// visible, so a single fire-and-check races the listener into the void. Poll
// the dispatch until the sheet actually opens.
export async function openQuickCapture(page: Page): Promise<void> {
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("onden-open-quick-capture")));
    await expect(page.locator(".quick-capture-textarea")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

// Capture goes to the inbox unless told otherwise, and the inbox's tag is made
// by the server the first time; a workspace that never captured online refuses
// an offline capture ("Connect once to set up the inbox"). Specs that capture
// offline set it up first, as capturing online once would. Call before the
// app boots so its first load has the tag.
export async function ensureInbox(page: Page): Promise<string> {
  const res = await page.request.post("/api/capture/inbox", { ...H, data: {} });
  if (!res.ok()) throw new Error(`ensureInbox: ${res.status()}`);
  return (await res.json()).tag_id as string;
}

// Saving keeps the box open for the next thought (since 2026-10-29): wait for
// "Saved to …" and the emptied text, then close it.
export async function saveQuickCapture(page: Page): Promise<void> {
  await page.locator(".quick-capture-save").click();
  await expect(page.locator(".quick-capture-saved")).toBeVisible();
  await expect(page.locator(".quick-capture-textarea")).toHaveValue("");
  await page.locator(".quick-capture-overlay").getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".quick-capture-overlay")).toHaveCount(0);
}

// Desktop has no capture button: Ctrl+Shift+N is the way in. Focus leaves any
// text field first (a bare press from inside an input is still a global chord,
// but a stale focus on a closed dialog is not worth the flake).
export async function openQuickCaptureByHotkey(page: Page): Promise<void> {
  await expect(async () => {
    await page.locator("body").click({ position: { x: 1, y: 1 } }).catch(() => {});
    await page.keyboard.press("Control+Shift+N");
    await expect(page.locator(".quick-capture-textarea")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

// Recent versions live in Info; opening them never replaces the editor.
/** The note's "Edited …" header link (the phrase opens history) (since 2026-10-18 under the
 *  title, not in the inspector) is showing. */
/** Show the open note's Content tab when another tab (a board…) is in front. A wide screen's tabs are
 *  the title strip (.center-lens-bar); a phone's are the row above the title again since 2026-11-07
 *  (.phone-view-tabs, changes/2026-11-07-phone-tabs-above-title), and a full-screen board's title ⌄
 *  (.board-note-title) opens the sheet with every tab. */
async function showNoteContent(page: Page, shown: Locator): Promise<void> {
  if (await shown.isVisible().catch(() => false)) return;
  const content = /^(Content|內容)$/;
  const wide = page.locator(".center-lens-bar").getByRole("tab", { name: content });
  const phone = page.locator(".phone-view-tabs").getByRole("tab", { name: content });
  const boardTitle = page.locator(".board-note-title");
  if (await wide.isVisible().catch(() => false)) await wide.click();
  else if (await phone.isVisible().catch(() => false)) await phone.click();
  else if (await boardTitle.isVisible().catch(() => false)) {
    await boardTitle.click();
    await page.getByRole("dialog").getByRole("tab", { name: content }).click();
  }
  await expect(shown).toBeVisible();
}

export async function openNoteHistory(page: Page) {
  await showNoteContent(page, page.locator(".note-history-link"));
}

export async function openNoteEditor(page: Page) {
  await showNoteContent(page, page.locator(".cm-content").first());
}

/** Desktop: click a top-bar destination (a core page or an imported module's
 *  page). Trailing module entries fold into 「更多 ▾」 when the bar is
 *  narrow, so look there when the button is not in the bar. Returns the
 *  control that now carries aria-current (the button, or 更多 ▾). */
export async function openNavDestination(page: Page, name: string): Promise<Locator> {
  const nav = page.locator(".app-primary-nav");
  const direct = nav.getByRole("button", { name, exact: true });
  const more = nav.getByRole("button", { name: /^(More|更多)$/ });
  const menu = page.getByRole("menu", { name: /^(More|更多)$/ });
  // Right after a navigation the bar is still settling (the module entries arrive, the bar re-fits): an
  // entry can be in neither the bar nor 「更多 ▾」 for a moment. Retry with short clicks until one lands.
  let opened: Locator = direct;
  await expect(async () => {
    if (await menu.isVisible()) await page.keyboard.press("Escape");
    if (await direct.isVisible()) { await direct.click({ timeout: 1_000 }); opened = direct; return; }
    await more.click({ timeout: 1_000 });
    await menu.getByRole("menuitem", { name, exact: true }).click({ timeout: 1_000 });
    opened = more;
  }).toPass({ timeout: 15_000 });
  return opened;
}

/** Start on one pane. Side by side (`splitPane`, lib/splitViewStore) is remembered per account on the
 *  server and copied on the device, so a right pane one spec opens is there when the next starts: it
 *  folds the notes sidebar away and adds a second .note-document. Clears both; the device copy once per
 *  tab session, so a test that opens side by side and reloads still sees what it chose. */
export async function closeSideBySide(request: APIRequestContext, target: Page | BrowserContext): Promise<void> {
  const closed = await request.put("/api/me/prefs/splitPane", { ...H, data: { value: null } });
  expect(closed.ok(), "close any side-by-side pane left by another spec").toBe(true);
  await target.addInitScript(() => {
    if (sessionStorage.getItem("onden-e2e-one-pane")) return;
    sessionStorage.setItem("onden-e2e-one-pane", "1");
    for (const key of Object.keys(localStorage)) if (key.startsWith("onden.splitPane")) localStorage.removeItem(key);
  });
}

// Desktop: open an imported feature (Canvas, Website…) by its nav entry.
// The Tags page's feature cards were removed (1a18dc00): features open from
// the top bar, or its 「更多 ▾」 when the bar is narrow. English locale.
export async function openFeature(page: Page, name: string) {
  await openNavDestination(page, name);
}

/** Settings › Features (the module library, docs/architecture/module-library.md
 *  引入與使用分開): opens it the way the app's own links do and returns the
 *  row of `module`. With `settings` it opens that feature's own page (the row
 *  is a link to it) and returns the page (`.settings-module-page`), where the
 *  feature's switch and every setting of it are. */
export async function openModuleCard(page: Page, module: string, { settings = false } = {}): Promise<Locator> {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("onden:open-settings", { detail: "modules" })));
  const card = page.locator(`.module-row[data-module=${module}]`);
  await expect(card).toBeVisible();
  if (!settings) return card;
  await card.locator(".module-row-open").click();
  const featurePage = page.locator(`.settings-module-page[data-module=${module}]`);
  await expect(featurePage).toBeVisible();
  return featurePage;
}

/** The tag page's own line of functions (everyone sees it): one
 *  `.tag-fn-entry` per function under the title, its quick action such as
 *  開始複習 (`.tag-function-quick`), its settings behind the gear and, for the
 *  owner, the × that takes it off. */
export function tagFunctionLine(page: Page): Locator {
  return page.getByRole("group", { name: /^(Functions|功能)$/ });
}

/** The tag page's line of fields: a chip per field (`.tag-field-item`,
 *  `data-field` = its name; a button for the owner) and 「＋ 新增欄位」. */
export function tagFieldLine(page: Page): Locator {
  return page.getByRole("group", { name: /^(Fields|欄位)$/ });
}

/** One function's entry in the tag page's line of functions, by its name in
 *  the interface language (the entry's text starts with it; its quick action
 *  follows). */
export function tagFunctionEntry(page: Page, title: string): Locator {
  return tagFunctionLine(page).locator(".tag-fn-entry", { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
}

/** On a tag's page, a function's settings: the gear on its entry opens them
 *  in a popover (a module tag's own settings only point to Settings ›
 *  Modules); returns the popover. */
export async function openFunctionDetails(page: Page, title: string): Promise<Locator> {
  // The gear and its popover carry the same name.
  const named = (role: "button" | "dialog", within: Page | Locator) => within.getByRole(role, { name: `Settings of “${title}”`, exact: true })
    .or(within.getByRole(role, { name: `「${title}」的設定`, exact: true }));
  const popover = named("dialog", page);
  if (!await popover.isVisible()) await named("button", tagFunctionEntry(page, title)).click();
  await expect(popover).toBeVisible();
  return popover;
}

/** A tag page's rare actions (move under another tag, export, hide,
 *  merge, delete) in the ⋯ menu by the title. */
export async function tagMenuAction(page: Page, name: string | RegExp): Promise<void> {
  await page.getByRole("button", { name: /^(Tag actions|標籤動作)$/ }).click();
  await page.getByRole("menuitem", { name }).click();
}

/** Remove every recovery copy in the failed-write panel and return how many
 *  there were. A write the server refuses (422/403) keeps the user's input as
 *  a recovery card (FailedWriteRecovery), fixed at the top of the screen over
 *  the page; a spec that provokes a refusal on purpose clears it before it
 *  clicks on. */
export async function clearRecoveryCopies(page: Page): Promise<number> {
  const panel = page.locator(".failed-write-recovery");
  const remove = panel.getByRole("button", { name: /^(Remove recovery copy|Dismiss|移除復原副本|關閉)$/ });
  let removed = 0;
  for (let i = 0; i < 20 && await remove.count(); i++) {
    const before = await remove.count();
    await remove.first().click();
    await expect.poll(() => remove.count()).toBeLessThan(before);
    removed++;
  }
  await expect(panel.locator(".fwr-card")).toHaveCount(0);
  return removed;
}

/** A saved view of a tag or note: its tab after 「內容」 (the first one by default). */
export async function openSavedViewTab(page: Page, name?: RegExp): Promise<void> {
  await (name ? page.getByRole("tab", { name }) : page.locator(".view-tabs [role=tab]").nth(1)).click();
}

/** On a tag's page, open a field's settings (FieldPopover: name, type,
 *  required, default, 「刪除欄位」, 「確定」): the chip of the field named
 *  `field`, or 「＋ 新增欄位」 when left out (a new field, unnamed until a name
 *  is typed). Needs the owner. Returns the popover. */
export async function openFieldEditor(page: Page, field?: string): Promise<Locator> {
  const fields = tagFieldLine(page);
  await (field === undefined
    ? fields.getByRole("button", { name: /^(Add field|新增欄位)$/ })
    : fields.locator(`.tag-field-item[data-field="${field}"]`)).click();
  const popover = page.getByRole("dialog", { name: /^(Field settings|欄位設定)$/ });
  await expect(popover).toBeVisible();
  return popover;
}

/** True when the workspace holds nothing but day notes and tags: the only
 *  state in which the first-run welcome banner appears. */
export async function workspaceIsNew(page: Page): Promise<boolean> {
  const { nodes = [] } = await (await page.request.get("/api/bootstrap")).json() as {
    nodes?: Array<{ node_type?: string; title?: string; hidden?: boolean; deleted_at?: string | null }>;
  };
  return !nodes.some((n) => !n.hidden && !n.deleted_at && n.node_type !== "class_tag" && !/^\d{4}-\d{2}-\d{2}$/.test(n.title ?? ""));
}

/** The tag chips and the one "＋" in the grey line under the open note's title (TitleTagRow);
 *  the sidebar has no tag row. A chip toggles its card below the row. */
export function titleTags(page: Page) {
  return page.locator(".note-document .title-tag-row");
}

/** The ＋ of the note's tag row (in the grey line under the title). On a wide
 *  screen a note without tags shows it only while the title area is pointed at
 *  or focused, so point at the title first. */
export async function titleTagAdd(page: Page): Promise<Locator> {
  const add = titleTags(page).locator(".prop-tag--add");
  // The row unfolds on .note-heading:hover (OverviewEditor.css). A pointer that
  // lands while the page is still settling (the membership gate's scrim, a
  // re-render) leaves it folded, so point again until it shows. Folded, the ＋
  // keeps its own box (the row clips it to 0 wide), so the row is what is checked.
  await expect(async () => {
    await page.locator(".note-document .obsidian-title-input").hover();
    await expect(titleTags(page)).toBeVisible({ timeout: 1_000 });
    await expect(add).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  return add;
}

/** A suggestion of the tag row's "＋" input. The list floats in a popover
 *  (portaled out of the row since the 2026-10-31 Popover move), so it is found
 *  by the input's aria-controls id, not inside the row. */
export function titleTagOption(page: Page, name: string | RegExp, { exact = true } = {}): Locator {
  return page.locator("#title-tag-options").getByRole("option", { name, exact });
}

/** Open the note's ⋯ menu and its 「顯示…」 submenu (wide screens: full width,
 *  side-by-side, preview, writing mode, new view). */
export async function openDisplayMenu(page: Page): Promise<Locator> {
  await page.locator(".note-actions-more-btn").first().click(); // on the view-tab strip since 2026-11-03
  await page.getByRole("menuitem", { name: /^(Display…|顯示…)$/ }).click();
  return page.getByRole("menu", { name: /^(Display|顯示)$/ });
}

/** Apply an existing tag through "＋" in the grey line under the note title: type its name,
 *  pick it from the suggestions. */
export async function applyTagFromTitle(page: Page, name: string): Promise<void> {
  const row = titleTags(page);
  // A reconnect briefly makes the workspace inert (membership gate), which
  // blurs and closes the input; wait it out and try again once.
  for (let attempt = 0; ; attempt++) {
    await expect(page.locator(".membership-gate")).toBeHidden({ timeout: 30_000 });
    const input = row.getByRole("combobox", { name: "Add a tag" });
    // A failed first try can leave the input open (then there is no ＋).
    if (!(await input.isVisible())) await (await titleTagAdd(page)).click();
    await input.fill(name);
    const option = titleTagOption(page, `#${name}`);
    try {
      await option.click({ timeout: 5_000 });
      return;
    } catch (error) {
      if (attempt >= 1) throw error;
    }
  }
}

/** The module's tag (#review, #paper; docs/architecture/module-library.md).
 *  Importing the module makes sure it exists — idempotent, the test owner
 *  must be the admin. Returns its id and current name. */
export async function moduleTag(page: Page, module: string): Promise<{ id: string; name: string }> {
  const origin = new URL(page.url() === "about:blank" ? BASE : page.url()).origin;
  const response = await page.request.patch("/api/workspace/modules", {
    headers: { origin, "content-type": "application/json" }, data: { module, imported: true },
  });
  expect(response.ok(), `importing ${module} (needs the owner)`).toBe(true);
  const id = (await response.json() as { module_tag_id: string }).module_tag_id;
  const tag = await (await page.request.get(`/api/tags/${id}`)).json() as { name: string };
  return { id, name: tag.name };
}

/** Give a tag a function the way the server stores it (PUT /api/tags/:id/functions/:id), then wait until
 *  its entry shows on the page. The page has no 「加功能」 any more (2026-11-12), so a spec that needs a tag
 *  holding a function sets it up here; `title` is the function's name in the interface language, `functionId`
 *  the module id. The page must already show the tag. */
export async function giveTagFunction(page: Page, tagId: string, functionId: string, title: string): Promise<void> {
  const response = await page.request.put(`/api/tags/${tagId}/functions/${functionId}`, { ...H, data: {} });
  expect(response.ok(), `giving the tag ${functionId}`).toBe(true);
  await page.reload();
  await expect(tagFunctionEntry(page, title)).toBeVisible();
}

/** On a tag's page, take a function off the tag: the × on its entry (there
 *  only when the tag itself has it — not through its own module tag or a tag
 *  above), then wait until the entry is gone. Needs the owner. */
export async function removeFunctionViaChip(page: Page, title: string): Promise<void> {
  const entry = tagFunctionEntry(page, title);
  await entry.getByRole("button", { name: /^(Remove “.*” from #|從 #.* 移除「.*」$)/ }).click();
  await expect(entry).toHaveCount(0);
}

// ── Spaces (docs/architecture/spaces.md) ─────────────────────────────────────
// A note's space decides who can read (any member) and write (editor/manager)
// it. POST /api/nodes without parent_id/space_id lands in the CREATOR'S
// personal space, so a note another person/agent must see is created with
// `space_id: await defaultSpaceId(request)` (or moved there).

/** Id of the workspace's default shared space (共用 / Shared). */
export async function defaultSpaceId(request: APIRequestContext): Promise<string> {
  const res = await request.get("/api/spaces");
  expect(res.ok(), `GET /api/spaces ${res.status()}`).toBe(true);
  const { spaces } = await res.json() as { spaces: Array<{ id: string; is_default: boolean }> };
  const space = spaces.find((s) => s.is_default);
  if (!space) throw new Error("defaultSpaceId: caller is not a member of the default space");
  return space.id;
}

/** Add an actor (usually an agent) to the default space 共用. Membership is
 *  explicit since migration 097: a new member or agent joins no shared space by
 *  itself, and an agent's token reaches only the spaces the agent is in. The
 *  caller must be the owner (the e2e user is). A member's permission in a space
 *  is view or edit (2026-10-22 roles; the old `role` body is refused). */
export async function addToDefaultSpace(request: APIRequestContext, actorId: string, permission: "view" | "edit" = "edit"): Promise<void> {
  const res = await request.put(`/api/spaces/${await defaultSpaceId(request)}/members/${actorId}`, { ...H, data: { permission } });
  expect(res.ok(), `PUT /api/spaces/…/members ${res.status()}`).toBe(true);
}

/** Create a shared space; the caller becomes its only member (manager). New
 *  spaces start with publish and external_ai off. Returns its id. */
export async function createSpace(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post("/api/spaces", { ...H, data: { name } });
  expect(res.ok(), `POST /api/spaces: ${await res.text()}`).toBe(true);
  return (await res.json() as { id: string }).id;
}

/** A shared space whose 「發布到網站」 switch is on: a note made in it is on the site at the next publish unless it is
 *  kept off (`keepOffSite`). The default space starts with the switch off, so a spec that expects a note on the site
 *  makes it here; its other notes stay in the default space and stay private. */
export async function createPublishingSpace(request: APIRequestContext, name = `Site ${Date.now()}`): Promise<string> {
  const id = await createSpace(request, name);
  const res = await request.patch(`/api/spaces/${id}`, { ...H, data: { capabilities: { publish: true } } });
  expect(res.ok(), `PATCH /api/spaces/${id}: ${await res.text()}`).toBe(true);
  return id;
}

/** 「不發布」: the note's own exception to a space that publishes. */
export async function keepOffSite(request: APIRequestContext, nodeId: string): Promise<void> {
  const res = await request.put(`/api/nodes/${nodeId}/attributes/_published`, { ...H, data: { value: "false", value_type: "bool" } });
  expect(res.ok(), `keep ${nodeId} off the site`).toBeTruthy();
}

/** Move a note (and its subtree) to a space: preview for the membership
 *  epoch, then move. */
export async function moveToSpace(request: APIRequestContext, nodeId: string, spaceId: string): Promise<void> {
  const preview = await request.get(`/api/spaces/move-preview?node=${nodeId}&to=${spaceId}`);
  expect(preview.ok(), `move-preview: ${await preview.text()}`).toBe(true);
  const { membership_epoch } = await preview.json() as { membership_epoch: string };
  const moved = await request.post("/api/spaces/move", {
    ...H, data: { node_id: nodeId, to_space_id: spaceId, membership_epoch },
  });
  expect(moved.ok(), `move: ${await moved.text()}`).toBe(true);
}

/** Hide a note from everyone but the caller: a fresh shared space nobody else
 *  belongs to, and the note moved into it. Returns the space id. */
export async function hideFromOthers(request: APIRequestContext, nodeId: string): Promise<string> {
  const spaceId = await createSpace(request, `Hidden ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  await moveToSpace(request, nodeId, spaceId);
  return spaceId;
}

/** Id of the caller's personal space ("Only me"). Its capabilities (publish,
 *  external_ai) start off and are the owner's to switch. */
export async function personalSpaceId(request: APIRequestContext): Promise<string> {
  const { spaces } = await (await request.get("/api/spaces")).json() as { spaces: Array<{ id: string; kind: string }> };
  const space = spaces.find((s) => s.kind === "personal");
  if (!space) throw new Error("personalSpaceId: caller has no personal space");
  return space.id;
}

// Seeding a board's cards. Since #62 a board's layout is written only through
// PATCH /api/boards/:id (cards and sections upserted by id); PATCH
// /api/canvases/:id with a whole `data` answers 410. Specs written against the
// old shape pass the same options here: `data.data.nodes` become card
// upserts and `data.data.sections` section upserts (`edges` were never board
// layout). The board starts empty, so upserting the listed cards is the same
// as the old whole-layout write; resending a list keeps earlier cards.
type LegacyLayout = { headers?: Record<string, string>; data: { data: { nodes?: unknown[]; sections?: unknown[]; edges?: unknown[] } } };
export function seedLayout(request: APIRequestContext, boardId: string, opts: LegacyLayout) {
  const { nodes = [], sections = [] } = opts.data.data;
  return request.patch(`/api/boards/${boardId}`, {
    headers: opts.headers,
    data: { cards: { upsert: nodes }, ...(sections.length ? { sections: { upsert: sections } } : {}) },
  });
}

/** In the open Settings tab, unfold its advanced settings (the backend URL,
 *  the .sqlite3 backup, tag packs). A no-op when the tab has none. */
export async function showAdvancedSettings(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: /^Show advanced settings$|^顯示進階設定$/ });
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
}

/** Publish the site: store a new snapshot of the notes currently marked
 *  `_published` (POST /api/publish). Snapshot model B (docs/architecture/
 *  site-render-model.md): marking a note only opts it in; /api/site and /site/*
 *  serve the LAST snapshot minus takedowns, so a spec that expects a newly
 *  marked note on the public site must publish first. Unpublishing, locking
 *  and deleting need no publish — takedowns apply live. */
export async function publishSite(request: APIRequestContext, data: Record<string, unknown> = {}): Promise<void> {
  const res = await publishRequest(request, data);
  expect(res.status(), `POST /api/publish: ${await res.text()}`).toBe(201);
}

/** POST /api/publish as the app sends it: preview the candidate, then publish exactly that one by its hash (the route
 *  refuses a publish without it). A refused preview (a 403 for someone who may not publish, a 400) is the answer. */
export async function publishRequest(request: APIRequestContext, data: Record<string, unknown> = {}): Promise<APIResponse> {
  const preview = await request.post("/api/publish/preview", { ...H, data });
  if (!preview.ok()) return preview;
  const { hash } = (await preview.json()) as { hash: string };
  return request.post("/api/publish", { ...H, data: { ...data, preview_hash: hash } });
}

/** A SiteDesign v2 (docs/architecture/proposals/publish-redesign-2026-10-24.md §5.2)
 *  spelled out, so a spec does not import the workspace package: the home note's
 *  first paragraph as a cover, then a stack with the tag's list view. Pass `css`
 *  for the site-wide CSS and `frames` to override frame switches. */
export function siteDesign(opts: {
  homeNoteId?: string; tagId?: string; css?: string;
  frames?: { article?: Record<string, boolean>; tag?: Record<string, boolean>; date_tags?: string[] };
} = {}): Record<string, unknown> {
  const part = { bg: "none", heading: "auto", cls: "", css: "" };
  const content: unknown[] = [];
  if (opts.homeNoteId) {
    content.push({ type: "cover", props: { id: "e2e-cover", height: "m", ...part, items: [
      { type: "note", props: { id: "e2e-home-note", noteId: opts.homeNoteId, blockId: "", display: "first" } },
    ] } });
  }
  if (opts.tagId) {
    content.push({ type: "stack", props: { id: "e2e-list", ...part, items: [
      { type: "tag_view", props: { id: "e2e-tag-view", tagId: opts.tagId, viewId: "", viewKind: "list", limit: 12, sort: "new" } },
    ] } });
  }
  const article = { nav: true, cover: true, date: true, tags: true, card: false, backlinks: true, prevnext: true, toc: true, tree: false, footer: true };
  return {
    v: 2, rev: "", studio_draft: true,
    home: { root: { props: {} }, content },
    style: { preset: "quiet", base: 17, ratio: 1.25, density: "mid", head: "serif", body: "serif", accent: "#3f7d6e", radius: 4 },
    css: opts.css ?? "",
    frames: {
      article: { ...article, ...opts.frames?.article },
      tag: { nav: true, description: true, footer: true, ...opts.frames?.tag },
      date_tags: opts.frames?.date_tags ?? ["文章"],
    },
  };
}

/** Save the owner's site design (the workspace chrome); `null` clears it, which
 *  gives back the default design. The next publish serves what is saved here. */
export async function saveSiteDesign(request: APIRequestContext, design: Record<string, unknown> | null): Promise<void> {
  const current = await (await request.get("/api/workspace/config")).json();
  const base = (current?.chrome as { rev?: string } | null | undefined)?.rev ?? null;
  const res = await request.patch("/api/workspace/config", { ...H, data: { chrome: design, chrome_base: base } });
  expect(res.status(), `PATCH /api/workspace/config (chrome): ${await res.text()}`).toBeLessThan(300);
}

/** Put a label tag (made by name if new) on a note; returns the tag's id. */
export async function tagNote(request: APIRequestContext, nodeId: string, tagName: string): Promise<string> {
  const resolved = await request.post("/api/tags/resolve-path", { ...H, data: { path: tagName } });
  const tagId = (await resolved.json()).leaf_id as string;
  const put = await request.put(`/api/nodes/${nodeId}/tags/${tagId}`, { ...H, data: {} });
  expect(put.ok(), `tag ${tagName}`).toBeTruthy();
  return tagId;
}

/** Mark a note published (the opt-in); it reaches readers at the next publishSite. */
export async function markPublished(request: APIRequestContext, nodeId: string): Promise<void> {
  const res = await request.put(`/api/nodes/${nodeId}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
  expect(res.ok(), `mark ${nodeId} published`).toBeTruthy();
}

/** Flip the open note between editing and preview: the 編輯｜並排｜預覽 icons beside ⋯
 *  on a wide screen, ⋯ on a phone (its bottom sheet's tile says where it goes:
 *  "Preview", then "Edit"). */
export async function switchNoteView(page: Page, to: "preview" | "edit"): Promise<void> {
  const name = to === "preview" ? "Preview" : "Edit";
  const phoneName = name;
  if ((page.viewportSize()?.width ?? 1280) > 900) {
    await page.getByRole("radiogroup", { name: "Display" }).filter({ visible: true }).first().getByRole("radio", { name, exact: true }).click();
  } else {
    await page.getByRole("button", { name: "More actions" }).filter({ visible: true }).first().click();
    await page.getByRole("menuitem", { name: phoneName, exact: true }).click();
  }
}

/** A new note's board follows its sub-notes (auto tree, c2200098), so it is never blank: the note itself is its one card.
 *  Switch following off (Display › Follow sub-notes) for a board of only the person's own cards, empty until they add one. */
export async function boardOwnCardsOnly(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Display", exact: true }).click();
  const follow = page.getByRole("switch", { name: "Follow sub-notes" });
  await expect(follow).toHaveAttribute("aria-checked", "true");
  await follow.click();
  await expect(follow).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
}

/** An item in the board tool bar's ⋯ menu (Tidy up, Arrange as tree, export, import, switches …); opens the menu first. */
export async function boardMoreItem(page: Page, name: string): Promise<Locator> {
  await page.getByRole("button", { name: "More tools", exact: true }).click();
  return page.getByRole("menuitem", { name }).or(page.getByRole("menuitemcheckbox", { name }));
}

// The sync state as the app shows it. The top bar has no standing sync dot
// (AppTopbar, 2026-10-29): offline, waiting and stuck changes show as a badge
// on the avatar, whose label carries the count ("2 changes waiting to sync",
// "Offline — 2 changes will sync on reconnect"). The full status sits in the
// avatar's dialog.
export const syncBadge = (page: Page): Locator => page.locator(".user-chip .user-badge");

/** The avatar badge's label, "" when there is no trouble. */
export async function syncLabel(page: Page): Promise<string> {
  // One read: a badge counted and then read can be gone in between (the drain
  // removes it), and getAttribute would then wait for one to come back.
  return syncBadge(page).evaluateAll((badges) => badges[0]?.getAttribute("aria-label") ?? "");
}

/** Changes waiting to sync, as the avatar badge counts them (0 without a badge). */
export async function pendingCount(page: Page): Promise<number> {
  const label = await syncLabel(page);
  if (/recovery/i.test(label)) return 0;
  const n = /\d+/.exec(label);
  return n ? Number(n[0]) : 0;
}

export async function expectOnline(page: Page): Promise<void> {
  await expect(page.locator(".user-chip").first()).toBeVisible();
  await expect(page.locator(".user-chip .user-badge--offline")).toHaveCount(0);
}

export async function expectOffline(page: Page): Promise<void> {
  await expect(page.locator(".user-chip .user-badge--offline").first()).toBeVisible();
}

export async function expectPending(page: Page, { timeout }: { timeout?: number } = {}): Promise<void> {
  await expect.poll(() => pendingCount(page), { timeout }).toBeGreaterThan(0);
}

export async function expectNoPending(page: Page, { timeout }: { timeout?: number } = {}): Promise<void> {
  await expect.poll(() => pendingCount(page), { timeout }).toBe(0);
}

/** The Tasks page (modules/tasks/TasksMode): one of its four tabs — Today,
 *  Coming up, Anytime, Someday (English locale). A task's home tab is set by
 *  its own fields (lib/tasks/taskModel bucketTasks). */
export async function openTasksTab(page: Page, name: "Today" | "Coming up" | "Anytime" | "Someday"): Promise<void> {
  const tab = page.locator(".tasks-tabs").getByRole("tab", { name: new RegExp(`^${name}\\d*$`) });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

/** A task's row on the Tasks page (TaskRow: `li.tk-row`). */
export function taskRow(page: Page, title: string): Locator {
  return page.locator(".tasks-page .tk-row", { hasText: title });
}

/** Open Settings the way a person does — a computer: the gear at the end of the top bar; a phone: the
 *  avatar's account sheet › 「Settings」 — then, when given, one section of its side list. */
export async function openSettingsFromAvatar(page: Page, section?: string): Promise<void> {
  const gear = page.locator(".app-topbar .topbar-settings");
  // The bar draws the gear and the avatar in one render: wait for the bar before asking which layout this is,
  // or a page that has only just loaded reads as "no gear" and is sent down the phone path.
  // A phone that reopens on the note it last had open keeps BOTH in the page (the top bar is only hidden), so ask which
  // one is visible instead of a `.or()` locator, which is a strict-mode error when two elements match.
  const chip = page.locator(".app-topbar .user-chip");
  const back = page.getByRole("button", { name: "Back to notes list" });
  await expect.poll(async () => (await chip.isVisible()) || (await back.isVisible()), { message: "the top bar or a way back to it" }).toBe(true);
  if (await gear.isVisible()) await gear.click();
  else await accountSheetAction(page, /^(Settings|設定)$/);
  if (section) await page.locator(".settings-nav-item", { hasText: section }).click();
}

/** Open the account sheet (the avatar in the top bar, desktop and phone) and press one of its buttons. */
async function accountSheetAction(page: Page, name: RegExp): Promise<void> {
  // A phone shows an open note instead of the top bar: go back to the list first.
  const chip = page.locator(".app-topbar .user-chip");
  const back = page.getByRole("button", { name: "Back to notes list" });
  await expect.poll(async () => (await chip.isVisible()) || (await back.isVisible()), { message: "the top bar or a way back to it" }).toBe(true);
  if (!(await chip.isVisible())) await back.click();
  await chip.click();
  await page.locator(".account-dialog").getByRole("button", { name }).click();
}

/** Open 「Spaces and members」 (Settings, owner only) the way a person does: avatar › Spaces and members.
 *  Returns its screen (`.spaces-and-members`). */
export async function openMembers(page: Page): Promise<Locator> {
  await accountSheetAction(page, /^(Spaces and members|空間與成員)$/);
  const screen = page.locator(".spaces-and-members");
  await expect(screen).toBeVisible();
  return screen;
}

/** Open one person's (or AI role's) detail in 「Spaces and members」 by name; returns the screen. */
export async function openMember(page: Page, name: string | RegExp): Promise<Locator> {
  const screen = await openMembers(page);
  await screen.locator("li.sm-row[data-person-type] .sm-row-main", { hasText: name }).first().click();
  return screen;
}

/** An AI agent with a bearer token, made through the owner's API the way the
 *  app does now (2026-10-22 roles): the actor has no workspace role (sending
 *  one is refused), the token is `access: "read" | "write"`, and the agent
 *  reaches only the spaces it is a member of — here 共用, unless
 *  `space: false`. Returns its id, the token and ready request headers. */
export async function createAgent(
  request: APIRequestContext, name: string,
  { access = "write", space = true, reviewRule = "suggest" }: { access?: "read" | "write"; space?: boolean; reviewRule?: "suggest" | "apply" } = {},
): Promise<{ id: string; token: string; headers: Record<string, string> }> {
  const made = await request.post("/api/actors", { ...H, data: { name, type: "agent" } });
  expect(made.ok(), `POST /api/actors ${made.status()} ${await made.text()}`).toBe(true);
  const { id } = await made.json() as { id: string };
  // A new agent's note edits are suggestions (services/aiRoles). "apply" makes
  // it an AI role (an @handle) whose review rule is 「直接編輯」, as Settings ›
  // Spaces and members does, so its edits land directly.
  if (reviewRule === "apply") {
    const handle = `e2e${id.replace(/-/g, "").slice(0, 12)}`;
    const runner = await request.put(`/api/agent-sessions/runners/${id}`, { ...H, data: { handle } });
    expect(runner.ok(), `PUT runner ${runner.status()} ${await runner.text()}`).toBe(true);
    const rule = await request.patch(`/api/ai/roles/${id}`, { ...H, data: { review_rule: "apply" } });
    expect(rule.ok(), `PATCH role ${rule.status()} ${await rule.text()}`).toBe(true);
  }
  const minted = await request.post(`/api/actors/${id}/tokens`, { ...H, data: { name: `${name} token`, access } });
  expect(minted.ok(), `POST /api/actors/…/tokens ${minted.status()} ${await minted.text()}`).toBe(true);
  const { token } = await minted.json() as { token: string };
  if (space) await addToDefaultSpace(request, id);
  return { id, token, headers: { origin: BASE, "content-type": "application/json", authorization: `Bearer ${token}` } };
}

/** A new agent's note edits are suggestions the person decides on (2026-10-30,
 *  services/aiSuggestions): its MCP updateNode answers `status: "suggested"`
 *  and the note is unchanged until accepted. Accept every pending place of
 *  `nodeId` the way the note's 「有 N 處等你決定」 does, so the agent's text
 *  lands. Returns how many suggestions were accepted. */
export async function acceptAgentSuggestions(request: APIRequestContext, nodeId: string): Promise<number> {
  const res = await request.get(`/api/ai-suggestions?node_id=${nodeId}`);
  expect(res.ok(), `GET /api/ai-suggestions ${res.status()}`).toBe(true);
  const { suggestions } = await res.json() as { suggestions: Array<{ id: string }> };
  for (const s of suggestions) {
    const accepted = await request.post(`/api/ai-suggestions/${s.id}/accept`, { ...H, data: { item_ids: "all" } });
    expect(accepted.ok(), `accept ${accepted.status()} ${await accepted.text()}`).toBe(true);
  }
  return suggestions.length;
}

/** A valid 1×1 RGBA PNG, base64. Uploads are decoded by the server now
 *  (services/media.ts runs sharp), so a fixture must be a real image: the one
 *  the specs used to carry had a truncated IDAT chunk. */
export const PNG_1X1_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Phone: the notes home (the list with 標籤｜筆記｜收件匣). /?view=notes first
 *  opens the note the launch setting picks (today's by default,
 *  useLandingNote) full screen; the list is one step back. */
export async function phoneNotesHome(page: Page): Promise<void> {
  await ready(page, "/?view=notes");
  await expect(page).toHaveURL(/[?&]node=/); // the landing note opened
  await page.locator(".omt-back").click();
  await expect(page.locator(".obsidian-sidebar .sidebar-tab").first()).toBeVisible();
}

/** Bring a sidebar row (`[data-sb-id]`) into view. The list is windowed past a
 *  few hundred rows, so a far row is not in the page until the list scrolls
 *  near it: scroll down step by step (the list on desktop, the page on a
 *  phone) until it is there. */
export async function scrollToSidebarRow(page: Page, id: string): Promise<Locator> {
  const row = page.locator(`[data-sb-id="${id}"]`);
  await expect(page.locator(".obsidian-sidebar").filter({ visible: true }).first()).toBeVisible();
  // From the top, a screen at a time, until the row is rendered or the list ends.
  let atEnd = false;
  for (let step = 0; !(await row.count()) && !atEnd; step++) {
    atEnd = await page.evaluate((first) => {
      // The list's own scroller: the list on desktop, an ancestor on a phone.
      let el = document.querySelector<HTMLElement>(".obsidian-page-list") ?? document.querySelector<HTMLElement>(".obsidian-sidebar");
      while (el && !(el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
      const scroller = el ?? document.scrollingElement!;
      if (first) { scroller.scrollTop = 0; return false; }
      const before = scroller.scrollTop;
      scroller.scrollTop += scroller.clientHeight * 0.8;
      return scroller.scrollTop === before;
    }, step === 0);
    // Let the windowed list render the rows it now shows.
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  }
  await expect(row, "the row is in the notes list").toHaveCount(1);
  await row.scrollIntoViewIfNeeded();
  return row;
}

/** An agent's changes to a note are decided in that note (review → inbox,
 *  2026-10-30): the inbox tab's 「等你決定」 lists the note; opening it shows
 *  the note with its review cards (NoteDecisions: `.inbox-review-item`,
 *  approve / reject). Returns the row in the inbox, for "it left" checks. */
export async function openNoteDecisions(page: Page, noteTitle: string): Promise<Locator> {
  await page.locator('.sidebar-tab:has-text("Inbox")').click();
  const row = page.getByRole("button", { name: `Open “${noteTitle}” to decide`, exact: true });
  await row.click();
  await expect(page.locator(".obsidian-title-input")).toHaveValue(noteTitle);
  await expect(page.locator(".inbox-review-item").first()).toBeVisible();
  return row;
}
