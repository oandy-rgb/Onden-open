import { randomUUID } from "node:crypto";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { ready, createSpace, defaultSpaceId, BASE, H } from "./helpers";

const headers = H.headers;

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(path, { headers, data });
  expect(response.ok(), `${path}: ${response.status()}`).toBeTruthy();
  return response.json();
}

// Scoped collaborators are separate real sessions. Their scope is space
// membership: the reader is only in this test's space (not the default one),
// and revocation removes them from it. Owner setup/revocation only
// touches this test's UUID-prefixed fixtures in the isolated onden_test stack.
for (const width of [1280, 390, 320]) {
  test(`TASK-07: host scope survives save/reload, then offline revocation removes the task (${width}px)`, async ({ request, browser }) => {
    test.setTimeout(90_000);
    const stamp = randomUUID();
    const title = `驗收-task-${stamp}`;
    const spaceId = await createSpace(request, `驗收-scope-${stamp}`);
    const host = await post(request, "/api/nodes", { title: `驗收-host-${stamp}`, markdown: "Host scope fixture", space_id: spaceId });
    const task = await post(request, `/api/nodes/${host.id}/tasks`, { title });
    const context = await browser.newContext({ baseURL: BASE, viewport: { width, height: 800 }, storageState: { cookies: [], origins: [] } });
    try {
      const signup = await post(context.request, "/api/auth/sign-up/email", {
        name: `驗收 Reader ${stamp}`, email: `task-${stamp}@example.com`, password: `test-${stamp}`,
      });
      const reader = await post(request, "/api/actors", {
        name: `驗收 Reader ${stamp}`, type: "human", external_id: signup.user.id,
      });
      expect((await request.put(`/api/spaces/${spaceId}/members/${reader.id}`, { headers, data: { permission: "edit" } })).ok()).toBeTruthy();
      expect((await request.delete(`/api/spaces/${await defaultSpaceId(request)}/members/${reader.id}`, { headers })).ok()).toBeTruthy();
      // The raw bootstrap and browser projection must agree with the agenda.
      const bootstrap = await (await context.request.get("/api/bootstrap")).json();
      expect(bootstrap.tasks.map((row: { id: string }) => row.id)).toContain(task.id);
      expect(bootstrap.nodes.map((row: { id: string }) => row.id)).not.toContain(task.id);
      const page = await context.newPage();
      const automaticCreates: string[] = [];
      page.on("request", request => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/nodes") {
          automaticCreates.push(request.url());
        }
      });
      await page.addInitScript(() => localStorage.setItem("onden.welcomeDismissed", "1"));
      await ready(page, "/?view=tasks");
      await expect(page.locator(".membership-gate")).toHaveCount(0);
      // Tasks page since 2026-11-06: a task with no date is in the 隨時 tab (the page opens on
      // 今天, and a reload opens it there again); its box is the row's role=checkbox button.
      const anytime = page.locator("#tasks-tab-anytime");
      await anytime.click();
      const row = page.locator(".tk-row", { hasText: title });
      await expect(row).toBeVisible();
      // A real task PATCH must be allowed by the host's space, not the #task tag.
      // Completion removes the open row immediately; check() would try to
      // re-resolve that removed row. Assert the server's saved status below.
      if (width === 1280) {
        await row.getByRole("checkbox").focus();
        await page.keyboard.press("Space");
      } else {
        await row.getByRole("checkbox").click();
      }
      await expect.poll(async () => (await (await context.request.get(`/api/nodes/${task.id}`)).json()).attrs?._task_status).toBe("done");
      expect((await request.patch(`/api/tasks/${task.id}`, { headers, data: { status: "todo" } })).ok()).toBeTruthy();
      await page.reload({ waitUntil: "load" });
      await expect(page.locator(".tasks-mode")).toBeVisible();
      await expect(page.locator(".membership-gate")).toHaveCount(0);
      await anytime.click();
      await expect(anytime).toHaveAttribute("aria-selected", "true");
      await expect(row).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `/tmp/pw-output/shots/task-scope-saved-${width}.png` });

      await context.setOffline(true);
      expect((await request.delete(`/api/spaces/${spaceId}/members/${reader.id}`, { headers })).ok()).toBeTruthy();
      await context.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect(row).toHaveCount(0);
      await expect(page.locator(".membership-gate")).toHaveCount(0);
      // An unreadable node reads as missing (no 403 existence probe).
      expect((await context.request.get(`/api/nodes/${task.id}`)).status()).toBe(404);
      expect((await context.request.patch(`/api/tasks/${task.id}`, { headers, data: { status: "todo" } })).status()).toBe(403);
      const byId = await post(context.request, "/api/sync/nodes", { ids: [host.id, task.id] });
      expect(byId.tasks).toEqual([]);
      await page.reload({ waitUntil: "load" });
      // Negative assertions alone could pass on the boot spinner. Require
      // the loaded agenda and its confirmed empty count before checking absence: every tab's
      // count is 0 (今天, 接下來, 隨時, 某天).
      await expect(page.locator(".tasks-mode")).toBeVisible();
      await expect(page.locator(".tasks-tab-count")).toHaveText(["0", "0", "0", "0"]);
      await anytime.click();
      await expect(page.locator(".membership-gate")).toHaveCount(0);
      await expect(row).toHaveCount(0);
      expect(automaticCreates, "revocation must not seed example notes in a filtered empty workspace").toEqual([]);
      await expect(page.locator(".failed-write-recovery")).toHaveCount(0);
      await page.screenshot({ path: `/tmp/pw-output/shots/task-scope-${width}.png` });
    } finally {
      await context.close();
      // Keep append-only acceptance history; remove this test's live fixtures.
      await request.delete(`/api/nodes/${task.id}`, { headers });
      await request.delete(`/api/nodes/${host.id}`, { headers });
    }
  });
}
