// Feature-audit loop probes (2026-10-07): SYS-04 — the server commits but the
// response never reaches the client. Retries/reloads must not duplicate the
// create or the edit event.
import { test, expect, type Page } from "@playwright/test";
import { ready, openQuickCapture, H } from "./helpers";

const titles = async (page: Page, needle: string) =>
  ((await (await page.request.get("/api/bootstrap?bodies=none", H)).json()).nodes as Array<{ title: string }>).filter((n) => n.title.includes(needle)).length;

test("SYS-04: lost response on quick-capture create does not duplicate", async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const text = `LostCreate ${stamp}`;
  await ready(page, "/?view=notes");
  let dropped = 0; const keys: string[] = [];
  await page.route("**/api/nodes", async (route) => {
    const req = route.request();
    if (req.method() !== "POST" || !(req.postData() ?? "").includes(text)) return route.continue();
    keys.push(req.headers()["idempotency-key"] ?? req.headers()["x-idempotency-key"] ?? "none");
    if (dropped++ === 0) { await route.fetch(); return route.abort("failed"); } // committed, response lost
    return route.continue();
  });
  await openQuickCapture(page);
  await page.locator(".quick-capture-textarea").fill(text);
  await page.locator(".quick-capture-save").click();
  await page.waitForTimeout(3000);
  const ui = await page.locator(".quick-capture-overlay").count();
  const toast = await page.locator(".toast, [role='alert'], [role='status']").allInnerTexts();
  console.log(`AUDIT SYS-04 create: attempts=${dropped} keys=${JSON.stringify(keys)} overlayOpen=${ui} notices=${JSON.stringify(toast.slice(0, 3))}`);
  // Let any queued retry run, then reload (cold path) and sync again.
  await page.waitForTimeout(8000);
  await page.unroute("**/api/nodes");
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(8000);
  const count = await titles(page, text);
  console.log(`AUDIT SYS-04 create: server copies after retry+reload=${count}`);
  expect(count).toBe(1);
});

test("SYS-04: lost response on an editor save does not double the edit", async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const n = await (await page.request.post("/api/nodes", { ...H, data: { title: `LostEdit ${stamp}`, markdown: "base" } })).json();
  await ready(page, `/?view=notes&node=${n.id}`);
  let dropped = 0; const keys: string[] = [];
  await page.route(`**/api/nodes/${n.id}`, async (route) => {
    const req = route.request();
    if (req.method() !== "PATCH") return route.continue();
    keys.push(req.headers()["idempotency-key"] ?? req.headers()["x-idempotency-key"] ?? "none");
    if (dropped++ === 0) { await route.fetch(); return route.abort("failed"); }
    return route.continue();
  });
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" appended-once");
  await page.keyboard.press("Control+s");
  await page.waitForTimeout(10_000);
  await page.unroute(`**/api/nodes/${n.id}`);
  await page.reload({ waitUntil: "load" });
  await page.locator(".cm-content").waitFor();
  await page.waitForTimeout(6000);
  const server = (await (await page.request.get(`/api/nodes/${n.id}`, H)).json()).markdown as string;
  const versions = await (await page.request.get(`/api/nodes/${n.id}/versions`, H)).json();
  const editor = await page.locator(".cm-content").innerText();
  const recovery = await page.locator(".failed-write-recovery").count();
  console.log(`AUDIT SYS-04 edit: attempts=${dropped} keys=${JSON.stringify(keys)} server=${JSON.stringify(server)} versions=${versions.length} editor=${JSON.stringify(editor)} recoveryPanel=${recovery}`);
  expect(server.split("appended-once").length - 1).toBe(1);
});
