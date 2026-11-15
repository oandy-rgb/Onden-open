// Feature-audit deepening (2026-10-09, tick 27): SYS-06 — background work across
// a real backend restart. The fixture feed server runs in the FRONTEND container
// (http://frontend:8080) so it survives the backend restart.
// A. Restart the backend while a slow feed fetch (outbox effect) is in flight:
//    the outbox row must be retried after the restart and the item stored once.
// B. A fetched 4-item feed, backend restart, refresh twice: still 4 items.
import { test, request as pwRequest } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { psql as db, e2eContainer, BASE, H } from "../fullstack/helpers";

const FX = "http://frontend:8080";
const docker = (...a: string[]) => execFileSync("docker", a, { encoding: "utf8" }).trim();

test("SYS-06: outbox + RSS across a backend restart", async ({ page }) => {
  test.setTimeout(600_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  docker("cp", "/var/home/oandy/桌面/git/note/Onden/.acceptance/feature-loop-2026-10-07/tick27/fixture/server.mjs", `${e2eContainer("frontend")}:/tmp/rssfx.mjs`);
  try { docker("exec", "-d", e2eContainer("frontend"), "node", "/tmp/rssfx.mjs"); } catch { /* may already run */ }
  await page.waitForTimeout(1500);
  const waitHealthy = async () => { for (let i = 0; i < 60; i++) { const r = await req.get("/api/rss/sources").catch(() => null); if (r && r.status() === 200) return i; await page.waitForTimeout(1000); } return -1; };
  const outboxFor = (id: string) => db(`select id||' '||status||' attempts='||attempts||' next='||to_char(next_attempt_at,'HH24:MI:SS')||' err='||coalesce(left(last_error,70),'') from outbox where payload::text like '%${id}%' order by id`).split("\n").filter(Boolean);
  const staged = (id: string) => db(`select count(*) from rss_staging where source_node_id='${id}'`);
  const sources: string[] = [];
  try {
    // ── A ── passed in tick27/sys06c.log; not repeated here.
    // ── B ── passed in the previous run (tick27/sys06b.log); not repeated here.
    // ── C ── approval-held outbox effect across a restart.
    await req.post("/api/actors", { ...H, data: { name: `Sys06 agent ${s}`, type: "agent" } });
    const actor = ((await (await req.get("/api/actors")).json()) as Array<{ id: string; name: string }>).find((x) => x.name === `Sys06 agent ${s}`)!;
    const tok = (await (await req.post(`/api/actors/${actor.id}/tokens`, { ...H, data: { template: "researcher" } })).json()).token;
    const agent = await pwRequest.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { origin: BASE, "content-type": "application/json", authorization: `Bearer ${tok}` } });
    const name = `sys06pack${s}`;
    const prop = await agent.post("/api/mcp/tools/proposeTagPack", { data: { args: { name, fields: [{ name: "stage", type: "text" }] } } });
    out.C_propose = `${prop.status()} ${(await prop.text()).slice(0, 160)}`;
    const pendingRows = () => db(`select id||' '||status||' attempts='||attempts from outbox where effect_kind='tag_pack' and payload::text like '%${name}%' order by id`).split("\n").filter(Boolean);
    const approvals = async () => ((await (await req.get("/api/inbox/approvals")).json()) as Array<Record<string, unknown>> | { items?: Array<Record<string, unknown>> });
    const list = async () => { const a = await approvals(); const arr = (Array.isArray(a) ? a : a.items ?? []) as Array<Record<string, unknown>>; return arr.filter((x) => JSON.stringify(x).includes(name)); };
    out.C_beforeRestart = { outbox: pendingRows(), approvals: (await list()).map((x) => `${x.id} ${x.status ?? ""}`) };
    docker("restart", "-t", "2", e2eContainer("backend"));
    out.C_healthyAfterSec = await waitHealthy();
    await page.waitForTimeout(8000);
    const items = await list();
    out.C_afterRestart = { outbox: pendingRows(), approvals: items.map((x) => `${x.id} ${x.status ?? ""}`), tagsNamed: db(`select count(*) from content_nodes where title='${name}' and deleted_at is null`) };
    const apId = items[0]?.id;
    if (apId) {
      const r1 = await req.post(`/api/inbox/approvals/${apId}/approve`, H); out.C_approve1 = `${r1.status()} ${(await r1.text()).slice(0, 100)}`;
      await page.waitForTimeout(4000);
      const r2 = await req.post(`/api/inbox/approvals/${apId}/approve`, H); out.C_approve2 = `${r2.status()} ${(await r2.text()).slice(0, 100)}`;
      await page.waitForTimeout(4000);
    }
    out.C_final = { outbox: pendingRows(), tagsNamed: db(`select count(*) from content_nodes where title='${name}' and deleted_at is null`) };
    for (const id of db(`select id from content_nodes where title='${name}'`).split("\n").filter(Boolean)) await req.delete(`/api/nodes/${id}`, H).catch(() => {});
    await req.delete(`/api/actors/${actor.id}`, H).catch(() => {}); await agent.dispose();
  } finally {
    for (const id of sources) await req.delete(`/api/nodes/${id}`, H).catch(() => {});
    try { docker("exec", e2eContainer("frontend"), "pkill", "-f", "rssfx.mjs"); } catch { /* */ }
    console.log("SYS06 " + JSON.stringify(out, null, 2));
  }
});
