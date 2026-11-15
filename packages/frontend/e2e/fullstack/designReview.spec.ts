import { test, expect, type Page } from "@playwright/test";
import { createAgent, ready, openNoteHistory, defaultSpaceId, H } from "./helpers";

// Self-verification SCREENSHOTS for a design pass — drives the app into the
// states I want to SEE, writes PNGs to SHOTS for eyeballing. Not assertions.
const SHOTS = "/tmp/pw-output/shots";

async function agentHeaders(page: Page, name: string) {
  // An AI role that edits directly (「直接編輯」): its changes land and come to the inbox for review; a new agent would only suggest (2026-10-30).
  return { headers: (await createAgent(page.request, name, { reviewRule: "apply" })).headers };
}

test("design: inbox governance + editor + schema lens", async ({ page }) => {
  const stamp = Date.now();
  const agentH = await agentHeaders(page, `Designer ${stamp}`);
  if (!agentH) { console.log(">> SKIP not admin"); return; }

  // Seed: a human note the agent then edits + a couple of agent-created notes,
  // so the Inbox review queue shows a mix of change kinds.
  // In the default space: the agent cannot reach the owner's personal space.
  const human = await (await page.request.post("/api/nodes", { ...H, data: { space_id: await defaultSpaceId(page.request), title: `Q3 roadmap ${stamp}`, markdown: "# Q3 roadmap\n\n- Ship the editor\n- Polish the canvas" } })).json();
  await page.request.post("/api/mcp/tools/updateNode", { headers: agentH.headers, data: { args: { id: human.id, title: `Q3 roadmap ${stamp}`, markdown: "# Q3 roadmap\n\n- Ship the editor\n- Polish the canvas\n- Wire the RAG answer loop (agent suggestion)", base_markdown: human.markdown } } });
  await page.request.post("/api/mcp/tools/createNode", { headers: agentH.headers, data: { args: { title: `Meeting notes ${stamp}`, markdown: "Standup: blockers on sync." } } });
  await page.request.post("/api/mcp/tools/createNode", { headers: agentH.headers, data: { args: { title: `Reading list ${stamp}`, markdown: "- CRDTs\n- event sourcing" } } });

  // 1) Inbox governance: 「等你決定」 atop the inbox lists each note an agent
  //    changed; opening one shows its review cards in the note (review → inbox,
  //    2026-10-30). The agent just acted, so the row exists — wait for the
  //    per-card summary (its diff-preview fetch) instead of a fixed sleep.
  await ready(page, "/?view=notes");
  await page.locator('.sidebar-tab:has-text("Inbox")').click();
  await page.getByRole("button", { name: `Open “Q3 roadmap ${stamp}” to decide` }).click();
  const expand = page.locator(".inbox-ev-summary").first();
  await expand.waitFor({ timeout: 15_000 });
  await expand.click();
  await expect(page.locator(".inbox-ev-diff").first()).toBeVisible(); // inline diff opened
  const body = await page.locator(".inbox-ev-summary").first().innerText().catch(() => "");
  console.log(">> EDIT_EVIDENCE=" + JSON.stringify(body));
  await page.screenshot({ path: `${SHOTS}/dz-inbox.png`, fullPage: false });

  // 2) Editor + inspector on the human note (post agent edit).
  await ready(page, `/?view=notes&node=${human.id}`);
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/dz-editor.png`, fullPage: false });

  // 3) Time-travel history (the feature built this session) on that node.
  await openNoteHistory(page);
  const open = page.locator(".note-history-link");
  if (await open.count()) {
    await open.click();
    await expect(page.locator(".nh")).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/dz-history.png`, fullPage: false });
    await page.keyboard.press("Escape");
  }
});
