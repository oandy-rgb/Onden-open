import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { H, ready } from "./helpers";
import { E2E_CLIENT_PROTOCOL } from "./hostContract";

// The first open of a new day on a device that already holds the workspace (owner report 2026-11-24, 01:50 in Taipei,
// phone PWA): today's note does not exist yet, the 「打開時」 setting is today's note, and new day notes go under a
// chosen note (dayNoteParent). Opening the app reaches the workspace within seconds; today's note is made afterwards,
// under the chosen note.
//
// That morning the page was also older than the server: the deploy before it changed the sync protocol, and the
// phone's app had not been opened since. The protocol gate (lib/protocolGate.ts) then keeps every sync request on the
// page, and the boot's membership check used to wait for an answer that never came (「正在確認工作區資料…」 until a reload
// brought the new build). The second test is that morning; a route adds the newer protocol to the server's answers.
//
// The owner's zones: the workspace and the device are in Taipei, the server runs in UTC, so 01:50 in Taipei is still
// the day before on the server.
test.use({ timezoneId: "Asia/Taipei" });

const HOUR_MS = 3_600_000;
/** Stays well under the boot watchdog's 12 s (components/BootWatchdog, PR #1980): the workspace, not an exit. */
const WORKSPACE_WITHIN_MS = 8_000;
const taipeiDay = (at: Date) => new Date(at.getTime() + 8 * HOUR_MS).toISOString().slice(0, 10);

type Node = { id: string; title: string; parent_id?: string | null };
async function nodes(page: Page): Promise<Node[]> {
  return ((await (await page.request.get("/api/bootstrap?bodies=none")).json()) as { nodes: Node[] }).nodes;
}
const parentOfDay = async (page: Page, day: string) => (await nodes(page)).find((n) => n.title === day)?.parent_id ?? null;

/** Day one, 20:00 in Taipei, in the future so that day's note is not in the shared test workspace yet; the device opens
 *  the app once (its copy and event cursor stay in the context) and today's note goes under a new 日記本. */
async function deviceUsedYesterday(context: BrowserContext): Promise<{ dayOne: Date; parent: Node }> {
  const page = await context.newPage();
  const dayOne = new Date(Date.UTC(2031, 0, 1 + (Date.now() % 300), 12, 0, 0));
  await page.clock.install({ time: dayOne });
  const parent = await (await page.request.post("/api/nodes", { ...H, data: { title: `日記本 ${Date.now()}`, markdown: "" } })).json() as Node;
  expect((await page.request.put("/api/me/prefs/dayNoteParent", { ...H, data: { value: parent.id } })).ok()).toBe(true);
  await ready(page, "/");
  await expect.poll(() => parentOfDay(page, taipeiDay(dayOne)), { timeout: 20_000 }).toBe(parent.id);
  await page.close();
  return { dayOne, parent };
}

/** Opens the app cold at `at`; resolves once the workspace is on screen and usable (no gate over it). */
async function openAt(context: BrowserContext, at: Date): Promise<{ page: Page; tookMs: number }> {
  const page = await context.newPage();
  await page.clock.install({ time: at });
  const started = Date.now();
  await page.goto("/", { waitUntil: "load" });
  await page.locator(".app-topbar nav, .mobile-bottom-nav").filter({ visible: true }).first().waitFor({ state: "visible", timeout: WORKSPACE_WITHIN_MS });
  await expect(page.locator(".membership-gate")).toHaveCount(0, { timeout: WORKSPACE_WITHIN_MS });
  return { page, tookMs: Date.now() - started };
}

/** The shared workspace's zone is Taipei for the test and goes back however it ends. */
async function inTaipei(context: BrowserContext, run: () => Promise<void>): Promise<void> {
  const before = ((await (await context.request.get("/api/bootstrap?bodies=none")).json()) as { workspace: { time_zone: string | null } }).workspace;
  expect((await context.request.patch("/api/workspace/time", { ...H, data: { time_zone: "Asia/Taipei" } })).ok()).toBe(true);
  try { await run(); } finally { await context.request.patch("/api/workspace/time", { ...H, data: { time_zone: before.time_zone } }); }
}

test("first open of a new day reaches the workspace, then makes today's note under the chosen note", async ({ context }) => {
  await inTaipei(context, async () => {
    const { dayOne, parent } = await deviceUsedYesterday(context);
    const dayTwo = new Date(dayOne.getTime() + 5 * HOUR_MS + 50 * 60_000); // 01:50 the next day in Taipei, the same day in UTC
    const { page, tookMs } = await openAt(context, dayTwo);
    expect(tookMs).toBeLessThan(WORKSPACE_WITHIN_MS);
    await expect.poll(() => parentOfDay(page, taipeiDay(dayTwo)), { timeout: 20_000 }).toBe(parent.id);
  });
});

test("first open of a new day on a page older than the server reaches the workspace, and today's note follows the update", async ({ context }) => {
  await inTaipei(context, async () => {
    const { dayOne, parent } = await deviceUsedYesterday(context);
    const dayTwo = new Date(dayOne.getTime() + 5 * HOUR_MS + 50 * 60_000);
    // The server was updated meanwhile: every answer says it speaks the next protocol. (The live stream is left alone:
    // it never ends, so it cannot be answered from a fetched copy.)
    await context.route("**/api/**", async (route) => {
      if (route.request().url().includes("/api/events/stream")) return route.continue();
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), "x-onden-server-protocol": String(E2E_CLIENT_PROTOCOL + 1) } });
    });
    const asked: string[] = [];
    context.on("request", (request) => { if (request.url().includes("/api/")) asked.push(new URL(request.url()).pathname); });

    const { page, tookMs } = await openAt(context, dayTwo);
    expect(tookMs).toBeLessThan(WORKSPACE_WITHIN_MS);
    // The copy is on screen with yesterday's note, and the page offers its update (components/DeviceNotices).
    await expect(page.getByText(taipeiDay(dayOne), { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /^(New version available — reload|有新版，重新載入)$/ })).toBeVisible();
    // Nothing the page is held from goes out, and it does not keep trying: no reconnect every few seconds.
    const settled = asked.length;
    const retried = () => asked.slice(settled).filter((path) => path === "/api/spaces" || path.startsWith("/api/sync"));
    // Long enough for two reconnect attempts (lib/data/connectivity RECONNECT_RETRY_MS, 5 s); waiting for what must not happen.
    await expect.poll(() => retried().length, { timeout: 12_000 }).toBeGreaterThan(0).catch(() => {});
    expect(retried()).toEqual([]);
    await expect(page.locator(".membership-gate")).toHaveCount(0);
    await page.close();

    // The reload brings the new build (here: the server's answers stop saying a newer protocol); today's note is there,
    // under the chosen note.
    await context.unrouteAll({ behavior: "ignoreErrors" });
    const updated = await openAt(context, new Date(dayTwo.getTime() + 60_000));
    await expect.poll(() => parentOfDay(updated.page, taipeiDay(dayTwo)), { timeout: 20_000 }).toBe(parent.id);
  });
});
