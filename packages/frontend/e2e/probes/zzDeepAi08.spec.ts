// Feature-audit deepening (2026-10-07): AI-08 — failures never count as
// changes, event payload minimisation (tool args), and live stats refresh.
import { test, expect, request as pwRequest } from "@playwright/test";
import { ready, hideFromOthers, BASE, H } from "../fullstack/helpers";


test("AI-08: tool events, minimisation, visibility to a non-admin, live stats", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const stamp = Date.now();
  const secret = `SECRET-${stamp}`;
  // The hidden note sits in a space of its own: the owner plus the agent
  // (external AI on there), never the non-admin human below.
  const hidden = await (await page.request.post("/api/nodes", { ...H, data: { title: `Hidden ${stamp}`, markdown: "x" } })).json();
  const hiddenSpace = await hideFromOthers(page.request, hidden.id);
  await page.request.patch(`/api/spaces/${hiddenSpace}`, { ...H, data: { capabilities: { external_ai: true } } });
  const actor = await (await page.request.post("/api/actors", { ...H, data: { name: `A08 ${stamp}`, type: "agent" } })).json();
  await page.request.put(`/api/spaces/${hiddenSpace}/members/${actor.id}`, { ...H, data: { permission: "edit" } });
  const tok = await (await page.request.post(`/api/actors/${actor.id}/tokens`, { ...H, data: { template: "organizer" } })).json();
  const agent = await pwRequest.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { origin: BASE, authorization: `Bearer ${tok.token}` } });
  const out: Record<string, string> = {};

  const ok = await agent.post("/api/mcp/tools/updateNode", { data: { args: { id: hidden.id, markdown: `${secret} body`, base_markdown: "x" } } });
  const denied = await agent.post("/api/mcp/tools/createNode", { data: { args: { title: `${secret} denied` } } });
  const invalid = await agent.post("/api/mcp/tools/searchNodes", { data: { args: { query: "" } } });
  out.calls = `update=${ok.status()} denied=${denied.status()} invalid=${invalid.status()}`;

  const events = await (await page.request.get("/api/events?limit=100", H)).json();
  const list = (Array.isArray(events) ? events : events.events ?? []) as Array<{ event_type: string; actor_id?: string; payload?: unknown; tx_meta?: unknown; target_id?: string }>;
  const mine = list.filter((e) => e.actor_id === actor.id);
  out.ownerEvents = JSON.stringify(mine.map((e) => e.event_type));
  const toolEvents = mine.filter((e) => e.event_type.startsWith("AGENT_TOOL"));
  out.toolEventsCarrySecret = String(toolEvents.some((e) => JSON.stringify(e).includes(secret)));
  out.nodeUpdatedCarriesSecret = String(mine.filter((e) => e.event_type === "NODE_UPDATED").some((e) => JSON.stringify(e).includes(secret)));
  const stats = await (await page.request.get(`/api/actors/${actor.id}/stats`, H)).json();
  out.stats = `calls=${stats.tool_calls} failures=${stats.tool_failures} changes=${stats.changes} byType=${JSON.stringify(stats.by_event_type)}`;

  // Can a non-admin human read the secret through events / inbox?
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const su = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `A08h ${stamp}`, email: `a08-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  await page.request.post("/api/actors", { ...H, data: { name: `A08h ${stamp}`, type: "human", external_id: su.user.id } });
  for (const path of ["/api/events?limit=200", "/api/inbox", `/api/nodes/${hidden.id}`, `/api/nodes/${hidden.id}/versions`]) {
    const r = await human.request.get(path, H);
    out[`editor ${path.split("?")[0]}`] = `${r.status()} leaksSecret=${(await r.text()).includes(secret)}`;
  }
  await human.close();

  // Live refresh: open the tokens panel (stats strip), make another call, see the count change without reopening.
  await ready(page, "/?view=notes");
  await page.locator(".user-menu-wrap button").first().click();
  await page.getByText("Manage Users").click();
  await page.locator("tr", { hasText: `A08 ${stamp}` }).first().locator(".actors-tokens-btn").click();
  const statsText = async () => (await page.locator(".token-manager").innerText()).replace(/\s+/g, " ");
  const before = await statsText();
  await agent.post("/api/mcp/tools/searchNodes", { data: { args: { query: "anything" } } });
  await page.waitForTimeout(4000);
  const after = await statsText();
  out.liveRefresh = `changed=${before !== after}`;
  out.statsStrip = JSON.stringify(before.match(/\d+ (calls?|tool calls?)[^.]{0,60}/i)?.[0] ?? before.slice(0, 120));
  await agent.dispose();
  console.log(`AUDIT AI-08 ${JSON.stringify(out)}`);
});
