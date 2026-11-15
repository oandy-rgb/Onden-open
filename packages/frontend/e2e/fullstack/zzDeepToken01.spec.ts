// Feature-audit deepening (2026-10-07): TOKEN-01 — actor lifecycle through the
// real UI, effect on already-minted tokens, empty vs null scope, and no
// privilege escalation by a non-owner human.
import { test, expect, request as pwRequest, type Page } from "@playwright/test";
import { ready, defaultSpaceId, createSpace, addToDefaultSpace, BASE, H } from "./helpers";

const agentCtx = (token: string) => pwRequest.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] },
  extraHTTPHeaders: { origin: BASE, authorization: `Bearer ${token}` } });

async function openActors(page: Page) {
  await page.locator(".user-menu-wrap button").first().click();
  await page.getByText("Manage Users").click();
  await expect(page.locator(".actors-table")).toBeVisible();
}

test("TOKEN-01: UI create / role change / remove, and the minted token follows", async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const name = `UIAgent ${stamp}`;
  // A note in the default space (the agent's only space): writing it requires
  // editor or manager there.
  const note = await (await page.request.post("/api/nodes", { ...H, data: { title: `T01 ${stamp}`, markdown: "x", space_id: await defaultSpaceId(page.request) } })).json();
  await ready(page, "/?view=notes");
  await openActors(page);
  const out: Record<string, string> = {};

  // Create through the form.
  const form = page.locator(".actors-add-form");
  await form.locator(".actors-input").fill(name);
  await form.locator(".actors-role-select").nth(0).selectOption("agent");
  await form.locator(".actors-role-select").nth(1).selectOption("editor");
  await form.locator(".actors-add-submit").click();
  const row = page.locator("tr", { hasText: name }).first();
  await expect(row).toBeVisible();
  const actors = await (await page.request.get("/api/actors", H)).json() as Array<{ id: string; name: string; role: string; type: string }>;
  const actor = actors.find((a) => a.name === name)!;
  out.created = `type=${actor.type} role=${actor.role}`;

  const tok = await (await page.request.post(`/api/actors/${actor.id}/tokens`, { ...H, data: { template: "organizer" } })).json();
  const agent = await agentCtx(tok.token);
  const write = async () => {
    // The body as it is now: the agent's edit is based on it (D87).
    const base = (await (await page.request.get(`/api/nodes/${note.id}`, H)).json()).markdown as string;
    return (await agent.post("/api/mcp/tools/updateNode", { data: { args: { id: note.id, markdown: `agent ${Date.now()}`, base_markdown: base } } })).status();
  };
  out.writeAsEditor = String(await write());

  // Role change through the UI: demote to viewer → the existing token loses write.
  await row.locator(".actors-role-select").selectOption("viewer");
  await expect.poll(async () => ((await (await page.request.get("/api/actors", H)).json()) as typeof actors).find((a) => a.id === actor.id)?.role).toBe("viewer");
  out.writeAsViewer = String(await write());
  await row.locator(".actors-role-select").selectOption("editor");
  await expect.poll(async () => ((await (await page.request.get("/api/actors", H)).json()) as typeof actors).find((a) => a.id === actor.id)?.role).toBe("editor");
  out.writeAfterRestore = String(await write());

  // Role change failure: 503 must not leave the UI claiming the new role.
  await page.route(`**/api/actors/${actor.id}`, (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 503, body: "{}" }) : r.continue());
  await row.locator(".actors-role-select").selectOption("admin");
  await page.waitForTimeout(1200);
  const shown = await row.locator(".actors-role-select").inputValue();
  const toast = (await page.locator(".toast, [role='alert']").allInnerTexts()).slice(-1)[0] ?? "";
  await page.unroute(`**/api/actors/${actor.id}`);
  const stored = ((await (await page.request.get("/api/actors", H)).json()) as typeof actors).find((a) => a.id === actor.id)?.role;
  out.roleChange503 = `selectShows=${shown} server=${stored} toast=${JSON.stringify(toast.slice(0, 60))}`;
  await page.reload({ waitUntil: "load" });
  await openActors(page);
  out.afterReloadSelect = await page.locator("tr", { hasText: name }).first().locator(".actors-role-select").inputValue();

  // Remove through the UI (confirm dialog) → token dead, actor gone.
  await page.locator("tr", { hasText: name }).first().locator(".actors-delete-btn[title='Remove']").click();
  await page.getByRole("button", { name: "Remove actor" }).click();
  await expect(page.locator("tr", { hasText: name })).toHaveCount(0);
  out.tokenAfterRemove = String((await agent.post("/api/mcp/tools/searchNodes", { data: { args: { query: "x" } } })).status());
  const events = await (await page.request.get(`/api/events?limit=200`, H)).json().catch(() => null);
  out.historyKept = String(JSON.stringify(events ?? "").includes(actor.id));
  await agent.dispose();
  console.log(`AUDIT TOKEN-01 ui ${JSON.stringify(out)}`);
});

test("TOKEN-01: empty vs null token scope, and non-owner cannot escalate", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const shared = await defaultSpaceId(page.request);
  const n = await (await page.request.post("/api/nodes", { ...H, data: { title: `ScopeNote ${stamp}`, markdown: "x", space_id: shared } })).json();
  // A space the second human will only VIEW: writes there need editor+.
  const viewOnly = await createSpace(page.request, `T01 view-only ${stamp}`);
  const guarded = await (await page.request.post("/api/nodes", { ...H, data: { title: `Guarded ${stamp}`, markdown: "x", space_id: viewOnly } })).json();
  const otherSpace = await createSpace(page.request, `T01 other ${stamp}`);
  const actor = await (await page.request.post("/api/actors", { ...H, data: { name: `Scope ${stamp}`, type: "agent" } })).json();
  const out: Record<string, string> = {};
  // null = every space the agent is in (the default one); [] = none.
  for (const [label, scope] of [["null", null], ["empty", []], ["default", [shared]], ["other", [otherSpace]]] as const) {
    const tok = await (await page.request.post(`/api/actors/${actor.id}/tokens`, { ...H, data: { template: "read-only", read_space_ids: scope, write_space_ids: scope } })).json();
    const ctx = await agentCtx(tok.token);
    const got = await (await ctx.post("/api/mcp/tools/getNode", { data: { args: { id: n.id } } })).text();
    out[`scope=${label}`] = `canRead=${got.includes(`ScopeNote ${stamp}`)}`;
    await ctx.dispose();
  }

  // Second human: editor, not owner.
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const signup = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `Ed ${stamp}`, email: `ed-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  const edActor = await (await page.request.post("/api/actors", { ...H, data: { name: `Ed ${stamp}`, type: "human", external_id: signup.user.id } })).json();
  await addToDefaultSpace(page.request, edActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
  await page.request.put(`/api/spaces/${viewOnly}/members/${edActor.id}`, { ...H, data: { permission: "view" } });
  const req = (method: "post" | "patch" | "get", path: string, data?: unknown) => human.request[method](path, { ...H, ...(data ? { data } : {}) });
  out.edCreateAdmin = String((await req("post", "/api/actors", { name: `Evil ${stamp}`, type: "agent" })).status());
  out.edSelfPromote = String((await req("patch", `/api/actors/${edActor.id}`, { role: "admin" })).status());
  out.edMintForSelf = String((await req("post", `/api/actors/${edActor.id}/tokens`, { template: "publisher" })).status());
  out.edListActors = String((await req("get", "/api/actors")).status());
  const after = ((await (await page.request.get("/api/actors", H)).json()) as Array<{ id: string; role: string; name: string }>);
  out.edRoleAfter = after.find((a) => a.id === edActor.id)?.role ?? "?";
  out.evilCreated = String(after.some((a) => a.name === `Evil ${stamp}`));
  // Owner demotes the human → their next request uses the new role.
  await page.request.patch(`/api/actors/${edActor.id}`, { ...H, data: { role: "viewer" } });
  out.edWriteSharedAsViewer = String((await req("patch", `/api/nodes/${n.id}`, { markdown: "viewer write" })).status());
  out.edWriteViewOnlySpaceAsViewer = String((await req("patch", `/api/nodes/${guarded.id}`, { markdown: "viewer write" })).status());
  await page.request.patch(`/api/actors/${edActor.id}`, { ...H, data: { role: "editor" } });
  // Still only a viewer of that space: the space role decides.
  out.edWriteViewOnlySpaceAsEditor = String((await req("patch", `/api/nodes/${guarded.id}`, { markdown: "editor write" })).status());
  await human.close();
  console.log(`AUDIT TOKEN-01 scope ${JSON.stringify(out)}`);
});
