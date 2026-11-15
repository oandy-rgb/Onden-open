// Feature-audit deepening (2026-10-07): TOKEN-04 — every registered agent tool
// against allowlist, space scope, actor ∩ token scope and the rate limit.
// Scope is by space (docs/architecture/spaces.md): "in" = the default space,
// "out" = a second space with external AI on. Every agent is a member of both
// unless a test narrows its membership (actor scope).
// Agent calls use cookie-less contexts (an invalid bearer would otherwise fall
// back to the suite's human session).
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { requireAdmin, defaultSpaceId, createSpace, BASE, H } from "./helpers";

const TOOLS = ["searchNodes", "getNode", "createNode", "updateNode", "applyTag", "removeTag", "queryView",
  "semanticSearch", "suggestLinks", "proposeTagPack", "reviewQueue", "publishSite"] as const;

const spaces = { in: "", out: "" };
async function agentFor(page: Page, opts: { tools?: string[] | null; spaces?: string[] | null; actorSpaces?: string[]; role?: string }) {
  const actor = await (await page.request.post("/api/actors", { ...H, data: {
    name: `T04 ${Date.now()}-${Math.random()}`, type: "agent", role: opts.role ?? "editor",
  } })).json();
  // New agents join the default ("in") space; add or remove to match actorSpaces.
  const member = opts.actorSpaces ?? [spaces.in, spaces.out];
  if (member.includes(spaces.out)) await page.request.put(`/api/spaces/${spaces.out}/members/${actor.id}`, { ...H, data: { permission: "edit" } });
  if (!member.includes(spaces.in)) await page.request.delete(`/api/spaces/${spaces.in}/members/${actor.id}`, H);
  const tok = await (await page.request.post(`/api/actors/${actor.id}/tokens`, { ...H, data: {
    allowed_tools: opts.tools ?? null, read_space_ids: opts.spaces ?? null, write_space_ids: opts.spaces ?? null,
  } })).json();
  const ctx = await pwRequest.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { origin: BASE, authorization: `Bearer ${tok.token}` } });
  return { actor, ctx };
}
const call = async (ctx: APIRequestContext, tool: string, args: unknown) => {
  const r = await ctx.post(`/api/mcp/tools/${tool}`, { data: { args } });
  const body = await r.text();
  return { status: r.status(), code: (/"error":"([a-z_]+)"/.exec(body) ?? [])[1] ?? "", body };
};

test("TOKEN-04: allowlist, space scope, actor∩token scope and rate limit across all tools", async ({ page }) => {
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

  // A. Allowlist: a token carrying exactly one tool reaches that tool and is refused every other.
  const allow: Record<string, string> = {};
  for (const tool of TOOLS) {
    const { ctx } = await agentFor(page, { tools: [tool] });
    const own = await call(ctx, tool, argsFor(tool));
    const others = await Promise.all(TOOLS.filter((t) => t !== tool).map((t) => call(ctx, t, argsFor(t))));
    const leaked = others.filter((o) => o.code !== "tool_not_allowed").length;
    allow[tool] = `own=${own.status}${own.code ? ":" + own.code : ""} othersRefused=${others.length - leaked}/${others.length}`;
    expect(own.code, `${tool} allowed for its own token`).not.toBe("tool_not_allowed");
    expect(leaked, `${tool}-only token reached other tools`).toBe(0);
    await ctx.dispose();
  }
  console.log(`AUDIT TOKEN-04 allowlist ${JSON.stringify(allow)}`);

  // B. Space scope (all tools allowed, token scope = the "in" space; the agent
  //    belongs to both): in-scope ok, out-of-scope refused or invisible.
  const { ctx: scoped } = await agentFor(page, { tools: null, spaces: [spaces.in] });
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
  const { ctx: both } = await agentFor(page, { tools: null, spaces: [spaces.in] });
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

  // C. Actor scope ∩ token scope: agent only in the "in" space, token scoped to
  //    the "out" space → nothing readable.
  const { ctx: crossed } = await agentFor(page, { tools: null, spaces: [spaces.out], actorSpaces: [spaces.in] });
  const cIn = await call(crossed, "getNode", { id: inNode });
  const cOut = await call(crossed, "getNode", { id: outNode });
  const cSearch = await call(crossed, "searchNodes", { query: `word${stamp}` });
  console.log(`AUDIT TOKEN-04 intersection getIn=${cIn.body.includes("In ")} getOut=${cOut.body.includes("Out ")} search in=${cSearch.body.includes(inNode)} out=${cSearch.body.includes(outNode)}`);
  await crossed.dispose();

  // D. Rate limit: 60/min per token.
  const { ctx: rl } = await agentFor(page, { tools: ["searchNodes"] });
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
