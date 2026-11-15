// Feature-audit deepening (2026-10-09, tick 24): SYS-02 — database outage.
// Stop the private stack's Postgres for ~20 s while the editor has new input
// and requests are in flight: REST / agent error classes and bodies (no leaked
// internals), the editor's save state (retryable, not "rejected"), recovery of
// the backend's pool after Postgres returns, queue drain without duplicates.
import { test, request as pwRequest } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { psql as db, ready, e2eContainer, BASE, H, pendingCount } from "../fullstack/helpers";

const PG = () => e2eContainer("postgres");
const docker = (...a: string[]) => execFileSync("docker", a, { encoding: "utf8" }).trim();

test("SYS-02: Postgres outage", async ({ page }) => {
  test.setTimeout(400_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  await req.post("/api/actors", { ...H, data: { name: `Sys02b agent ${s}`, type: "agent" } });
  const actor = ((await (await req.get("/api/actors")).json()) as Array<{ id: string; name: string }>).find((a) => a.name === `Sys02b agent ${s}`)!;
  const tok = (await (await req.post(`/api/actors/${actor.id}/tokens`, { ...H, data: { template: "researcher" } })).json()).token;
  const agent = await pwRequest.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { origin: BASE, "content-type": "application/json", authorization: `Bearer ${tok}` } });
  const note = await (await req.post("/api/nodes", { ...H, data: { title: `Sys02b ${s}`, markdown: "start" } })).json();
  const brief = async (r: Promise<import("@playwright/test").APIResponse>) => { try { const x = await r; return `${x.status()} ${(await x.text()).slice(0, 140)}`; } catch (e) { return `throw ${String(e).slice(0, 80)}`; } };
  let stopped = false;
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await ready(page, `/?view=notes&node=${note.id}`);
    await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
    await page.waitForTimeout(2500);

    docker("stop", "-t", "2", PG()); stopped = true;
    const t0 = Date.now();
    await page.locator(".cm-content").click({ force: true });
    await page.keyboard.press("Control+End"); await page.keyboard.type(` during-outage-${s}`);
    await page.waitForTimeout(6000);
    out.during = {
      restGet: await brief(req.get(`/api/nodes/${note.id}`, { timeout: 20_000 })),
      restPatch: await brief(req.patch(`/api/nodes/${note.id}`, { ...H, data: { title: `Sys02b ${s} x` }, timeout: 20_000 })),
      restCreate: await brief(req.post("/api/nodes", { ...H, data: { title: `Sys02b outage-create ${s}` }, timeout: 20_000 })),
      agentGet: await brief(agent.post("/api/mcp/tools/getNode", { data: { args: { id: note.id } }, timeout: 20_000 })),
      session: await brief(req.get("/api/auth/get-session", { timeout: 20_000 })),
      health: await brief(req.get("/api/health", { timeout: 20_000 })),
      uiStatus: (await page.locator(".save-status, .note-save-status, [class*=save-state]").filter({ visible: true }).allInnerTexts().catch(() => [])).slice(0, 3),
      pending: String(await pendingCount(page)),
      toasts: await page.locator(".toast-message").allInnerTexts(),
      recovery: (await page.locator(".failed-write-recovery").filter({ visible: true }).allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, " ").slice(0, 160)),
      elapsedMs: Date.now() - t0,
    };
    await page.screenshot({ path: test.info().outputPath("outage.png") });
    docker("start", PG()); stopped = false;
    for (let i = 0; i < 30; i++) { try { db("select 1"); break; } catch { await page.waitForTimeout(1000); } }
    out.backendStateAfterPg = docker("inspect", e2eContainer("backend"), "--format", "{{.State.Status}} exit={{.State.ExitCode}}");
    // GAP-253: the backend dies with Postgres. Production's `restart: unless-stopped` would restart it; do that by hand.
    if (out.backendStateAfterPg !== "running exit=0") { docker("start", e2eContainer("backend")); out.backendRestartedManually = true; }
    const firstOk: string[] = [];
    for (let i = 0; i < 20; i++) { const r = await brief(req.get(`/api/nodes/${note.id}`)); firstOk.push(r.slice(0, 3)); if (r.startsWith("200")) break; await page.waitForTimeout(1500); }
    out.recoveryGets = firstOk;
    await page.getByRole("button", { name: /Sync now/i }).filter({ visible: true }).first().click().catch(() => {});
    await page.waitForTimeout(10_000);
    out.after = {
      pending: String(await pendingCount(page)),
      recovery: (await page.locator(".failed-write-recovery").filter({ visible: true }).allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, " ").slice(0, 160)),
      bodyLanded: db(`select position('during-outage-${s}' in markdown) > 0 from content_nodes where id='${note.id}'`),
      outageCreates: db(`select count(*) from content_nodes where title = 'Sys02b outage-create ${s}'`),
      agentGet: await brief(agent.post("/api/mcp/tools/getNode", { data: { args: { id: note.id } } })),
    };
    await page.reload(); await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(5000);
    out.afterReload = { pending: String(await pendingCount(page)), editorHas: (await page.locator(".cm-content").innerText().catch(() => "")).includes(`during-outage-${s}`) };
    out.backendLog = docker("logs", "--since", "3m", e2eContainer("backend")).split("\n").filter((l) => /error|ECONN|terminat|reconnect/i.test(l)).slice(-6).map((l) => l.slice(0, 160));
  } finally {
    if (stopped) docker("start", PG());
    await page.waitForTimeout(3000);
    await req.delete(`/api/nodes/${note.id}`, H).catch(() => {});
    for (const id of db(`select id from content_nodes where title like 'Sys02b outage-create ${s}%'`).split("\n").filter(Boolean)) await req.delete(`/api/nodes/${id}`, H).catch(() => {});
    await req.delete(`/api/actors/${actor.id}`, H).catch(() => {});
    await agent.dispose();
    console.log("SYS02B " + JSON.stringify(out, null, 2));
  }
});
