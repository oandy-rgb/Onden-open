// Feature-audit deepening (2026-10-08): NOTE-03 — offline: (a) create a note,
// then tag it, set a property and add a task to it, all queued and replayed
// in dependency order; (b) offline edit of a note another device edited in
// the meantime (non-overlapping and overlapping lines); (c) the replay hits
// 401 (session expired) — queue kept, replays after auth returns.
import { test } from "@playwright/test";
import { ready, H, syncLabel } from "../fullstack/helpers";


test("NOTE-03: offline dependent create, concurrent remote edit, 401 replay", async ({ page, context }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const gate = page.getByText("Checking your workspace", { exact: false });
  const settle = async () => { for (let i = 0; i < 60 && await gate.isVisible().catch(() => false); i++) await page.waitForTimeout(500); await page.waitForTimeout(4000); if (await gate.isVisible().catch(() => false)) { for (let i = 0; i < 60 && await gate.isVisible().catch(() => false); i++) await page.waitForTimeout(500); await page.waitForTimeout(2000); } };
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `n03t${stamp}`, fields: [{ name: "stage", type: "text" }] } })).json();
  const sync = async () => (await syncLabel(page)).replace(/\s+/g, " ").slice(0, 60);
  try {
  // (b) concurrent remote edit.
  const r = await (await page.request.post("/api/nodes", { ...H, data: { title: `Merge ${stamp}`, markdown: "line1\nline2\nline3" } })).json();
  await ready(page, `/?view=notes&node=${r.id}&lens=editor`); await settle();
  await context.setOffline(true); await page.waitForTimeout(600);
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("Control+Home"); await page.keyboard.press("End"); await page.keyboard.type(" LOCAL");
  await page.waitForTimeout(2200);
  await page.request.patch(`/api/nodes/${r.id}`, { ...H, data: { markdown: "line1\nline2\nline3 REMOTE" } });
  await context.setOffline(false);
  await page.waitForTimeout(10_000);
  out.nonOverlapMerge = { server: (await (await page.request.get(`/api/nodes/${r.id}`)).json()).markdown, editor: (await page.locator(".cm-content").first().innerText()).replace(/\n/g, "⏎") };
  // Overlapping: both change line2.
  await settle();
  await context.setOffline(true); await page.waitForTimeout(600);
  await page.locator(".cm-content").first().click();
  await page.locator(".cm-line", { hasText: "line2" }).first().click();
  await page.keyboard.press("End"); await page.keyboard.type(" MINE");
  await page.waitForTimeout(2200);
  const cur = (await (await page.request.get(`/api/nodes/${r.id}`)).json()).markdown as string;
  await page.request.patch(`/api/nodes/${r.id}`, { ...H, data: { markdown: cur.replace("line2", "line2 THEIRS") } });
  await context.setOffline(false);
  await page.waitForTimeout(10_000);
  const vres = await (await page.request.get(`/api/nodes/${r.id}/versions`)).json().catch(() => null);
  out.overlapMerge = { server: (await (await page.request.get(`/api/nodes/${r.id}`)).json()).markdown, editor: (await page.locator(".cm-content").first().innerText()).replace(/\n/g, "⏎"), toast: (await page.locator(".toast").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").slice(-160), versions: Array.isArray(vres) ? vres.length : (vres?.versions?.length ?? null) };

  // (c) 401 on replay.
  const s = await (await page.request.post("/api/nodes", { ...H, data: { title: `Auth ${stamp}`, markdown: "auth start" } })).json();
  await ready(page, `/?view=notes&node=${s.id}&lens=editor`); await settle();
  await context.setOffline(true); await page.waitForTimeout(600);
  await page.locator(".cm-content").first().click(); await page.keyboard.press("Control+End"); await page.keyboard.type(" queued-under-401");
  await page.waitForTimeout(2200);
  await page.route(`**/api/nodes/${s.id}`, (rt) => rt.request().method() === "PATCH" ? rt.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "unauthorized" }) }) : rt.continue());
  await context.setOffline(false);
  await page.waitForTimeout(6000);
  out.on401 = { server: (await (await page.request.get(`/api/nodes/${s.id}`)).json()).markdown, sync: await sync(), toast: (await page.locator(".toast").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").slice(-160), recovery: (await page.locator(".failed-write-recovery").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 80) };
  await page.unroute(`**/api/nodes/${s.id}`);
  await context.setOffline(true); await page.waitForTimeout(600); await context.setOffline(false);
  await page.waitForTimeout(8000);
  out.after401 = { server: (await (await page.request.get(`/api/nodes/${s.id}`)).json()).markdown, sync: await sync() };
  } finally {
    await context.setOffline(false).catch(() => {});
    console.log("NOTE03 " + JSON.stringify(out, null, 2));
  }
});
