// Feature-audit deepening (2026-10-09, tick 28): SYS-01 — success and its
// business event commit together; a refused write leaves neither. For each
// write route outside the node core: one valid call (expect 2xx, ≥1 event by
// the owner, state changed) and one invalid call (expect 4xx, 0 events, state
// unchanged). Events and state are read straight from Postgres.
import { test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { seedLayout, H, psql as db } from "../fullstack/helpers";


test("SYS-01: success ⇔ event, refusal ⇔ nothing", async ({ page }) => {
  test.setTimeout(300_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  const owner = db("select actor_id from domain_events where event_type='NODE_CREATED' order by id desc limit 1");
  const maxId = () => Number(db("select coalesce(max(id),0) from domain_events"));
  const eventsSince = (id: number) => db(`select event_type||':'||actor_id from domain_events where id>${id} order by id`).split("\n").filter(Boolean);
  const mk = async (title: string) => (await (await req.post("/api/nodes", { ...H, data: { title, markdown: "x" } })).json()) as { id: string };
  const n1 = await mk(`S01 a ${s}`); const n2 = await mk(`S01 b ${s}`);
  const created: { nodes: string[]; canvases: string[] } = { nodes: [n1.id, n2.id], canvases: [] };
  const rows: Record<string, unknown> = {};
  const op = async (name: string, call: () => Promise<import("@playwright/test").APIResponse>, state: () => string, expectOk: boolean) => {
    const before = maxId(); const st0 = state();
    const r = await call(); const body = (await r.text()).slice(0, 80);
    await page.waitForTimeout(400);
    const ev = eventsSince(before); const st1 = state();
    const byOwner = ev.filter((e) => e.endsWith(owner)).length;
    const verdict = expectOk
      ? (r.status() < 300 && ev.length > 0 && byOwner === ev.length && st0 !== st1 ? "ok" : "CHECK")
      : (r.status() >= 400 && ev.length === 0 && st0 === st1 ? "ok" : "CHECK");
    rows[name] = { verdict, status: r.status(), events: ev.map((e) => e.split(":")[0]), stateChanged: st0 !== st1, body: verdict === "CHECK" ? body : undefined };
    return r;
  };
  try {
    const edgeCount = () => db(`select count(*) from node_edges where source_node_id='${n1.id}'`);
    await op("edge create", () => req.post("/api/edges", { ...H, data: { source_node_id: n1.id, target_node_id: n2.id, edge_type: "related_to" } }), edgeCount, true);
    await op("edge create bad type", () => req.post("/api/edges", { ...H, data: { source_node_id: n1.id, target_node_id: n2.id, edge_type: "Bad Type" } }), edgeCount, false);
    await op("edge create missing target", () => req.post("/api/edges", { ...H, data: { source_node_id: n1.id, target_node_id: randomUUID(), edge_type: "related_to" } }), edgeCount, false);
    const eid = db(`select id from node_edges where source_node_id='${n1.id}' limit 1`);
    if (eid) await op("edge delete", () => req.delete(`/api/edges/${eid}`, H), edgeCount, true);

    const ptrCount = () => db(`select count(*) from note_pointers where target_id='${n2.id}'`);
    await op("pointer create", () => req.post("/api/pointers", { ...H, data: { target_id: n2.id } }), ptrCount, true);
    await op("pointer create missing", () => req.post("/api/pointers", { ...H, data: { target_id: randomUUID() } }), ptrCount, false);

    const taskCount = () => db(`select count(*) from content_nodes where parent_id='${n1.id}' and deleted_at is null`);
    const tr = await op("task create", () => req.post(`/api/nodes/${n1.id}/tasks`, { ...H, data: { title: `S01 task ${s}` } }), taskCount, true);
    const tj = await tr.json().catch(() => ({})); const taskId = tj.id ?? tj.task?.id ?? tj.node?.id;
    if (taskId) created.nodes.push(taskId);
    await op("task create bad recur", () => req.post(`/api/nodes/${n1.id}/tasks`, { ...H, data: { title: "x", recur: "0d" } }), taskCount, false);
    const taskRow = () => db(`select coalesce(md5(string_agg(key||'='||value, ',' order by key)),'') from node_attributes where node_id='${taskId}'`);
    if (taskId) {
      await op("task patch", () => req.patch(`/api/tasks/${taskId}`, { ...H, data: { status: "done" } }), taskRow, true);
      await op("task patch bad status", () => req.patch(`/api/tasks/${taskId}`, { ...H, data: { status: "exploded" } }), taskRow, false);
    }

    const cvCount = () => db(`select count(*) from content_nodes where node_type='canvas' and title like 'S01 cv ${s}%' and deleted_at is null`);
    const cr = await op("canvas create", () => req.post("/api/canvases", { ...H, data: { title: `S01 cv ${s}` } }), cvCount, true);
    const cv = await cr.json().catch(() => ({})); if (cv.id) created.canvases.push(cv.id);
    const cvData = () => db(`select coalesce(md5(string_agg(node_id::text||x::text||y::text, ',')),'') from node_positions where surface like '%${cv.id}%'`) + "|" + db(`select md5(coalesce(markdown,'')) from content_nodes where id='${cv.id}'`);
    await op("canvas patch", () => seedLayout(req, cv.id, { ...H, data: { data: { nodes: [{ nodeId: n1.id, x: 1, y: 1 }] } } }), cvData, true);
    await op("canvas patch bad", () => seedLayout(req, cv.id, { ...H, data: { data: { nodes: [{ nodeId: "nope", x: "a" }] } } }), cvData, false);

    const cfg = () => db("select md5(coalesce(config::text,'')) from workspaces limit 1") || db("select count(*) from domain_events where event_type='SITE_CONFIG_UPDATED'");
    const orig = (await (await req.get("/api/workspace/config")).json()).config?.tagline ?? null;
    await op("site config patch", () => req.patch("/api/workspace/config", { ...H, data: { config: { tagline: `S01 ${s}` } } }), () => String((db(`select count(*) from node_attributes where value='S01 ${s}'`))), true);
    await op("site config bad", () => req.patch("/api/workspace/config", { ...H, data: { config: "nope" } }), () => String((db(`select count(*) from node_attributes where value='S01 ${s}'`))), false);
    await req.patch("/api/workspace/config", { ...H, data: { config: { tagline: orig } } });
    void cfg;

    const impCount = () => db(`select count(*) from content_nodes where title like 'S01imp${s}%'`);
    await op("import markdown", () => req.post("/api/import/obsidian", { ...H, data: { files: [{ path: `S01imp${s}.md`, content: `# S01imp${s}\n\nbody` }] } }), impCount, true);
    await op("import bad payload", () => req.post("/api/import/obsidian", { ...H, data: { files: "nope" } }), impCount, false);

    await op("bookmark bad url", () => req.post("/api/bookmark", { ...H, data: { url: "not a url" } }), () => db(`select count(*) from content_nodes where created_at > now() - interval '5 seconds'`), false);
    out.rows = rows;
    out.summary = Object.entries(rows).filter(([, v]) => (v as { verdict: string }).verdict !== "ok").map(([k]) => k);
  } finally {
    for (const id of db(`select id from content_nodes where title like 'S01imp${s}%' or title like 'S01 task ${s}%'`).split("\n").filter(Boolean)) created.nodes.push(id);
    for (const id of created.canvases) await req.delete(`/api/canvases/${id}`, H).catch(() => {});
    for (const id of created.nodes) await req.delete(`/api/nodes/${id}`, H).catch(() => {});
    console.log("SYS01 " + JSON.stringify(out, null, 2));
  }
});
