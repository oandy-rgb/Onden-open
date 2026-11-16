// An agent that marks a paragraph as a review card through the text tools is told when that card has no back
// (services/agentTools/cardAdvice.ts): a card is a question with its answer indented under it, or a cloze; one line
// "question → answer" has no back. Only the cards the text adds are named; a person's own save says nothing.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getWorkspaceId, pool, q } from "../db.js";
import { callTool } from "../services/agentTools/index.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";

registerShippedModules();
const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

type Out = { card_notes?: string[] };

describe.skipIf(!isTestDb)("agent card advice", () => {
  let ws = "";
  const stamp = Date.now();
  let applier: ActorCtx, suggester: ActorCtx;
  const agent = (name: string, writeMode: "apply" | "suggest") => persistActor(ws, {
    id: "", name: `${name} ${stamp}`, role: "editor", type: "agent",
    tokenScope: { tokenId: "", allowedTools: null, access: "write", writeMode, expiresAt: null },
  });

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test', 'default') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`);
    ws = await getWorkspaceId();
    applier = await agent("Card advice applier", "apply");
    suggester = await agent("Card advice suggester", "suggest");
  });
  afterAll(async () => {
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1 AND title LIKE $2`, [ws, `Card advice %${stamp}%`]);
    await awaitAllDispatchers();
    await pool.end();
  });

  const create = async (markdown: string, actor = applier) =>
    callTool("createNode", { title: `Card advice ${Math.random().toString(36).slice(2)} ${stamp}`, markdown }, { actor, workspaceId: ws }) as Promise<Out & { id: string }>;

  it("createNode names a one-line card and says how to fix it", async () => {
    const out = await create("二分搜尋的時間複雜度？ → O(log n) {複習}\n");
    expect(out.card_notes).toHaveLength(1);
    expect(out.card_notes![0]).toContain("二分搜尋的時間複雜度？ → O(log n)");
    expect(out.card_notes![0]).toMatch(/縮排寫在問題下面|挖空/);
  });

  it("says nothing for a card that has its back, or a paragraph that is no card", async () => {
    const out = await create("- 問題？ {複習}\n  - 答案\n\n填空 ==詞== {複習}\n\n只是一行 {筆記}\n");
    expect(out.card_notes).toBeUndefined();
  });

  it("updateNode names only the cards this body adds", async () => {
    const before = "舊的一行卡 {複習}\n";
    const made = await create(before);
    expect(made.card_notes).toHaveLength(1);
    const next = `${before}\n新的一行卡 {複習}\n\n- 好卡？ {複習}\n  - 答案\n`;
    const saved = await callTool("updateNode", { id: made.id, markdown: next, base_markdown: before }, { actor: applier, workspaceId: ws }) as Out;
    expect(saved.card_notes).toHaveLength(1);
    expect(saved.card_notes![0]).toContain("新的一行卡");
  });

  it("an agent set to suggest gets the same note on its suggestion", async () => {
    const made = await create("起點\n");
    const out = await callTool("updateNode", { id: made.id, markdown: "起點\n\n問 → 答 {複習}\n", base_markdown: "起點\n" }, { actor: suggester, workspaceId: ws }) as Out & { status: string };
    expect(out.status).toBe("suggested");
    expect(out.card_notes).toHaveLength(1);
  });
});
