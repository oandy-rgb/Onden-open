import { test, expect, type Page, type Request } from "@playwright/test";
import { ready, selectNodeByTitle, seedLayout, H, expectNoPending, expectOffline, expectOfflineReady, expectOnline, expectPending, fillWhenReady } from "./helpers";

type Item = { id: string; title: string };
type Fixture = { a: Item; b: Item; boardA: Item; boardB: Item; createTag: () => Promise<Item>; trackCanvas: (id: string) => void };

async function withBoards(page: Page, run: (fixture: Fixture) => Promise<void>) {
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));
  const cleanup: string[] = [];
  const stamp = `Canvas-nav ${Date.now()}`;
  async function create(path: string, title: string): Promise<Item> {
    const response = await page.request.post(path, { ...H, data: {
      title, ...(path === "/api/nodes" ? { markdown: `${title} body` } : {}),
    } });
    expect(response.ok()).toBeTruthy();
    const item = await response.json() as Item;
    cleanup.push(`${path}/${item.id}`);
    return item;
  }
  try {
    const a = await create("/api/nodes", `${stamp} note A`);
    const b = await create("/api/nodes", `${stamp} note B`);
    const boardA = await create("/api/canvases", `${stamp} board A`);
    const boardB = await create("/api/canvases", `${stamp} board B`);
    for (const [board, note] of [[boardA, a], [boardB, b]]) {
      const response = await seedLayout(page.request, board.id, { ...H,
        data: { data: { nodes: [{ nodeId: note.id, x: 60, y: 60, width: 280 }] } },
      });
      expect(response.ok()).toBeTruthy();
    }
    const createTag = async () => {
      const title = `${stamp} tag`;
      const response = await page.request.post("/api/tags/resolve-path", { ...H, data: { path: title } });
      expect(response.ok()).toBeTruthy();
      const { leaf_id: id } = await response.json();
      cleanup.push(`/api/nodes/${id}`);
      return { id, title };
    };
    await run({ a, b, boardA, boardB, createTag, trackCanvas: id => cleanup.push(`/api/canvases/${id}`) });
  } finally {
    // Stop the live client before deleting only this case's isolated fixtures.
    await page.goto("about:blank");
    for (const path of cleanup.reverse()) {
      const response = await page.request.delete(path, H);
      expect(response.ok()).toBeTruthy();
    }
  }
}

// A board is a view of a note (#812 #823): it opens from the note — its own
// sidebar row, a link, the create sheet's 「Canvas」 — on its whiteboard tab.
// The old global 白板 destination with its board chooser (#734) and the
// board's tab strip (b48f1f34) are gone, so their checks went with them.
const card = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);

test("note navigation and card selection keep their distinct views", async ({ page }) => {
  test.setTimeout(90_000);
  await withBoards(page, async ({ a, b, boardA, boardB }) => {
    // Both boards contain A: selecting its card must keep the board the user
    // chose, even when A remembers a prior editor view or another membership.
    const update = await seedLayout(page.request, boardB.id, { ...H, data: {
      data: { nodes: [
        { nodeId: b.id, x: 60, y: 60, width: 280 },
        { nodeId: a.id, x: 400, y: 60, width: 280 },
      ] },
    } });
    expect(update.ok()).toBeTruthy();

    // A board's note opens on its board, and a reload keeps it there.
    await ready(page, `/?view=notes&node=${boardA.id}`);
    await expect(card(page, a.id)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`node=${boardA.id}.*lens=canvas`));
    await page.reload();
    await expect(card(page, a.id)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`node=${boardA.id}.*lens=canvas`));

    // A plain note opens on its text: no board.
    await selectNodeByTitle(page, a.title);
    await expect(page.locator(".note-document .cm-content")).toContainText(`${a.title} body`);
    await expect(page.locator(".kw-canvas-wrap")).toHaveCount(0);

    // The other board, from its sidebar row: both of its cards.
    await selectNodeByTitle(page, boardB.title);
    await expect(card(page, b.id)).toBeVisible();
    await expect(card(page, a.id)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`node=${boardB.id}.*lens=canvas`));

    // A card selected on it keeps that board (not A's other board, not A's
    // remembered editor view).
    await card(page, a.id).click();
    await expect(page).toHaveURL(new RegExp(`node=${a.id}.*lens=canvas`));
    await expect(card(page, b.id)).toBeVisible();

    // Explicit navigation to A shows its text again.
    await selectNodeByTitle(page, a.title);
    await expect(page.locator(".note-document .cm-content")).toContainText(`${a.title} body`);
    await expect(page.locator(".kw-canvas-wrap")).toHaveCount(0);
  });
});

test("a board made offline opens on its whiteboard and reopens before the server has its note", async ({ page, context }) => {
  test.setTimeout(90_000);
  await withBoards(page, async ({ a, trackCanvas }) => {
    await ready(page, `/?view=notes&node=${a.id}&lens=editor`);
    await expect(page.locator(".note-document .cm-content")).toContainText(`${a.title} body`);
    await expectOnline(page);
    await expectOfflineReady(page); // the board's code is on hand offline, as on a used device
    try {
      await context.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event("offline")));
      await expectOffline(page);

      // The notes list's ＋ › Canvas › Create: queued like any note (createKinds).
      await page.locator(".obsidian-sidebar").getByRole("button", { name: "Create", exact: true }).click();
      const sheet = page.locator(".create-sheet-popover, .create-sheet-layer").filter({ visible: true });
      await sheet.getByRole("radio", { name: "Canvas" }).click();
      await sheet.getByRole("button", { name: "Create", exact: true }).click();
      await expect(page).toHaveURL(/lens=canvas/);
      const boardId = new URL(page.url()).searchParams.get("node")!;
      expect(boardId).toBeTruthy();
      trackCanvas(boardId);
      await expect(page.locator(".kw-canvas-wrap")).toBeVisible();
      await expectPending(page);

      // Name it on its 內容 tab (still offline), then back to its board.
      const offlineTitle = `Offline board ${Date.now()}`;
      await page.getByRole("tab", { name: "Content", exact: true }).click();
      await fillWhenReady(page.locator(".obsidian-title-input"), offlineTitle);
      await page.getByRole("tab", { name: "Canvas", exact: true }).click();
      await expect(page.locator(".kw-canvas-wrap")).toBeVisible();

      // Away and back while still offline (the sidebar search answers from
      // this device): it reopens on its board.
      await selectNodeByTitle(page, a.title);
      await expect(page.locator(".kw-canvas-wrap")).toHaveCount(0);
      await selectNodeByTitle(page, offlineTitle);
      await expect(page).toHaveURL(new RegExp(`node=${boardId}.*lens=canvas`));
      await expect(page.locator(".kw-canvas-wrap")).toBeVisible();
      await expect(page.locator(".note-document .cm-content")).toHaveCount(0);
    } finally {
      await context.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
    }
    await expectNoPending(page, { timeout: 15_000 });
    const boardId = new URL(page.url()).searchParams.get("node")!;
    await expect.poll(async () => {
      const res = await page.request.get(`/api/canvases/${boardId}`);
      return res.ok() ? (await res.json()).title : null;
    }).toMatch(/^Offline board /);
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`node=${boardId}.*lens=canvas`));
    await expect(page.locator(".kw-canvas-wrap")).toBeVisible();
  });
});

for (const outcome of ["delayed", "denied"] as const) {
  test(`switching boards with a ${outcome} read cannot display or edit the previous board`, async ({ page }) => {
    await withBoards(page, async ({ a, b, boardA, boardB }) => {
      await ready(page, `/?view=notes&node=${boardA.id}&lens=editor`);
      const previousCard = page.locator(`.react-flow__node[data-id="${a.id}"]`);
      await expect(previousCard).toBeVisible();
      const previousBox = await previousCard.boundingBox();
      expect(previousBox).not.toBeNull();
      const before = await (await page.request.get(`/api/canvases/${boardA.id}`)).json();

      const writes: string[] = [];
      const observeWrite = (request: Request) => {
        if (["PATCH", "DELETE"].includes(request.method())
          && [`/api/canvases/${boardA.id}`, `/api/boards/${boardA.id}`].includes(new URL(request.url()).pathname)) writes.push(request.method());
      };
      page.on("request", observeWrite);
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let requested = false;
      const url = `**/api/canvases/${boardB.id}`;
      await page.route(url, async route => {
        if (route.request().method() !== "GET") { await route.continue(); return; }
        requested = true;
        if (outcome === "denied") {
          await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) });
        } else {
          const response = await route.fetch();
          await held;
          await route.fulfill({ response });
        }
      });
      try {
        await selectNodeByTitle(page, boardB.title);
        await expect.poll(() => requested).toBe(true);
        await expect(page).toHaveURL(new RegExp(`node=${boardB.id}`));
        await expect(previousCard).toHaveCount(0);
        await expect(page.locator(`.react-flow__node[data-id="${b.id}"]`)).toHaveCount(0);

        // A gesture at the old card's position must not reach its former writer.
        const x = previousBox!.x + Math.min(30, previousBox!.width / 2);
        const y = previousBox!.y + Math.min(30, previousBox!.height / 2);
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 80, y + 40, { steps: 3 });
        await page.mouse.up();
        expect(writes).toEqual([]);
        const after = await (await page.request.get(`/api/canvases/${boardA.id}`)).json();
        expect(after.data).toEqual(before.data);

        if (outcome === "delayed") {
          release();
          await expect(page.locator(`.react-flow__node[data-id="${b.id}"]`)).toBeVisible();
          await expect(previousCard).toHaveCount(0);
        }
      } finally {
        release();
        await page.unroute(url);
        page.off("request", observeWrite);
      }
    });
  });
}
