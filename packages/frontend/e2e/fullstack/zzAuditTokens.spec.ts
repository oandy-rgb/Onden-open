// Feature-audit loop probes (2026-10-07): TOKEN-03／05／07 and FIND-02.
// REST /api/mcp/tools/* and JSON-RPC /api/mcp/protocol must share identity,
// scope, validation and errors; read tools must not leak out-of-scope notes.
import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";
import { requireAdmin, createSpace, defaultSpaceId, BASE, H } from "./helpers";


async function rpc(req: APIRequestContext, token: string, method: string, params: unknown) {
  const res = await req.post("/api/mcp/protocol", {
    headers: { origin: BASE, "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    data: { jsonrpc: "2.0", id: 1, method, params },
  });
  const text = await res.text();
  // Streamable HTTP may answer as SSE; take the last data: line.
  const data = text.includes("data:") ? text.split("\n").filter((l) => l.startsWith("data:")).pop()!.slice(5) : text;
  let json: any = null; try { json = JSON.parse(data); } catch { /* keep null */ }
  return { status: res.status(), json, raw: text.slice(0, 300) };
}

test("TOKEN-05/07 + FIND-02: scoped read-only token across REST and MCP protocol", async ({ page }) => {
  const stamp = Date.now();
  const word = `zebrafish${stamp}`;
  // Scope is a space, and a token reaches the spaces its agent is a member of (2026-10-22): "In" is a space the
  // agent belongs to (external AI on); "Out" sits in the default space, which the agent is taken out of below.
  const actor = await (await page.request.post("/api/actors", { ...H, data: { name: `Reader ${stamp}`, type: "agent" } })).json();
  requireAdmin(!!actor.id, "actor creation needs admin");
  const inSpace = await createSpace(page.request, `scopein-${stamp}`);
  await page.request.patch(`/api/spaces/${inSpace}`, { ...H, data: { capabilities: { external_ai: true } } });
  await page.request.put(`/api/spaces/${inSpace}/members/${actor.id}`, { ...H, data: { permission: "edit" } });
  const nIn = await (await page.request.post("/api/nodes", { ...H, data: { title: `In ${stamp}`, markdown: `${word} inside scope`, space_id: inSpace } })).json();
  const nOut = await (await page.request.post("/api/nodes", { ...H, data: { title: `Out ${stamp}`, markdown: `${word} outside scope [[In ${stamp}]]`, space_id: await defaultSpaceId(page.request) } })).json();

  expect((await page.request.delete(`/api/spaces/${await defaultSpaceId(page.request)}/members/${actor.id}`, H)).ok()).toBe(true);
  const minted = await page.request.post(`/api/actors/${actor.id}/tokens`, { ...H, data: { access: "read" } });
  expect(minted.status(), "mint a read token").toBe(201);
  const tok = await minted.json();
  const auth = { origin: BASE, "content-type": "application/json", authorization: `Bearer ${tok.token}` };
  // Agent calls must not carry the suite's human session cookie: an invalid
  // bearer falls back to the cookie identity in the auth middleware.
  const agent = await pwRequest.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });

  // REST read tools
  const search = await (await agent.post("/api/mcp/tools/searchNodes", { headers: auth, data: { args: { query: word } } })).json();
  const ids: string[] = JSON.stringify(search).match(/[0-9a-f]{8}-[0-9a-f-]{27}/g) ?? [];
  console.log(`AUDIT FIND-02 REST search sees in=${ids.includes(nIn.id)} out=${ids.includes(nOut.id)}`);
  const getOut = await agent.post("/api/mcp/tools/getNode", { headers: auth, data: { args: { id: nOut.id } } });
  const getOutText = await getOut.text();
  console.log(`AUDIT TOKEN-07 REST getNode(out): ${getOut.status()} leaks=${getOutText.includes("outside scope")}`);
  const sugg = await agent.post("/api/mcp/tools/suggestLinks", { headers: auth, data: { args: { nodeId: nIn.id } } });
  const suggText = await sugg.text();
  console.log(`AUDIT FIND-02 REST suggestLinks(in): ${sugg.status()} mentionsOut=${suggText.includes(nOut.id) || suggText.includes(`Out ${stamp}`)}`);
  const suggOut = await agent.post("/api/mcp/tools/suggestLinks", { headers: auth, data: { args: { nodeId: nOut.id } } });
  console.log(`AUDIT FIND-02 REST suggestLinks(out source): ${suggOut.status()} body=${(await suggOut.text()).slice(0, 120)}`);

  // Disallowed write + validation
  const write = await agent.post("/api/mcp/tools/createNode", { headers: auth, data: { args: { title: `nope ${stamp}` } } });
  console.log(`AUDIT TOKEN-05 REST disallowed createNode: ${write.status()} ${(await write.text()).slice(0, 120)}`);
  const bad = await agent.post("/api/mcp/tools/searchNodes", { headers: auth, data: { args: { query: "" } } });
  console.log(`AUDIT TOKEN-05 REST invalid args: ${bad.status()} ${(await bad.text()).slice(0, 120)}`);

  // MCP protocol: same token, same questions
  const init = await rpc(agent, tok.token, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "audit", version: "0" } });
  console.log(`AUDIT TOKEN-05 MCP initialize: ${init.status} ${init.raw.slice(0, 100)}`);
  const list = await rpc(agent, tok.token, "tools/list", {});
  const toolNames = (list.json?.result?.tools ?? []).map((t: { name: string }) => t.name);
  console.log(`AUDIT TOKEN-05 MCP tools/list: ${list.status} tools=${JSON.stringify(toolNames)}`);
  const mSearch = await rpc(agent, tok.token, "tools/call", { name: "searchNodes", arguments: { query: word } });
  const mText = JSON.stringify(mSearch.json);
  console.log(`AUDIT FIND-02 MCP search sees in=${mText.includes(nIn.id)} out=${mText.includes(nOut.id)} status=${mSearch.status}`);
  const mGet = await rpc(agent, tok.token, "tools/call", { name: "getNode", arguments: { id: nOut.id } });
  console.log(`AUDIT TOKEN-07 MCP getNode(out): ${mGet.status} leaks=${JSON.stringify(mGet.json).includes("outside scope")} ${JSON.stringify(mGet.json).slice(0, 160)}`);
  const mWrite = await rpc(agent, tok.token, "tools/call", { name: "createNode", arguments: { title: `nope2 ${stamp}` } });
  console.log(`AUDIT TOKEN-05 MCP disallowed createNode: ${mWrite.status} ${JSON.stringify(mWrite.json).slice(0, 200)}`);
  const mBad = await rpc(agent, tok.token, "tools/call", { name: "searchNodes", arguments: { query: "" } });
  console.log(`AUDIT TOKEN-05 MCP invalid args: ${mBad.status} ${JSON.stringify(mBad.json).slice(0, 200)}`);
  const created = (await (await page.request.get("/api/bootstrap")).json()).nodes.filter((n: { title: string }) => n.title?.startsWith("nope")).length;
  console.log(`AUDIT TOKEN-05 nodes created by refused writes: ${created}`);

  // TOKEN-03: revoke → both surfaces refuse immediately
  const tokens = await (await page.request.get(`/api/actors/${actor.id}/tokens`, H)).json();
  const tokenId = (tokens.find?.((t: { id: string }) => t.id) ?? tokens[0])?.id;
  console.log(`AUDIT TOKEN-03 list before: ${JSON.stringify(tokens).slice(0, 300)} mintedId=${tok.id} chosen=${tokenId}`);
  const revoke = await page.request.delete(`/api/actors/${actor.id}/tokens/${tokenId}`, H);
  console.log(`AUDIT TOKEN-03 revoke: ${revoke.status()} ${await revoke.text()}`);
  console.log(`AUDIT TOKEN-03 list after: ${JSON.stringify(await (await page.request.get(`/api/actors/${actor.id}/tokens`, H)).json()).slice(0, 300)}`);
  const afterRest = await agent.post("/api/mcp/tools/searchNodes", { headers: auth, data: { args: { query: word } } });
  const afterRpc = await rpc(agent, tok.token, "tools/list", {});
  console.log(`AUDIT TOKEN-03 after revoke REST=${afterRest.status()} MCP=${afterRpc.status}`);
  expect(afterRest.status()).toBe(401);

  // Expired token refused
  const exp = await (await page.request.post(`/api/actors/${actor.id}/tokens`, { ...H, data: { access: "read", expires_at: "2020-01-01T00:00:00Z" } })).json();
  const expRes = await agent.post("/api/mcp/tools/searchNodes", { headers: { ...auth, authorization: `Bearer ${exp.token}` }, data: { args: { query: word } } });
  console.log(`AUDIT TOKEN-03 expired token: ${expRes.status()}`);
});

test("AI-08 + TOKEN-03: agent stats separate success/failure; soft revoke refuses", async ({ page }) => {
  const stamp = Date.now();
  const actor = await (await page.request.post("/api/actors", { ...H, data: { name: `Stats ${stamp}`, type: "agent" } })).json();
  const tok = await (await page.request.post(`/api/actors/${actor.id}/tokens`, { ...H, data: { access: "write" } })).json();
  const agent = await pwRequest.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { origin: BASE, authorization: `Bearer ${tok.token}` } });
  const call = async (tool: string, args: unknown) => (await agent.post(`/api/mcp/tools/${tool}`, { data: { args } })).status();
  const results = {
    search: await call("searchNodes", { query: `stats${stamp}` }),
    create: await call("createNode", { title: `Agent made ${stamp}`, markdown: "hi" }),
    badArgs: await call("searchNodes", { query: "" }),
    notAllowed: await call("publishSite", {}),
    missing: await call("getNode", { id: "00000000-0000-4000-8000-000000000000" }),
    dryRun: (await agent.post(`/api/mcp/tools/createNode?dryRun=true`, { data: { args: { title: `Dry ${stamp}` } } })).status(),
  };
  console.log(`AUDIT AI-08 call statuses: ${JSON.stringify(results)}`);
  const stats = await (await page.request.get(`/api/actors/${actor.id}/stats`, H)).json();
  console.log(`AUDIT AI-08 stats: ${JSON.stringify(stats)}`);
  const dryCreated = (await (await page.request.get("/api/bootstrap")).json()).nodes.some((n: { title: string }) => n.title === `Dry ${stamp}`);
  console.log(`AUDIT AI-08 dry-run created a node: ${dryCreated}`);

  const tokens = await (await page.request.get(`/api/actors/${actor.id}/tokens`, H)).json();
  const soft = await page.request.post(`/api/actors/${actor.id}/tokens/${tokens[0].id}/revoke`, H);
  const after = await agent.post(`/api/mcp/tools/searchNodes`, { data: { args: { query: "x" } } });
  const listed = await (await page.request.get(`/api/actors/${actor.id}/tokens`, H)).json();
  console.log(`AUDIT TOKEN-03 soft revoke: ${soft.status()} → agent ${after.status()}; row kept=${listed.length === 1} revoked_at=${!!listed[0]?.revoked_at}`);
  await agent.dispose();
});
