// Feature-audit deepening (2026-10-07): TOKEN-04 — every registered agent tool
// against the token's access, space scope and the rate limit.
// A token is read or write (2026-10-22, "only an owner and members; token access
// read/write": custom tool lists, per-token spaces and the role field were removed),
// and it reaches exactly the spaces its agent is a member of — there is no second,
// narrower scope on the token to intersect with.
// Scope is by space (docs/architecture/spaces.md): "in" = the default space,
// "out" = a second space with external AI on. An agent is a member of both
// unless a test narrows its membership.
// Agent calls use cookie-less contexts (an invalid bearer would otherwise fall
// back to the suite's human session).
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { requireAdmin, defaultSpaceId, createSpace, BASE, H } from "./helpers";

const TOOLS = ["searchNodes", "getNode", "createNode", "updateNode", "applyTag", "removeTag", "queryView",
  "semanticSearch", "suggestLinks", "proposeTagPack", "reviewQueue", "publishSite"] as const;
// Tools whose registry access is "read" (a read token reaches them); the others write or, for
// publishSite, are no agent tool any more (publishing is the owner's, not a token's).
const READ_TOOLS: readonly string[] = ["searchNodes", "getNode", "queryView", "semanticSearch", "suggestLinks", "reviewQueue"];
const WRITE_TOOLS: readonly string[] = ["createNode", "updateNode", "applyTag", "removeTag", "proposeTagPack"];

const spaces = { in: "", out: "" };
async function agentFor(page: Page, opts: { access: "read" | "write"; spaceMembership?: string[] }) {
  const actor = await (await page.request.post("/api/actors", { ...H, data: {
    name: `T04 ${Date.now()}-${Math.random()}`, type: "agent",
  } })).json();
  // New agents join the default ("in") space; add or remove to match spaceMembership.
  const member = opts.spaceMembership ?? [spaces.in, spaces.out];
  if (member.includes(spaces.out)) await page.request.put(`/api/spaces/${spaces.out}/members/${actor.id}`, { ...H, data: { permission: "edit" } });
  if (!member.includes(spaces.in)) await page.request.delete(`/api/spaces/${spaces.in}/members/${actor.id}`, H);
  const tok = await (await page.request.post(`/api/actors/${actor.id}/tokens`, { ...H, data: { access: opts.access } })).json();
  const ctx = await pwRequest.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { origin: BASE, authorization: `Bearer ${tok.token}` } });
  return { actor, ctx };
}
const call = async (ctx: APIRequestContext, tool: string, args: unknown) => {
  const r = await ctx.post(`/api/mcp/tools/${tool}`, { data: { args } });
  const body = await r.text();
  return { status: r.status(), code: (/"error":"([a-z_]+)"/.exec(body) ?? [])[1] ?? "", body };
};

test("TOKEN-04: token access, space scope and rate limit across all tools", async ({ page }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  spaces.in = await defaultSpaceId(page.request);
  spaces.out = await createSpace(page.request, `t04out-${stamp}`);
  expect((await page.request.patch(`/api/spaces/${spaces.out}`, { ...H, data: { capabilities: { external_ai: true } } })).ok()).toBe(true);
  const imp = async (name: string) => (await (await page.request.post("/api/tags/import", { ...H, data: { name, fields: [] } })).json()).id as string;
  const tIn = await imp(`t04in-${stamp}`), tIn2 = await imp(`t04in2-${stamp}`), tOut = await imp(`t04out-${stamp}`);
  requireAdmin(!!tIn && !!tOut, "tag import needs admin");
  const mk = async (title: string, tag: string, space_id: string) => {
    const n = await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: `${title} body word${stamp}`, space_id } })).json();
    await page.request.put(`/api/nodes/${n.id}/tags/${tag}`, { ...H, data: {} });
    return n.id as string;
  };
  const inNode = await mk(`In ${stamp}`, tIn, spaces.in), outNode = await mk(`Out ${stamp}`, tOut, spaces.out);
  await page.request.put(`/api/nodes/${inNode}/tags/${tIn2}`, { ...H, data: {} });
  const argsFor = (tool: string, node = inNode, tag = tIn2): unknown => ({
    searchNodes: { query: `word${stamp}` }, getNode: { id: node }, createNode: { title: `made ${stamp}`, tag_id: tIn },
    updateNode: { id: node, markdown: `edited ${stamp}`, base_markdown: `${node === outNode ? "Out" : "In"} ${stamp} body word${stamp}` }, applyTag: { nodeId: node, tagId: tag }, removeTag: { nodeId: node, tagId: tag },
    queryView: { viewId: "00000000-0000-4000-8000-000000000000" }, semanticSearch: { query: `word${stamp}` },
    suggestLinks: { nodeId: node }, proposeTagPack: { name: `pack${stamp}` }, reviewQueue: {}, publishSite: {},
  } as Record<string, unknown>)[tool];

  // A. Access: a read token reaches the read tools and is refused every write tool; a write token reaches both.
  //    No token reaches publishSite.
  const tiers: Record<string, string> = {};
  for (const access of ["read", "write"] as const) {
    const { ctx } = await agentFor(page, { access });
    for (const tool of TOOLS) {
      const r = await call(ctx, tool, argsFor(tool));
      if (tool === "publishSite") { expect(r.code, `${access} token calling publishSite`).toBe("unknown_tool"); continue; }
      const reaches = r.code !== "tool_not_allowed";
      const should = READ_TOOLS.includes(tool) || (access === "write" && WRITE_TOOLS.includes(tool));
      tiers[`${access}:${tool}`] = `${r.status}${r.code ? ":" + r.code : ""}`;
      expect(reaches, `${access} token calling ${tool} (answered ${r.status} ${r.code})`).toBe(should);
    }
    await ctx.dispose();
  }
  console.log(`AUDIT TOKEN-04 access ${JSON.stringify(tiers)}`);

  // B. Space scope (a write token; the agent belongs to the "in" space only): in-scope ok,
  //    out-of-scope refused or invisible.
  const { ctx: scoped } = await agentFor(page, { access: "write", spaceMembership: [spaces.in] });
  const scope: Record<string, string> = {};
  for (const tool of ["getNode", "updateNode", "applyTag", "removeTag", "suggestLinks"] as const) {
    const inR = await call(scoped, tool, argsFor(tool, inNode, tIn2));
    const outR = await call(scoped, tool, argsFor(tool, outNode, tOut));
    scope[tool] = `in=${inR.status} out=${outR.status}${outR.code ? ":" + outR.code : ""} outLeak=${outR.body.includes(`Out ${stamp}`)}`;
  }
  const crOut = await call(scoped, "createNode", { title: `scoped-out ${stamp}`, space_id: spaces.out });
  const crNone = await call(scoped, "createNode", { title: `scoped-none ${stamp}` });
  scope.createNode = `inOutSpace=${crOut.status}${crOut.code ? ":" + crOut.code : ""} noSpace=${crNone.status}${crNone.code ? ":" + crNone.code : ""}`;
  const search = await call(scoped, "searchNodes", { query: `word${stamp}` });
  scope.searchNodes = `in=${search.body.includes(inNode)} out=${search.body.includes(outNode)}`;
  // In-scope apply/remove positive case: a second token scoped to the "in" space.
  const { ctx: both } = await agentFor(page, { access: "write", spaceMembership: [spaces.in] });
  const rm = await call(both, "removeTag", { nodeId: inNode, tagId: tIn2 });
  const ap = await call(both, "applyTag", { nodeId: inNode, tagId: tIn2 });
  scope.applyRemoveInScope = `remove=${rm.status} apply=${ap.status}`;
  // Saved view: views belong to (global) tags; the out-tag view's only member
  // is in the out space, so its rows must stay invisible. Unknown view id too.
  const vIn = await (await page.request.post(`/api/tags/${tIn}/views`, { ...H, data: { name: `v-in-${stamp}` } })).json();
  const vOut = await (await page.request.post(`/api/tags/${tOut}/views`, { ...H, data: { name: `v-out-${stamp}` } })).json();
  const qIn = await call(scoped, "queryView", { viewId: vIn.id });
  const qOut = await call(scoped, "queryView", { viewId: vOut.id });
  const qMissing = await call(scoped, "queryView", { viewId: "00000000-0000-4000-8000-000000000000" });
  scope.queryView = `in=${qIn.status} rowsHaveIn=${qIn.body.includes(inNode) || qIn.body.includes("In ")} out=${qOut.status}${qOut.code ? ":" + qOut.code : ""} missing=${qMissing.status}${qMissing.code ? ":" + qMissing.code : ""}`;
  await both.dispose();
  // Search: retry for index lag.
  let found = false;
  for (let i = 0; i < 10 && !found; i++) { found = (await call(scoped, "searchNodes", { query: `word${stamp}` })).body.includes(inNode); if (!found) await page.waitForTimeout(500); }
  scope.searchAfterRetry = `in=${found}`;
  const searchTitle = await call(scoped, "searchNodes", { query: `In ${stamp}` });
  scope.searchByTitle = `in=${searchTitle.body.includes(inNode)} out=${searchTitle.body.includes(outNode)}`;
  console.log(`AUDIT TOKEN-04 spaceScope ${JSON.stringify(scope)}`);
  const outRaw = await (await page.request.get(`/api/nodes/${outNode}`, H)).json();
  console.log(`AUDIT TOKEN-04 out node untouched=${!String(outRaw.markdown).includes("edited")}`);
  await scoped.dispose();

  // C. Rate limit: 60/min per token.
  const { ctx: rl } = await agentFor(page, { access: "read" });
  const statuses: number[] = [];
  let retryAfter: string | undefined;
  for (let i = 0; i < 65; i++) {
    const r = await rl.post("/api/mcp/tools/searchNodes", { data: { args: { query: "x" } } });
    statuses.push(r.status());
    if (r.status() === 429) retryAfter = r.headers()["retry-after"];
  }
  const firstLimited = statuses.indexOf(429);
  console.log(`AUDIT TOKEN-04 rateLimit firstLimitedAt=${firstLimited + 1} limitedCount=${statuses.filter((s) => s === 429).length} retryAfter=${retryAfter}`);
  await rl.dispose();
});
