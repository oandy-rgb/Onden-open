// Feature-audit deepening (2026-10-08): AI-02 — an AI agent (organizer token,
// MCP updateNode) writes to a note while the owner has it open with an unsaved
// draft: which text wins, does the owner's editor show the agent's change,
// does the owner's next save keep it.
import { test, request as pwRequest } from "@playwright/test";
import { ready, createAgent, defaultSpaceId, BASE, H } from "../fullstack/helpers";


test("AI-02: agent write vs open editor draft", async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  // A write token (the old "organizer" template) for an agent in 共用, where the note goes.
  const actor = await createAgent(page.request, `Agent02 ${stamp}`, { access: "write" });
  const agent = await pwRequest.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { origin: BASE, authorization: `Bearer ${actor.token}` } });
  const note = await (await page.request.post("/api/nodes", { ...H, data: { title: `Ai02 ${stamp}`, markdown: "line1\nline2\nline3", space_id: await defaultSpaceId(page.request) } })).json();
  const server = async () => (await (await page.request.get(`/api/nodes/${note.id}`)).json()).markdown as string;
  try {
  await ready(page, `/?view=notes&node=${note.id}&lens=editor`); await page.waitForTimeout(1500);
  // Agent appends a line while the owner is idle.
  const w1 = await agent.post("/api/mcp/tools/updateNode", { data: { args: { id: note.id, markdown: "line1\nline2\nline3\nAGENT-ADDED", base_markdown: "line1\nline2\nline3" } } });
  out.agentWrite = { status: w1.status(), body: (await w1.text()).slice(0, 120) };
  await page.waitForTimeout(4000);
  out.idleEditor = { server: await server(), editor: (await page.locator(".cm-content").first().innerText()).replace(/\n/g, "⏎") };
  // Owner now types on line1 and saves.
  await page.locator(".cm-line", { hasText: "line1" }).first().click(); await page.keyboard.press("End"); await page.keyboard.type(" OWNER");
  await page.waitForTimeout(3000);
  out.afterOwnerSave = { server: await server() };
  // Agent writes during an unsaved owner draft.
  await page.locator(".cm-line", { hasText: "line2" }).first().click(); await page.keyboard.press("End"); await page.keyboard.type(" DRAFT");
  const read = await server();
  const w2 = await agent.post("/api/mcp/tools/updateNode", { data: { args: { id: note.id, markdown: read + "\nAGENT-2", base_markdown: read } } });
  out.agentWrite2 = w2.status();
  await page.waitForTimeout(3500);
  out.afterRace = { server: await server(), editor: (await page.locator(".cm-content").first().innerText()).replace(/\n/g, "⏎") };
  // Inbox: did the agent writes land directly or as proposals?
  const inbox = await (await page.request.get("/api/inbox")).json().catch(() => null);
  out.inboxMentions = JSON.stringify(inbox ?? "").includes(note.id);
  } finally {
    await agent.dispose();
    console.log("AI02 " + JSON.stringify(out, null, 2));
  }
});
