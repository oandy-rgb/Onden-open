// Feature-audit deepening (2026-10-09, tick 23): SYS-02 — the same failure
// through REST and through the agent API (/api/mcp/tools/*) should get the same
// class (400 / 403 / 404 / 409 / 422) with a readable code, never a 500 or a
// misleading 200. Matrix over nodes, tags and attributes.
import { test, request as pwRequest } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { BASE, H } from "../fullstack/helpers";


test("SYS-02: REST vs agent error classes", async ({ page }) => {
  test.setTimeout(240_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  await req.post("/api/actors", { ...H, data: { name: `Sys02 agent ${s}`, type: "agent" } });
  const actor = ((await (await req.get("/api/actors")).json()) as Array<{ id: string; name: string }>).find((a) => a.name === `Sys02 agent ${s}`)!;
  const mint = async (template: string) => (await (await req.post(`/api/actors/${actor.id}/tokens`, { ...H, data: { template } })).json()).token as string;
  const agentFor = async (template: string) => pwRequest.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { origin: BASE, "content-type": "application/json", authorization: `Bearer ${await mint(template)}` } });
  const researcher = await agentFor("researcher");
  const readOnly = await agentFor("read-only");
  const show = async (r: import("@playwright/test").APIResponse) => { const t = await r.text(); let code: unknown = t.slice(0, 60); try { const j = JSON.parse(t); code = j.error ?? (j.ok ? "ok" : j); } catch { /* text */ } return `${r.status()} ${typeof code === "string" ? code : JSON.stringify(code).slice(0, 60)}`; };
  const tool = (ctx: typeof researcher, name: string, args: unknown) => ctx.post(`/api/mcp/tools/${name}`, { data: { args } });

  const note = await (await req.post("/api/nodes", { ...H, data: { title: `Sys02 n ${s}`, markdown: "x" } })).json();
  const tagA = (await (await req.post("/api/tags/resolve-path", { ...H, data: { path: `sys02a${s}` } })).json()).leaf_id as string;
  const tagB = (await (await req.post("/api/tags/resolve-path", { ...H, data: { path: `sys02b${s}` } })).json()).leaf_id as string;
  const ghost = randomUUID();
  const m: Record<string, { rest: string; agent: string }> = {};
  const row = async (name: string, rest: Promise<import("@playwright/test").APIResponse>, agent: Promise<import("@playwright/test").APIResponse>) => { m[name] = { rest: await show(await rest), agent: await show(await agent) }; };
  try {
    await row("get missing node", req.get(`/api/nodes/${ghost}`), tool(researcher, "getNode", { id: ghost }));
    await row("get malformed id", req.get(`/api/nodes/not-a-uuid`), tool(researcher, "getNode", { id: "not-a-uuid" }));
    await row("update missing node", req.patch(`/api/nodes/${ghost}`, { ...H, data: { title: "x" } }), tool(researcher, "updateNode", { id: ghost, title: "x" }));
    await row("update bad type", req.patch(`/api/nodes/${note.id}`, { ...H, data: { title: 123 } }), tool(researcher, "updateNode", { id: note.id, title: 123 }));
    await row("update empty title", req.patch(`/api/nodes/${note.id}`, { ...H, data: { title: "" } }), tool(researcher, "updateNode", { id: note.id, title: "" }));
    await row("create under missing parent", req.post("/api/nodes", { ...H, data: { title: `Sys02 orphan ${s}`, parent_id: ghost } }), tool(researcher, "createNode", { title: `Sys02 orphan2 ${s}`, parent_id: ghost }));
    await row("create no title", req.post("/api/nodes", { ...H, data: {} }), tool(researcher, "createNode", {}));
    await row("apply missing tag", req.put(`/api/nodes/${note.id}/tags/${ghost}`, H), tool(researcher, "applyTag", { nodeId: note.id, tagId: ghost }));
    await row("apply tag to missing node", req.put(`/api/nodes/${ghost}/tags/${tagA}`, H), tool(researcher, "applyTag", { nodeId: ghost, tagId: tagA }));
    await row("remove tag not applied", req.delete(`/api/nodes/${note.id}/tags/${tagA}`, H), tool(researcher, "removeTag", { nodeId: note.id, tagId: tagA }));
    await row("rename tag to existing name", req.patch(`/api/nodes/${tagB}`, { ...H, data: { title: `sys02a${s}` } }), tool(researcher, "updateNode", { id: tagB, title: `sys02a${s}` }));
    await row("tag → content node_type", req.patch(`/api/nodes/${tagB}`, { ...H, data: { node_type: "content" } }), tool(researcher, "updateNode", { id: tagB, node_type: "content" }));
    await row("write with read-only token", req.patch(`/api/nodes/${note.id}`, { ...H, data: { title: `Sys02 n ${s}` } }), tool(readOnly, "updateNode", { id: note.id, title: "ro" }));
    await row("unknown tool / route", req.post("/api/nodes/nope/nope", H), tool(researcher, "dropDatabase", {}));
    await row("non-JSON body", req.patch(`/api/nodes/${note.id}`, { headers: H.headers, data: "{not json" }), researcher.post("/api/mcp/tools/updateNode", { data: "{not json" }));
    out.matrix = m;
    out.orphansCreated = (await (await req.get(`/api/nodes?q=Sys02 orphan`)).text()).includes("orphan");
  } finally {
    for (const id of [note.id, tagA, tagB]) await req.delete(`/api/nodes/${id}`, H).catch(() => {});
    await req.delete(`/api/actors/${actor.id}`, H).catch(() => {});
    await researcher.dispose(); await readOnly.dispose();
    console.log("SYS02 " + JSON.stringify(out, null, 2));
  }
});
