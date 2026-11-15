// Screenshot journeys for the 2026-10-05 changes, against the isolated stack:
//   • tag function cards come from the module registry (desktop + phone);
//   • a sidebar pointer pinned on one client reaches another without reload,
//     disappears there when removed, and is read from the local mirror when the
//     data API is unreachable on reload;
//   • a [[wikilink]] written on one client shows up as a backlink on another
//     without reload, and disappears when the link is removed.
// Screenshots go to /tmp/pw-output/shots (host: /tmp/pw-host-out/shots).
import { test, expect, type Browser, type Page } from "@playwright/test";
import { ready, renderSettled, moduleTag, giveTagFunction, tagFunctionLine, BASE, H } from "./helpers";

const STATE = process.env.E2E_STORAGE || "/tmp/pw-auth.json";
const WRITE = H;
const SHOTS = "/tmp/pw-output/shots";
const PHONE = { width: 390, height: 844 };

async function shot(page: Page, name: string): Promise<void> {
  await renderSettled(page);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function english(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("today-changes-started")) return;
    sessionStorage.setItem("today-changes-started", "1");
    localStorage.setItem("onden.locale", "en");
  });
}

async function createNote(page: Page, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await page.request.post("/api/nodes", { ...WRITE, data: { title, markdown: `${title} body`, ...extra } });
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

/** Wait until this client's saved local snapshot (sql.js bytes in IndexedDB,
 *  written after a short debounce) contains `text` — e.g. a row id. */
async function waitForLocalSnapshot(page: Page, text: string): Promise<void> {
  await expect.poll(() => page.evaluate(async (needle) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("onden-storage");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      if (!db.objectStoreNames.contains("sqlite")) return false;
      const values = await new Promise<unknown[]>((resolve, reject) => {
        const req = db.transaction("sqlite", "readonly").objectStore("sqlite").getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const bytes = new TextEncoder().encode(needle);
      return values.some((value) => {
        if (!(value instanceof ArrayBuffer)) return false;
        const hay = new Uint8Array(value);
        outer: for (let i = 0; i + bytes.length <= hay.length; i++) {
          for (let j = 0; j < bytes.length; j++) if (hay[i + j] !== bytes[j]) continue outer;
          return true;
        }
        return false;
      });
    } finally { db.close(); }
  }, text), { timeout: 15_000, message: `local snapshot never contained ${text}` }).toBe(true);
}

async function twoClients(browser: Browser) {
  const ctxA = await browser.newContext({ baseURL: BASE, storageState: STATE });
  const ctxB = await browser.newContext({ baseURL: BASE, storageState: STATE });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await english(pageA);
  await english(pageB);
  return { ctxA, ctxB, pageA, pageB };
}

test.beforeEach(() => {
  const target = new URL(BASE);
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(target.hostname);
  expect(["5099", "5100"], "these journeys write test data; isolated stack only").toContain(target.port);
});

test("a tag that holds functions shows them on its page, and none otherwise", async ({ page }) => {
  await english(page);
  const stamp = Date.now();
  const name = `Course ${stamp}`;
  const resolved = await page.request.post("/api/tags/resolve-path", { ...WRITE, data: { path: name } });
  expect(resolved.ok()).toBe(true);
  const tagId = (await resolved.json()).leaf_id as string;
  const noteId = await createNote(page, `Lecture ${stamp}`);
  expect((await page.request.put(`/api/nodes/${noteId}/tags/${tagId}`, { ...WRITE, data: {} })).ok()).toBe(true);

  const skillsTag = await moduleTag(page, "skills");
  const review = await moduleTag(page, "review");
  await ready(page, `/?view=notes&node=${tagId}`);
  // Each function is an entry on the functions line under the title.
  const cards = tagFunctionLine(page).locator(".tag-fn-entry");
  await expect(cards).toHaveCount(0);
  await expect(tagFunctionLine(page)).toHaveCount(0);
  await shot(page, "01-tag-page-no-abilities");

  await giveTagFunction(page, tagId, "skills", "Skills");
  await giveTagFunction(page, tagId, "review", "Review");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("Skills");
  await expect(cards.nth(1)).toContainText("Review");
  await tagFunctionLine(page).scrollIntoViewIfNeeded();
  await shot(page, "02-tag-page-abilities");

  // The server stored what the tag extends, in the order picked.
  const tag = await (await page.request.get(`/api/tags/${tagId}`)).json();
  expect(tag.extends).toEqual([skillsTag.id, review.id]);

  // The tags overview page is gone (?view=tags falls back to the notes); tags are listed in
  // the sidebar, whose rows carry no functions (SidebarTagTree) — a row opens the tag's page,
  // and that page shows the functions.
  await ready(page, "/?view=notes");
  const listed = page.locator(".obsidian-sidebar").getByRole("button", { name: `Open #${name}`, exact: true });
  await listed.scrollIntoViewIfNeeded();
  await listed.click();
  await expect(cards).toHaveCount(2);
  await expect(tagFunctionLine(page)).toContainText("Skills");
  await expect(tagFunctionLine(page)).toContainText("Review");
  await shot(page, "03-tags-overview-functions");

  await page.setViewportSize(PHONE);
  await ready(page, `/?view=notes&node=${tagId}`);
  await tagFunctionLine(page).scrollIntoViewIfNeeded();
  await shot(page, "04-tag-page-functions-phone");
});

test("a pinned pointer reaches another client and survives an unreachable API", async ({ browser }) => {
  const { ctxA, ctxB, pageA, pageB } = await twoClients(browser);
  try {
    const stamp = Date.now();
    // A very low sort order keeps the parent at the top of a busy shared tree.
    const parentId = await createNote(pageA, `Pin folder ${stamp}`, { sort_order: -1_000_000 });
    const targetTitle = `Pinned note ${stamp}`;
    const targetId = await createNote(pageA, targetTitle);

    await ready(pageB);
    const parentRow = pageB.locator(`[data-sb-id="${parentId}"]`);
    await expect(parentRow).toBeVisible({ timeout: 20_000 });
    await shot(pageB, "05-client-b-before-pin");

    const pinned = await pageA.request.post("/api/pointers", { ...WRITE, data: { target_id: targetId, parent_id: parentId } });
    expect(pinned.status()).toBe(201);
    const pointerId = ((await pinned.json()) as { id: string }).id;

    // B learns of it through SSE → /api/sync, without a reload: the parent
    // turns into a group whose expansion shows the pinned reference.
    const group = pageB.locator(`.obsidian-group[data-sb-id="${parentId}"]`);
    await expect(group).toBeVisible({ timeout: 20_000 });
    if ((await group.getAttribute("data-sb-expanded")) !== "true") await group.locator(".obsidian-group-toggle").click();
    const pointerRow = pageB.locator(`[data-sb-id="ptr-${pointerId}"]`);
    await expect(pointerRow).toContainText(targetTitle);
    await shot(pageB, "06-client-b-pin-arrived");

    // The pointer is now in B's saved local mirror. Reload B while the data
    // API is unreachable: the tree has to come from that mirror.
    await waitForLocalSnapshot(pageB, pointerId);
    await pageB.route(/\/api\/(bootstrap|sync|events|canvases)/, (route) => route.abort());
    await pageB.reload({ waitUntil: "load" });
    const offlineGroup = pageB.locator(`.obsidian-group[data-sb-id="${parentId}"]`);
    await expect(offlineGroup).toBeVisible({ timeout: 30_000 });
    if ((await offlineGroup.getAttribute("data-sb-expanded")) !== "true") await offlineGroup.locator(".obsidian-group-toggle").click();
    await expect(pageB.locator(`[data-sb-id="ptr-${pointerId}"]`)).toContainText(targetTitle);
    await shot(pageB, "07-client-b-pin-from-local-mirror");
    await pageB.unroute(/\/api\/(bootstrap|sync|events|canvases)/);
    await ready(pageB);

    expect((await pageA.request.delete(`/api/pointers/${pointerId}`, WRITE)).ok()).toBe(true);
    await expect(pageB.locator(`[data-sb-id="ptr-${pointerId}"]`)).toHaveCount(0, { timeout: 20_000 });
    await shot(pageB, "08-client-b-pin-removed");
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

test("a wikilink written on one client becomes a backlink on another", async ({ browser }) => {
  const { ctxA, ctxB, pageA, pageB } = await twoClients(browser);
  try {
    const stamp = Date.now();
    const targetTitle = `Backlink target ${stamp}`;
    const sourceTitle = `Backlink source ${stamp}`;
    const targetId = await createNote(pageA, targetTitle);
    const sourceId = await createNote(pageA, sourceTitle);

    await ready(pageB, `/?view=notes&node=${targetId}`);
    const empty = pageB.locator(".ov-panel-empty", { hasText: "No linked notes yet" });
    if (!(await empty.isVisible())) {
      // Reveal the inspector the way navBackStack.spec does when it starts collapsed.
      await pageB.locator(".notes-inspector-toggle").first().click();
    }
    await expect(pageB.locator(".backlink-card", { hasText: sourceTitle })).toHaveCount(0);
    await shot(pageB, "09-client-b-no-backlink");

    const linked = await pageA.request.patch(`/api/nodes/${sourceId}`, { ...WRITE, data: { markdown: `See [[${targetTitle}]] for details.` } });
    expect(linked.ok()).toBe(true);
    const card = pageB.locator(".backlink-card", { hasText: sourceTitle });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await shot(pageB, "10-client-b-backlink-arrived");

    const unlinked = await pageA.request.patch(`/api/nodes/${sourceId}`, { ...WRITE, data: { markdown: "No links any more." } });
    expect(unlinked.ok()).toBe(true);
    await expect(card).toHaveCount(0, { timeout: 20_000 });
    await shot(pageB, "11-client-b-backlink-removed");
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
