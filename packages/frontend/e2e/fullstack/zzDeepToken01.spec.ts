// Feature-audit deepening (2026-10-07): TOKEN-01 — an AI role's lifecycle, the effect on
// an already-minted token, and no privilege escalation by a non-owner human.
// Since 2026-10-22 ("only an owner and members; space permission view/edit; token
// access read/write") a member has no workspace role to demote: what an agent may do
// is its permission in each space (view / edit), and a token reaches exactly that.
import { test, expect, request as pwRequest } from "@playwright/test";
import { ready, defaultSpaceId, createSpace, addToDefaultSpace, createAgent, openMember, BASE, H } from "./helpers";

const agentCtx = (token: string) => pwRequest.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] },
  extraHTTPHeaders: { origin: BASE, authorization: `Bearer ${token}` } });

test("TOKEN-01: space permission and removal in the UI, and the minted token follows", async ({ page }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const name = `UIAgent ${stamp}`;
  const space = await defaultSpaceId(page.request);
  // A note in the default space (the agent's only space): writing it takes edit there.
  const note = await (await page.request.post("/api/nodes", { ...H, data: { title: `T01 ${stamp}`, markdown: "x", space_id: space } })).json();
  // "apply": the agent's edit lands directly (a new agent only suggests, which would leave the note unchanged either way).
  const agent = await createAgent(page.request, name, { access: "write", reviewRule: "apply" });
  const token = await agentCtx(agent.token);
  const bodyNow = async () => (await (await page.request.get(`/api/nodes/${note.id}`, H)).json()).markdown as string;
  const writeLands = async (mark: string): Promise<boolean> => {
    // The body as it is now: the agent's edit is based on it.
    await token.post("/api/mcp/tools/updateNode", { data: { args: { id: note.id, markdown: mark, base_markdown: await bodyNow() } } });
    return (await bodyNow()) === mark;
  };
  expect(await writeLands(`agent edit ${stamp}`), "an editor member's write lands").toBe(true);

  // Demote to view-only in the space: the token already minted loses write at once, and keeps reading.
  const setPermission = async (permission: "view" | "edit") =>
    expect((await page.request.put(`/api/spaces/${space}/members/${agent.id}`, { ...H, data: { permission } })).ok()).toBe(true);
  await setPermission("view");
  expect(await writeLands(`agent edit while viewing ${stamp}`), "a view-only member's write is refused").toBe(false);
  expect((await token.post("/api/mcp/tools/getNode", { data: { args: { id: note.id } } })).status()).toBe(200);
  await setPermission("edit");
  expect(await writeLands(`agent edit restored ${stamp}`), "back to editor, the same token writes again").toBe(true);

  // Remove through the UI (Spaces and members › the role › Remove, with its confirmation): the token is dead, the role gone.
  await ready(page, "/?view=notes");
  const screen = await openMember(page, name);
  await screen.getByRole("button", { name: `Remove ${name}` }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove", exact: true }).click();
  await expect(screen.locator("li.sm-row[data-person-type]", { hasText: name })).toHaveCount(0);
  expect((await token.post("/api/mcp/tools/searchNodes", { data: { args: { query: "x" } } })).status()).toBe(401);
  const actors = await (await page.request.get("/api/actors", H)).json() as Array<{ id: string }>;
  expect(actors.some((a) => a.id === agent.id)).toBe(false);
  await token.dispose();
});

test("TOKEN-01: a token reaches its agent's spaces only, and a non-owner cannot escalate", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const stamp = Date.now();
  const shared = await defaultSpaceId(page.request);
  const n = await (await page.request.post("/api/nodes", { ...H, data: { title: `ScopeNote ${stamp}`, markdown: "x", space_id: shared } })).json();
  // A space the second human will only VIEW: writes there need edit.
  const viewOnly = await createSpace(page.request, `T01 view-only ${stamp}`);
  const guarded = await (await page.request.post("/api/nodes", { ...H, data: { title: `Guarded ${stamp}`, markdown: "x", space_id: viewOnly } })).json();
  const otherSpace = await createSpace(page.request, `T01 other ${stamp}`);
  const agent = await createAgent(page.request, `Scope ${stamp}`, { access: "read", space: false });
  const ctx = await agentCtx(agent.token);
  const canRead = async () => (await (await ctx.post("/api/mcp/tools/getNode", { data: { args: { id: n.id } } })).text()).includes(`ScopeNote ${stamp}`);
  // A token has no scope of its own: it follows the agent's membership, so an agent in no space reads nothing,
  // one in another space reads nothing here, and joining the default space opens it at once.
  expect(await canRead(), "agent in no space").toBe(false);
  await page.request.put(`/api/spaces/${otherSpace}/members/${agent.id}`, { ...H, data: { permission: "edit" } });
  expect(await canRead(), "agent in another space only").toBe(false);
  await addToDefaultSpace(page.request, agent.id, "view");
  expect(await canRead(), "agent in the default space").toBe(true);
  await page.request.delete(`/api/spaces/${shared}/members/${agent.id}`, H);
  expect(await canRead(), "agent taken out again").toBe(false);
  // The scope fields are gone from minting, and say so instead of being ignored.
  const old = await page.request.post(`/api/actors/${agent.id}/tokens`, { ...H, data: { access: "read", read_space_ids: [shared] } });
  expect(old.status()).toBe(400);
  await ctx.dispose();

  // Second human: a member, not the owner.
  const human = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const signup = await (await human.request.post("/api/auth/sign-up/email", { ...H, data: { name: `Ed ${stamp}`, email: `ed-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  const edActor = await (await page.request.post("/api/actors", { ...H, data: { name: `Ed ${stamp}`, type: "human", external_id: signup.user.id } })).json();
  await addToDefaultSpace(page.request, edActor.id); // A new member joins no shared space by itself (spaces.md, migration 097).
  await page.request.put(`/api/spaces/${viewOnly}/members/${edActor.id}`, { ...H, data: { permission: "view" } });
  const req = (method: "post" | "patch" | "get", path: string, data?: unknown) => human.request[method](path, { ...H, ...(data ? { data } : {}) });
  const evil = await req("post", "/api/actors", { name: `Evil ${stamp}`, type: "agent" });
  expect(evil.ok(), "a member makes no AI role").toBe(false);
  const mintForSelf = await req("post", `/api/actors/${edActor.id}/tokens`, { access: "write" });
  expect(mintForSelf.ok(), "a member mints no key").toBe(false);
  const listed = await (await page.request.get("/api/actors", H)).json() as Array<{ name: string }>;
  expect(listed.some((a) => a.name === `Evil ${stamp}`)).toBe(false);
  // A member edits where they can edit, and not in the space they only view.
  expect((await req("patch", `/api/nodes/${n.id}`, { markdown: "member write" })).ok(), "member edits the shared note").toBe(true);
  expect((await req("patch", `/api/nodes/${guarded.id}`, { markdown: "member write" })).ok(), "member cannot edit a view-only space").toBe(false);
  expect(((await (await page.request.get(`/api/nodes/${guarded.id}`, H)).json()) as { markdown: string }).markdown).toBe("x");
  await human.close();
});
