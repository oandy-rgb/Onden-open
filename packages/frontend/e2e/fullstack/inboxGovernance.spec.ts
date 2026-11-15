import { test, expect, type Page } from "@playwright/test";
import { createAgent, ready, requireAdmin, defaultSpaceId, H, openNoteDecisions } from "./helpers";

// Behaviour-driven journeys over the INBOX GOVERNANCE surface — the product
// differentiator: a human reviews changes an AI agent already applied, and
// Reject runs the event's inverse-undo. Agents mutate ONLY via the MCP tool
// surface (a bearer token is 403'd on /api/nodes). Needs the e2e user to be
// workspace admin (actor creation) → run against a freshly-reset stack.
const SHOTS = "/tmp/pw-output/shots";

async function agentHeaders(page: Page, name: string) {
  // An AI role that edits directly (「直接編輯」): its changes land and come to the inbox for review; a new agent would only suggest (2026-10-30).
  const agent = await createAgent(page.request, name, { reviewRule: "apply" });
  return { actorId: agent.id, headers: agent.headers };
}

async function latestVersionBody(page: Page, nodeId: string): Promise<string> {
  const versions = await (await page.request.get(`/api/nodes/${nodeId}/versions`)).json();
  return versions[0]?.markdown ?? "";
}

// 1 — Reject an agent's NODE_UPDATED → the body reverts (inverse-undo). The
//     governance payoff: an agent rewrote my note, I reject, my words come back.
test("rejecting an agent edit reverts the body", { tag: "@critical" }, async ({ page }) => {
  const stamp = Date.now();
  const agentH = await agentHeaders(page, `Reviser ${stamp}`);
  requireAdmin(!!agentH, "actor creation needs admin; reset the stack");

  const original = "Original human plan.\nKeep this line.";
  const node = await (await page.request.post("/api/nodes", { ...H, data: { space_id: await defaultSpaceId(page.request), title: `Roadmap ${stamp}`, markdown: original } })).json();
  // Agent rewrites it through the MCP tool surface.
  const upd = await page.request.post("/api/mcp/tools/updateNode", { ...agentH!, data: { args: { id: node.id, title: `Roadmap ${stamp}`, markdown: "AGENT rewrote the whole thing.\nYour words are gone.", base_markdown: original } } });
  expect(upd.ok()).toBeTruthy();
  expect(await latestVersionBody(page, node.id)).toContain("AGENT rewrote"); // applied (apply-then-review)

  await ready(page);
  await openNoteDecisions(page, `Roadmap ${stamp}`);
  const item = page.locator(".inbox-review-item").first();
  await expect(item).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ib-before-reject.png`, fullPage: false });
  await item.locator(".inbox-review-reject").click();
  await expect(item).toHaveCount(0); // left the queue

  // The inverse-undo restored the human's body.
  await expect.poll(() => latestVersionBody(page, node.id)).toContain("Original human plan");
  expect(await latestVersionBody(page, node.id)).not.toContain("AGENT rewrote");
});

// 2 — Reviewing one queued change leaves the others untouched.
test("approving one agent change leaves the rest queued", { tag: "@critical" }, async ({ page }) => {
  const stamp = Date.now();
  const agentH = await agentHeaders(page, `Trio ${stamp}`);
  requireAdmin(!!agentH, "actor creation needs admin; reset the stack");

  for (const k of ["A", "B", "C"]) {
    const r = await page.request.post("/api/mcp/tools/createNode", { ...agentH!, data: { args: { title: `Agent ${k} ${stamp}`, markdown: "x" } } });
    expect(r.ok()).toBeTruthy();
  }
  await ready(page);
  // Each created note waits in 「等你決定」; B's change is decided in B.
  const rowOf = (k: string) => page.getByRole("button", { name: `Open “Agent ${k} ${stamp}” to decide`, exact: true });
  const rowB = await openNoteDecisions(page, `Agent B ${stamp}`);
  await page.locator(".inbox-review-item").first().locator(".inbox-review-approve").click();
  await expect(page.locator(".inbox-review-item")).toHaveCount(0); // B reviewed
  await page.locator('.sidebar-tab:has-text("Inbox")').click();
  await expect(rowB).toHaveCount(0);
  await expect(rowOf("A")).toBeVisible(); // A untouched
  await expect(rowOf("C")).toBeVisible(); // C untouched
});

// 3 — Human-only gate: an agent's own bearer token cannot review its changes.
test("an agent token cannot approve its own change", { tag: "@critical" }, async ({ page }) => {
  const stamp = Date.now();
  const agentH = await agentHeaders(page, `Selfapprove ${stamp}`);
  requireAdmin(!!agentH, "actor creation needs admin; reset the stack");

  const created = await page.request.post("/api/mcp/tools/createNode", { ...agentH!, data: { args: { title: `Gate ${stamp}`, markdown: "x" } } });
  expect(created.ok()).toBeTruthy();
  const inbox = await (await page.request.get("/api/inbox")).json();
  const ev = inbox.events.find((e: { event_type: string; payload?: { title?: string } }) => e.payload?.title === `Gate ${stamp}`);
  expect(ev).toBeTruthy();

  // The agent (bearer token) tries to approve — must be forbidden.
  const res = await page.request.post(`/api/inbox/${ev.id}/approve`, { ...agentH! });
  expect(res.status()).toBe(403);
  // And it's still pending for the human.
  const inbox2 = await (await page.request.get("/api/inbox")).json();
  expect(inbox2.events.some((e: { id: string }) => e.id === ev.id)).toBeTruthy();
});

// 4 — Approve is durable: a reviewed change doesn't resurface after a reload.
test("approved change stays out of the queue after reload", { tag: "@critical" }, async ({ page }) => {
  const stamp = Date.now();
  const agentH = await agentHeaders(page, `Durable ${stamp}`);
  requireAdmin(!!agentH, "actor creation needs admin; reset the stack");

  await page.request.post("/api/mcp/tools/createNode", { ...agentH!, data: { args: { title: `Persist ${stamp}`, markdown: "x" } } });
  await ready(page);
  await openNoteDecisions(page, `Persist ${stamp}`);
  const item = page.locator(".inbox-review-item").first();
  await item.locator(".inbox-review-approve").click();
  await expect(page.locator(".inbox-review-item")).toHaveCount(0);

  // Hard reload — the review row persisted, so it must not reappear. The
  // server's queue is the positive control (the panel derives from it).
  await expect.poll(async () => (await (await page.request.get("/api/inbox")).json()).events
    .some((e: { payload?: { title?: string } }) => e.payload?.title === `Persist ${stamp}`)).toBe(false);
  await ready(page);
  await page.locator('.sidebar-tab:has-text("Inbox")').click();
  await expect(page.getByRole("region", { name: "Inbox", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Open “Persist ${stamp}” to decide`, exact: true })).toHaveCount(0);
});

// 5 — REGRESSION: the queue shows the agent's CHANGE, not the per-call audit
//     envelope. AGENT_TOOL_CALLED is actor_type='ai_agent' too, so before the
//     inbox query excluded it every agent action double-counted (audit + change)
//     and offered Approve/Reject on an un-undoable audit row.
test("review queue excludes the agent-tool-call audit event", { tag: "@critical" }, async ({ page }) => {
  const stamp = Date.now();
  const agentH = await agentHeaders(page, `Noise ${stamp}`);
  requireAdmin(!!agentH, "actor creation needs admin; reset the stack");

  await page.request.post("/api/mcp/tools/createNode", { ...agentH!, data: { args: { title: `Single ${stamp}`, markdown: "x" } } });
  const inbox = await (await page.request.get("/api/inbox")).json();
  expect(inbox.events.some((e: { event_type: string }) => e.event_type === "AGENT_TOOL_CALLED")).toBe(false);

  await ready(page);
  await openNoteDecisions(page, `Single ${stamp}`);
  await expect(page.locator(".inbox-review-item")).toHaveCount(1); // one card for one action
  await expect(page.locator(".inbox-review-item", { hasText: "agent tool called" })).toHaveCount(0);
});

// 6 — BULK reject: filter the queue to one agent, then undo its whole spree in
//     two clicks (arm + confirm). The batch endpoint decides each event with
//     the exact single-reject semantics; the filter scopes the blast radius so
//     other actors' queued changes survive untouched.
test("bulk reject: a filtered agent's spree reverts in one decision", { tag: "@critical" }, async ({ page }) => {
  // The inbox no longer has an agent filter or a bulk reject across notes:
  // each note's changes are decided in the note (review → inbox, 2026-10-30),
  // and undoing a whole AI run lives in History (WorkspaceHistoryRunCard).
  // Rewrite against History's run undo.
  test.fixme(true, "the cross-note agent filter and bulk reject left the inbox (2026-10-30); the run undo is in History");
  const stamp = Date.now();
  const agentH = await agentHeaders(page, `Spree ${stamp}`);
  requireAdmin(!!agentH, "actor creation needs admin; reset the stack");
  const bystanderH = await agentHeaders(page, `Bystander ${stamp}`);

  // The spree: three notes through the MCP surface; a second agent's change
  // must NOT be swept up by the filtered bulk decision.
  for (const k of ["A", "B", "C"]) {
    const r = await page.request.post("/api/mcp/tools/createNode", { ...agentH!, data: { args: { title: `Spree ${k} ${stamp}`, markdown: "agent text" } } });
    expect(r.ok()).toBeTruthy();
  }
  const by = await page.request.post("/api/mcp/tools/createNode", { ...bystanderH!, data: { args: { title: `Bystander note ${stamp}`, markdown: "kept" } } });
  expect(by.ok()).toBeTruthy();

  // The spree's node ids, from the queue's NODE_CREATED events.
  const queued = await (await page.request.get("/api/inbox")).json();
  const spreeEvents = queued.events.filter(
    (e: { event_type: string; payload?: { title?: string } }) =>
      e.event_type === "NODE_CREATED" && (e.payload?.title ?? "").includes(`Spree`) && (e.payload?.title ?? "").includes(`${stamp}`),
  );
  expect(spreeEvents).toHaveLength(3);
  const spreeNodeIds: string[] = spreeEvents.map((e: { target_id: string }) => e.target_id);

  await ready(page);
  await page.locator('.sidebar-tab:has-text("Inbox")').click();
  // Scope the queue to the spree agent via its actor chip…
  await page.locator(`.inbox-filter-chip:has-text("Spree ${stamp}")`).click();
  // Count by the stamped titles (held-effect cards from other suite runs on
  // the shared stack share .inbox-review-item and must not skew this).
  const spreeItems = page.locator(".inbox-review-item", { hasText: `${stamp}` });
  await expect(spreeItems).toHaveCount(3);
  await page.screenshot({ path: `${SHOTS}/ib-bulk-before.png`, fullPage: false });
  // …then bulk reject: first click arms, second confirms.
  await page.locator(".inbox-bulk-reject").click();
  await page.screenshot({ path: `${SHOTS}/ib-bulk-armed.png`, fullPage: false });
  const armed = page.locator(".inbox-bulk-reject.armed");
  await expect(armed).toContainText("sure?");
  // The armed state must LOOK destructive (oxblood fill), not just say so —
  // a regression here turns a two-step confirm into two identical buttons.
  await expect(armed).toHaveCSS("background-color", "rgb(124, 45, 45)");
  await armed.click();
  await expect(spreeItems).toHaveCount(0);

  // Every spree note is soft-deleted (NODE_CREATED's inverse) → in the trash…
  const trash = (await (await page.request.get("/api/nodes/trash")).json()) as { nodes: Array<{ id: string }> };
  const trashIds = new Set(trash.nodes.map((n) => n.id));
  for (const id of spreeNodeIds) expect(trashIds.has(id)).toBe(true);

  // …while the bystander's change is still queued (filter scoped the blast).
  const after = await (await page.request.get("/api/inbox")).json();
  expect(after.events.some(
    (e: { payload?: { title?: string } }) => (e.payload?.title ?? "") === `Bystander note ${stamp}`,
  )).toBe(true);
});
