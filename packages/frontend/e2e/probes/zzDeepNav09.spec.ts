// Feature-audit deepening (2026-10-08): NAV-09 — (a) the same failure three
// times in a row: how many toasts, can they be dismissed; (b) a render crash
// (malformed agenda payload) right after typing: the error boundary, the
// draft, and Reload recovering the app.
import { test } from "@playwright/test";
import { ready, BASE, H } from "../fullstack/helpers";


test("NAV-09: toast dedupe, error boundary recovery", async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const host = (await (await page.request.post("/api/nodes", { ...H, data: { title: `ErrHost ${stamp}`, markdown: "x" } })).json()).id as string;
  for (let i = 0; i < 3; i++) await page.request.post(`/api/nodes/${host}/tasks`, { ...H, data: { title: `ErrT${i} ${stamp}` } });
  await ready(page, "/?view=tasks");
  await page.route("**/api/tasks/*", (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  for (let i = 0; i < 3; i++) { await page.getByRole("checkbox", { name: `Mark ErrT${i} ${stamp} done` }).click(); await page.waitForTimeout(400); }
  await page.waitForTimeout(800);
  const toasts = await page.locator(".toast").allInnerTexts();
  out.sameError3x = { toasts: toasts.length, texts: [...new Set(toasts.map((t) => t.replace(/\s+/g, " ").trim()))] };
  const close = page.locator(".toast button").first();
  out.overlap = await page.evaluate(() => {
    const t = document.querySelector(".toast-dismiss")?.getBoundingClientRect(); const f = document.querySelector(".failed-write-recovery")?.getBoundingClientRect();
    const hit = t ? document.elementFromPoint(t.x + t.width / 2, t.y + t.height / 2) : null;
    return { toastBtn: t ? [Math.round(t.x), Math.round(t.y)] : null, recovery: f ? [Math.round(f.x), Math.round(f.y), Math.round(f.width), Math.round(f.height)] : null, hitIsDismiss: hit?.classList.contains("toast-dismiss") ?? null };
  });
  await page.screenshot({ path: test.info().outputPath("toast-overlap.png") });
  await close.click({ timeout: 3000 }).catch(() => { out.dismissBlocked = true; });
  out.afterDismissTry = await page.locator(".toast").count();
  await page.waitForTimeout(8000);
  out.toastsAfter8s = await page.locator(".toast").count();
  await page.unroute("**/api/tasks/*");

  // Render crash.
  const note = (await (await page.request.post("/api/nodes", { ...H, data: { title: `Crash ${stamp}`, markdown: "start" } })).json()).id as string;
  await ready(page, `/?view=notes&node=${note}&lens=editor`);
  await page.route("**/api/tasks/agenda", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ buckets: { today: [{ id: "x", title: { bad: 1 }, due_date: 42, status: null }] }, count: "NaN", done: "nope" }) }));
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(e.message.slice(0, 80)));
  const min = page.getByRole("button", { name: "Minimize recovery panel" });
  if (await min.isVisible().catch(() => false)) await min.click();
  await page.locator(".cm-content").first().click(); await page.keyboard.press("Control+End"); await page.keyboard.type(" before-crash");
  await page.locator(".app-primary-nav").getByRole("button", { name: "Tasks", exact: true }).click();
  await page.waitForTimeout(2500);
  const boundary = page.getByText("Something went wrong");
  out.crash = { boundary: await boundary.isVisible().catch(() => false), pageErrors: errs.slice(0, 3), bodyText: (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 200), serverDraft: ((await (await page.request.get(`/api/nodes/${note}`)).json()).markdown as string).includes("before-crash") };
  await page.unroute("**/api/tasks/agenda");
  if (await boundary.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Reload" }).click();
    await page.waitForTimeout(4000);
    out.afterReload = { boundary: await boundary.isVisible().catch(() => false), url: page.url().replace(BASE, "").slice(0, 50), tasksVisible: await page.locator(".tasks-mode").isVisible().catch(() => false) };
  }
  console.log("NAV09 " + JSON.stringify(out, null, 2));
});
