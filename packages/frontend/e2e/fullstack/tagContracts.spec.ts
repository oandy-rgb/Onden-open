import { test, expect, type Page } from "@playwright/test";
import { createAgent, defaultSpaceId, createSpace, createPublishingSpace, hideFromOthers, H, publishRequest } from "./helpers";

// Behaviour-driven contract tests for the TAG / SUPERTAG-SCHEMA / cascade
// substrate — the "tag = capability" half of the product thesis. HTTP-only;
// agent paths need the e2e user to be workspace admin → run on a fresh stack.

// An agent with a write token in 共用 (tokens are read or write since
// 2026-10-22; the spaces a token reaches are its agent's memberships).
async function agentToken(page: Page, name: string) {
  // An AI role that edits directly (「直接編輯」): a new agent may only suggest, and a suggest-only agent cannot apply tags or create notes (suggest_only, 2026-10-30).
  const agent = await createAgent(page.request, name, { reviewRule: "apply" });
  return { actorId: agent.id, headers: agent.headers };
}
async function importTag(page: Page, name: string, extra: Record<string, unknown>) {
  return (await page.request.post("/api/tags/import", { ...H, data: { name, ...extra } })).json();
}
async function attrs(page: Page, id: string): Promise<Array<{ key: string; value: string }>> {
  return (await page.request.get(`/api/nodes/${id}/attributes`)).json();
}

// (a) tag automation is gone: a pack that still carries on_apply installs without it, and applying the
//     tag sets nothing but what a field default seeds.
test("a tag pack's old on_apply is dropped; applying the tag seeds only the field default", async ({ page }) => {
  const stamp = Date.now();
  const tag = await importTag(page, `btag${stamp}`, {
    fields: [{ key: "stage", type: "text", default: "first" }],
    behaviour: { on_apply: { type: "set_attribute", key: "status", value: "todo" } },
  });
  expect(tag.id).toBeTruthy();
  const node = await (await page.request.post("/api/nodes", { ...H, data: { title: `N ${stamp}`, markdown: "x" } })).json();
  const ap = await page.request.put(`/api/nodes/${node.id}/tags/${tag.id}`, { ...H });
  expect(ap.ok()).toBeTruthy();
  await expect.poll(async () => (await attrs(page, node.id)).some((a) => a.key === "stage" && a.value === "first")).toBe(true);
  expect((await attrs(page, node.id)).some((a) => a.key === "status")).toBe(false);
});

// (b) editing a tag's schema is principal-only — an agent bearer token is refused.
test("an agent token cannot edit a tag's schema", async ({ page }) => {
  const stamp = Date.now();
  const agentH = await agentToken(page, `SchemaEd ${stamp}`);
  const tag = await importTag(page, `stag${stamp}`, { fields: [{ key: "x", type: "text" }] });
  const res = await page.request.patch(`/api/tags/${tag.id}/schema`, { headers: agentH.headers, data: { fields: [{ key: "y", type: "text" }] } });
  expect(res.status()).toBe(403);
});

// (c) space scope: an agent's token reaches the spaces its agent is a member
//     of (2026-10-22: token scopes were removed in favour of memberships). An
//     agent in the default space can apply a tag there, but not on a note in
//     another space that allows external AI yet does not have it as a member.
test("an agent cannot touch a note in a space it is not a member of", async ({ page }) => {
  const stamp = Date.now();
  const tagA = await importTag(page, `tagA${stamp}`, {});
  const shared = await defaultSpaceId(page.request);
  const agentH = await agentToken(page, `Scoped ${stamp}`);
  const other = await createSpace(page.request, `Other ${stamp}`);
  expect((await page.request.patch(`/api/spaces/${other}`, { ...H, data: { capabilities: { external_ai: true } } })).ok()).toBe(true);
  const inNode = await (await page.request.post("/api/nodes", { ...H, data: { title: `AN ${stamp}`, markdown: "x", space_id: shared } })).json();
  const outNode = await (await page.request.post("/api/nodes", { ...H, data: { title: `AO ${stamp}`, markdown: "x", space_id: other } })).json();
  const inScope = await page.request.post("/api/mcp/tools/applyTag", { headers: agentH.headers, data: { args: { nodeId: inNode.id, tagId: tagA.id } } });
  expect(inScope.ok(), await inScope.text()).toBeTruthy();   // the default space is granted
  const outScope = await page.request.post("/api/mcp/tools/applyTag", { headers: agentH.headers, data: { args: { nodeId: outNode.id, tagId: tagA.id } } });
  expect([403, 404]).toContain(outScope.status());            // the other space is not
});

// (d) GOVERNANCE: rejecting an agent's tag-apply reverts BOTH the tag AND the field default it
//     seeded (triggered_by walk).
test("rejecting an agent's tag-apply reverts the whole chain", async ({ page }) => {
  const stamp = Date.now();
  const tag = await importTag(page, `ctag${stamp}`, { fields: [{ key: "phase", type: "text", default: "started" }] });
  const agentH = await agentToken(page, `Cascade ${stamp}`);
  // In the default space: the agent cannot reach the principal's personal space.
  const node = await (await page.request.post("/api/nodes", { ...H, data: { title: `CN ${stamp}`, markdown: "x", space_id: await defaultSpaceId(page.request) } })).json();
  await page.request.post("/api/mcp/tools/applyTag", { headers: agentH.headers, data: { args: { nodeId: node.id, tagId: tag.id } } });
  await expect.poll(async () => (await attrs(page, node.id)).some((a) => a.key === "phase" && a.value === "started")).toBe(true); // default seeded

  const inbox = await (await page.request.get("/api/inbox")).json();
  const ev = inbox.events.find((e: { event_type: string; actor_type: string }) => e.event_type === "TAG_APPLIED" && e.actor_type === "ai_agent");
  expect(ev).toBeTruthy();
  const rej = await page.request.post(`/api/inbox/${ev.id}/reject`, { ...H });
  expect(rej.ok()).toBeTruthy();

  // Both reverted: seeded attribute gone, tag membership gone.
  await expect.poll(async () => (await attrs(page, node.id)).some((a) => a.key === "phase")).toBe(false);
  const boot = await (await page.request.get("/api/bootstrap")).json();
  const n = boot.nodes.find((x: { id: string }) => x.id === node.id);
  expect((n?.class_tag_ids ?? []).includes(tag.id)).toBe(false);
});

// (e) publishability follows the SPACE, not tags or schema — a schema-bearing
//     tag never blocks publishing; a note in a space that cannot publish is
//     excluded even when opted in. (Tags no longer carry read policies.)
test("the space (not tags or schema) gates the published site", async ({ page }) => {
  const stamp = Date.now();
  const space_id = await createPublishingSpace(page.request);
  const plain = `PlainPub${stamp}`;
  const tagged = `TaggedPub${stamp}`;
  const a = await (await page.request.post("/api/nodes", { ...H, data: { title: plain, markdown: "plain page", space_id } })).json();
  await page.request.put(`/api/nodes/${a.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
  const restricted = `RestrictedPub${stamp}`;
  // schema-bearing tag → publishable
  const tag = await importTag(page, `etag${stamp}`, { fields: [{ key: "x", type: "text" }] });
  const b = await (await page.request.post("/api/nodes", { ...H, data: { title: tagged, markdown: "tagged page", space_id } })).json();
  await page.request.put(`/api/nodes/${b.id}/tags/${tag.id}`, { ...H });
  await page.request.put(`/api/nodes/${b.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
  // a note moved to a personal space (publishing off) → excluded although its own space publishes
  const c = await (await page.request.post("/api/nodes", { ...H, data: { title: restricted, markdown: "secret page", space_id } })).json();
  await page.request.put(`/api/nodes/${c.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
  await hideFromOthers(page.request, c.id);
  await publishRequest(page.request, {});

  const site = await (await page.request.get("/api/site")).text();
  expect(site).toContain(plain);          // plain opted-in node IS served
  expect(site).toContain(tagged);         // a schema tag never blocks publishing
  expect(site).not.toContain(restricted); // a space without publish stays private despite opt-in
});
