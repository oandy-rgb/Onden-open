import { test, expect, type Page } from "@playwright/test";
import { createAgent, requireAdmin, defaultSpaceId, createPublishingSpace, H, publishRequest } from "./helpers";

// Pins the behaviour the speclint of project memory flagged as ambiguous or
// disclosed-but-risky — turning spec contracts into verified, committed
// regression tests. Agent paths need the e2e user to be workspace admin → run
// on a freshly-reset stack.

// These contracts are about an agent's edits that land directly: an AI role
// whose review rule is 「直接編輯」 (a new agent only suggests, 2026-10-30).
async function agentHeaders(page: Page, name: string) {
  const agent = await createAgent(page.request, name, { reviewRule: "apply" });
  return { actorId: agent.id, headers: agent.headers };
}
async function latestBody(page: Page, id: string) {
  return (await (await page.request.get(`/api/nodes/${id}/versions`)).json())[0]?.markdown ?? "";
}

// F2/S3 — rejecting an agent edit on a node a human edited AFTERWARD must NOT
// silently clobber the human's edit. The spec left "does inbox reject force?"
// undefined; pin the safe contract.
test("F2: rejecting an agent edit after a human edit is refused (no clobber)", async ({ page }) => {
  const stamp = Date.now();
  const agentH = await agentHeaders(page, `Reviser ${stamp}`);
  requireAdmin(!!agentH, "actor creation needs admin; reset the stack");
  const node = await (await page.request.post("/api/nodes", { ...H, data: { space_id: await defaultSpaceId(page.request), title: `Road ${stamp}`, markdown: "HUMAN original\nshared" } })).json();
  await page.request.post("/api/mcp/tools/updateNode", { headers: agentH!.headers, data: { args: { id: node.id, title: `Road ${stamp}`, markdown: "AGENT rewrote\nshared", base_markdown: "HUMAN original\nshared" } } });
  await page.request.patch(`/api/nodes/${node.id}`, { ...H, data: { title: `Road ${stamp}`, markdown: "HUMAN FINAL\nshared and more" } });

  const inbox = await (await page.request.get("/api/inbox")).json();
  const e1 = inbox.events.find((e: { event_type: string; actor_type: string }) => e.event_type === "NODE_UPDATED" && e.actor_type === "ai_agent");
  const res = await page.request.post(`/api/inbox/${e1.id}/reject`, { ...H });
  expect(res.status()).toBe(409);                                  // drift → refused, not forced
  expect(await latestBody(page, node.id)).toContain("HUMAN FINAL"); // human's later edit preserved
});

// S1 — a DELEGATED agent token (even role='admin') cannot mint a token. The
// permission graph is principal-only AND bearer tokens are confined to /api/mcp.
test("S1: an admin-role agent token cannot mint a token", async ({ page }) => {
  const stamp = Date.now();
  const adminAgent = await agentHeaders(page, `AdminAgent ${stamp}`);
  requireAdmin(!!adminAgent, "actor creation needs admin; reset the stack");
  const res = await page.request.post(`/api/actors/${adminAgent!.actorId}/tokens`, { headers: adminAgent!.headers, data: {} });
  expect(res.status()).toBe(403); // confined off /api/* + principal_admin (!tokenScope) both deny
});

// S2 — DOCUMENTS current behaviour (B[CURRENT] vs D[TARGET]): a null/unset token
// scope is unrestricted on tag-scoped writes — an agent can updateNode a tagless
// node. (Fail-open the [TARGET] deny-default would close; pinned so a future
// flip to deny is a deliberate, test-visible change.)
test("S2: a null-scope agent token can updateNode a tagless node (current fail-open)", async ({ page }) => {
  const stamp = Date.now();
  const agentH = await agentHeaders(page, `NullScope ${stamp}`);
  requireAdmin(!!agentH, "actor creation needs admin; reset the stack");
  const node = await (await page.request.post("/api/nodes", { ...H, data: { space_id: await defaultSpaceId(page.request), title: `Tagless ${stamp}`, markdown: "x" } })).json();
  const res = await page.request.post("/api/mcp/tools/updateNode", { headers: agentH!.headers, data: { args: { id: node.id, markdown: `agent wrote ${stamp}`, base_markdown: "x" } } });
  expect(res.ok()).toBeTruthy(); // null scope → unrestricted write
  expect(await latestBody(page, node.id)).toContain(`agent wrote ${stamp}`);
});

// S7/F5 — published-site privacy. A private node's BODY must never be served,
// and a published page's [[wikilink]] to a PRIVATE node must NOT leak that node's
// TITLE (inert-links fix); a [[wikilink]] to a PUBLISHED node must still resolve.
test("S7: the published site leaks neither private bodies nor private titles", async ({ page }) => {
  const stamp = Date.now();
  const secretTitle = `SecretTitle${stamp}`;
  const secretBody = `SECRETBODY${stamp}`;
  const visibleRef = `VisibleRef${stamp}`;
  // The secret note stays in the default space (which does not publish); the public ones are in a space that does.
  const site = await createPublishingSpace(page.request);
  await page.request.post("/api/nodes", { ...H, data: { space_id: await defaultSpaceId(page.request), title: secretTitle, markdown: `# secret\n\n${secretBody} must stay private` } });
  const vis = await (await page.request.post("/api/nodes", { ...H, data: { space_id: site, title: visibleRef, markdown: "a public reference" } })).json();
  await page.request.put(`/api/nodes/${vis.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
  const pub = await (await page.request.post("/api/nodes", { ...H, data: { space_id: site, title: `PubPage ${stamp}`, markdown: `Plan: [[${secretTitle}]] then [[${visibleRef}]].` } })).json();
  await page.request.put(`/api/nodes/${pub.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
  await publishRequest(page.request, {}); // build a snapshot

  const siteJson = await (await page.request.get("/api/site")).text();
  const siteHtml = await (await page.request.get(`/site/${pub.slug}`)).text();

  // INVARIANT: a private node's BODY never leaks.
  expect(siteJson).not.toContain(secretBody);
  expect(siteHtml).not.toContain(secretBody);
  // FIXED: a wikilink to a PRIVATE node no longer leaks its title (JSON + HTML).
  expect(siteJson).not.toContain(secretTitle);
  expect(siteHtml).not.toContain(secretTitle);
  // NOT over-redacted: a wikilink to a PUBLISHED node still renders its label.
  expect(siteHtml).toContain(visibleRef);
});
