// The info panel's 「AI」 tab (services/panelChat.ts): one conversation per note and person,
// built from agent sessions of kind 'panel_chat'. It answers in the panel, never in the note;
// an edit it asks for is a pending suggestion; what it read is checked against its log.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database. No test reaches the real API.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { pool, q } from "../db.js";
import { addCredential } from "../services/aiCredentials.js";
import { finish, loadSession, markDelivered, type AgentSession } from "../services/agentSessions.js";
import { followPreview } from "../services/agentRuntime/index.js";
import { drainOutbox } from "../services/outbox.js";
import { answerLinks, clearPanelChat, panelChatRoles, panelChatThread, startPanelChat } from "../services/panelChat.js";
import { createNote } from "../services/noteCreate.js";
import { acceptSuggestionItems } from "../services/aiSuggestions.js";
import { noteFunctionWords } from "../services/noteFunctionsPrompt.js";
import { agentWorld, sessionActor } from "./helpers/agentSessionFixture.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { persistActor } from "./helpers/persistActor.js";
import { startFakeMessagesService, textMessage, toolUseMessage } from "./helpers/fakeMessagesService.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

registerShippedModules();

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789WXYZ";
const SECRET = "ab".repeat(32);

let fake: Awaited<ReturnType<typeof startFakeMessagesService>>;
beforeAll(async () => {
  if (!isTestDb) return;
  process.env.ONDEN_SECRET_KEY = SECRET;
  fake = await startFakeMessagesService();
  process.env.ONDEN_AI_BASE_URL_OVERRIDE = fake.url;
});
afterAll(async () => {
  if (isTestDb) await fake.close();
  delete process.env.ONDEN_SECRET_KEY;
  delete process.env.ONDEN_AI_BASE_URL_OVERRIDE;
  await pool.end();
});
beforeEach(() => {
  if (!isTestDb) return;
  fake.requests.length = 0; fake.state.script.length = 0; fake.state.fallback = null;
});

async function apiWorld(label: string, extra: { smallOnly?: boolean } = {}) {
  const w = await agentWorld(label);
  const credential = await addCredential(w.ws, { label: "test key", apiKey: KEY, baseUrl: fake.url, protocol: "v1_messages" }, { actor: w.owner });
  await q(
    `UPDATE agent_runners SET default_runtime = 'api', api_credential_id = $2, api_model = 'test-model',
            api_cap_choice = 'unlimited', api_small_actions_only = $3 WHERE actor_id = $1`,
    [w.agent.id, credential.id, extra.smallOnly ?? false]);
  return w;
}
type World = Awaited<ReturnType<typeof apiWorld>>;

const ask = (w: World, nodeId: string, text: string, scope: { noteIds?: string[]; tagIds?: string[] } = {}, requestId = randomUUID()) =>
  startPanelChat(w.ws, { actor: w.owner, agentActorId: w.agent.id, nodeId, text, scope, requestId });

async function run(sessionId: string): Promise<AgentSession> {
  const row = (await q<{ id: string }>(`SELECT id::text FROM outbox WHERE effect_kind = 'agent_session_run' AND payload->>'session_id' = $1`, [sessionId])).rows[0]!;
  await drainOutbox({ id: row.id });
  for (let i = 0; i < 200; i++) {
    const now = (await loadSession(sessionId))!;
    if (["completed", "failed", "cancelled"].includes(now.status)) return now;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("session did not finish");
}

describe.skipIf(!isTestDb)("a question in the panel", () => {
  it("answers on the session, never in the note; the thread keeps it, with sources checked against what the AI read", async () => {
    const w = await apiWorld("chat-answer");
    const nodeId = await w.note("今天的筆記");
    const otherId = await w.note("另一則\n\n重點在這一段 {重點}");
    const blk1 = (await q<{ anchor_id: string }>(`SELECT anchor_id FROM block_anchors WHERE note_id = $1 AND quote LIKE '重點在這一段%'`, [otherId])).rows[0]!.anchor_id;
    const otherTitle = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [otherId])).rows[0]!.title;
    const before = await w.body(nodeId);

    const { sessionId, created } = await ask(w, nodeId, "有哪些相關的筆記？");
    expect(created).toBe(true);
    expect(await loadSession(sessionId)).toMatchObject({ kind: "panel_chat", runtime: "api", write_mode: "suggest", status: "queued", anchor_block_id: null });
    fake.state.script.push(
      () => toolUseMessage("getNode", { id: otherId }),
      () => textMessage(`看〔[[${otherTitle}#^${blk1}]]〕，也見 [[${otherTitle}#^fake9]]`),
    );
    const done = await run(sessionId);
    expect(done).toMatchObject({ status: "completed", turns: 2 });
    expect(await w.body(nodeId)).toBe(before);

    const { turns } = await panelChatThread(w.ws, nodeId, { actor: w.owner });
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ session_id: sessionId, text: "有哪些相關的筆記？", status: "completed", suggestions: { pending: 0, accepted: 0, rejected: 0 } });
    expect(turns[0]!.reply).toContain(otherTitle);
    // the note it read through a tool is a source, with the paragraph that really exists; the open note is one too
    expect(turns[0]!.sources).toEqual(expect.arrayContaining([
      { node_id: otherId, title: otherTitle, block_id: blk1 },
    ]));
    expect(turns[0]!.sources.map((s) => s.node_id)).toContain(nodeId);
    // the model saw the open note as data and the question in <request>
    const last = fake.requests[0]!.body.messages.at(-1);
    expect(JSON.stringify(last)).toContain("今天的筆記");
    expect(JSON.stringify(last)).toContain("有哪些相關的筆記？");
  });

  it("a made-up paragraph id or a note it never read is not shown as a source", async () => {
    const w = await apiWorld("chat-unverified");
    const nodeId = await w.note("開著的筆記");
    const unread = await w.note("沒讀過的筆記 {mark}");
    const zz1 = (await q<{ anchor_id: string }>(`SELECT anchor_id FROM block_anchors WHERE note_id = $1`, [unread])).rows[0]!.anchor_id;
    const unreadTitle = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [unread])).rows[0]!.title;
    const { sessionId } = await ask(w, nodeId, "問");
    fake.state.script.push(() => textMessage(`[[${unreadTitle}#^${zz1}]] 還有 [[開著的筆記#^nope]]`));
    await run(sessionId);
    const { turns } = await panelChatThread(w.ws, nodeId, { actor: w.owner });
    expect(turns[0]!.sources.map((s) => s.node_id)).not.toContain(unread);
    expect(turns[0]!.sources.find((s) => s.node_id === nodeId)?.block_id).toBeNull();
  });

  it("the next question carries the earlier turns; 「清除這段對話」 starts over and the sessions stay", async () => {
    const w = await apiWorld("chat-history");
    const nodeId = await w.note("筆記");
    fake.state.script.push(() => textMessage("第一個答案"));
    const first = (await ask(w, nodeId, "第一個問題")).sessionId;
    await run(first);

    fake.state.script.push(() => textMessage("第二個答案"));
    const second = (await ask(w, nodeId, "第二個問題")).sessionId;
    expect((await loadSession(second))!.parent_session_id).toBe(first);
    await run(second);
    const messages = fake.requests[1]!.body.messages as Array<{ role: string; content: unknown }>;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(messages[0])).toContain("第一個問題");
    expect(JSON.stringify(messages[1])).toContain("第一個答案");
    expect((await panelChatThread(w.ws, nodeId, { actor: w.owner })).turns.map((t) => t.text)).toEqual(["第一個問題", "第二個問題"]);

    expect(await clearPanelChat(w.ws, nodeId, { actor: w.owner })).toEqual({ cleared: 2 });
    expect((await panelChatThread(w.ws, nodeId, { actor: w.owner })).turns).toEqual([]);
    expect((await q(`SELECT 1 FROM agent_sessions WHERE kind = 'panel_chat' AND node_id = $1`, [nodeId])).rows).toHaveLength(2);

    fake.state.script.push(() => textMessage("新的答案"));
    const third = (await ask(w, nodeId, "第三個問題")).sessionId;
    expect((await loadSession(third))!.parent_session_id).toBeNull();
    await run(third);
    expect(fake.requests[2]!.body.messages).toHaveLength(1);
    // another person's conversation about the same note is not touched by anyone else's clear
    expect((await panelChatThread(w.ws, nodeId, { actor: w.owner })).turns).toHaveLength(1);
  });

  it("is refused to clear while an answer is still being written", async () => {
    const w = await apiWorld("chat-busy");
    const nodeId = await w.note("筆記");
    await ask(w, nodeId, "還沒答");
    expect(await clearPanelChat(w.ws, nodeId, { actor: w.owner }).then(() => null, (e) => e.code)).toBe("chat_busy");
  });

  it("the same request id is the same turn", async () => {
    const w = await apiWorld("chat-idem");
    const nodeId = await w.note("筆記");
    const requestId = randomUUID();
    const first = await ask(w, nodeId, "問", {}, requestId);
    const again = await ask(w, nodeId, "問", {}, requestId);
    expect(again).toEqual({ sessionId: first.sessionId, created: false });
    expect((await q(`SELECT 1 FROM agent_sessions WHERE node_id = $1`, [nodeId])).rows).toHaveLength(1);
  });

  it("an edit it asks for is a pending suggestion; the answer says how many places, the note is unchanged", async () => {
    const w = await apiWorld("chat-edit");
    const nodeId = await w.note("原本的內容");
    const before = await w.body(nodeId);
    const { sessionId } = await ask(w, nodeId, "幫我改一下");
    fake.state.script.push(
      () => toolUseMessage("updateNode", { id: nodeId, markdown: "改過的內容", base_markdown: before }),
      () => textMessage("提了 1 處修改"),
    );
    expect((await run(sessionId)).status).toBe("completed");
    expect(await w.body(nodeId)).toBe(before);
    expect((await q(`SELECT 1 FROM domain_events WHERE event_type = 'NODE_UPDATED' AND actor_id = $1 AND target_id = $2`, [w.agent.id, nodeId])).rows).toHaveLength(0);
    const turn = (await panelChatThread(w.ws, nodeId, { actor: w.owner })).turns[0]!;
    expect(turn.suggestions).toEqual({ pending: 1, accepted: 0, rejected: 0 });
    expect(turn.pending).toHaveLength(1);
    expect(turn.pending[0]!.suggestion_id).toEqual(expect.any(String));
  });

  // The owner asked for questions to go "into review" and got a "## 複習" heading: the prompt now says how a paragraph
  // takes a function, and the suggestion the AI files that way becomes a real card once the owner accepts it.
  it("tells the AI how a paragraph becomes a review card or a task; a suggested {複習} is a card after the owner accepts", async () => {
    const w = await apiWorld("chat-functions");
    const nodeId = await w.note("第一題：什麼是詞彙分析？\n\n答：把字元切成 token。");
    const before = await w.body(nodeId);
    const { sessionId } = await ask(w, nodeId, "把第一題放進複習");
    const words = await noteFunctionWords(w.ws);
    expect(words.review).toEqual(expect.any(String));
    const marked = before.replace("第一題：什麼是詞彙分析？", `第一題：什麼是詞彙分析？ {${words.review}}`);
    fake.state.script.push(
      () => toolUseMessage("updateNode", { id: nodeId, markdown: marked, base_markdown: before }),
      () => textMessage("提了 1 處修改"),
    );
    expect((await run(sessionId)).status).toBe("completed");

    const system = JSON.stringify(fake.requests[0]!.body.system);
    expect(system).toContain("<note_functions>");
    expect(system).toContain(`{${words.review}}`);
    if (words.task) expect(system).toContain(`{${words.task}}`);
    expect(system).toMatch(/Do not create a note or a heading named after the function/);

    // Nothing is a card until the owner accepts.
    const cards = async () => (await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM function_refs r JOIN block_nodes b ON b.id = r.holder_block_id
        WHERE b.note_id = $1 AND r.function_id = 'review'`, [nodeId])).rows[0]!.n;
    expect(await w.body(nodeId)).toBe(before);
    expect(await cards()).toBe(0);
    const turn = (await panelChatThread(w.ws, nodeId, { actor: w.owner })).turns[0]!;
    expect(turn.suggestions).toEqual({ pending: 1, accepted: 0, rejected: 0 });
    await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: turn.pending[0]!.suggestion_id, itemIds: "all" });
    expect(await w.body(nodeId)).toContain(`{${words.review}}`);
    expect(await cards()).toBe(1);
  });

  it("the open note and the added notes are in the prompt; added notes must be readable and in the same space", async () => {
    const w = await apiWorld("chat-scope");
    const nodeId = await w.note("開著的筆記內容");
    const added = await w.note("加進範圍的筆記內容");
    const elsewhere = await makeSpace(w.ws, `other ${w.stamp}`, [{ id: w.owner.id, role: "manager" }, { id: w.agent.id, role: "editor" }]);
    const farNote = await w.note("別的空間的筆記", elsewhere);
    const stranger = await persistActor(w.ws, { id: "", name: `Stranger ${w.stamp}`, role: "editor", type: "human" });
    const secret = await makeSpace(w.ws, `secret ${w.stamp}`, [{ id: stranger.id, role: "editor" }, { id: w.agent.id, role: "editor" }]);
    const hidden = (await createNote({ actor: stranger, workspaceId: w.ws, title: `h ${w.stamp}`, markdown: "看不到的筆記", spaceId: secret, event: { uiContext: "test" } })).node.id as string;

    expect(await ask(w, nodeId, "問", { noteIds: [farNote] }).then(() => null, (e) => e.code)).toBe("scope_other_space");
    expect(await ask(w, nodeId, "問", { noteIds: [hidden] }).then(() => null, (e) => e.code)).toBe("not_found");
    expect(await ask(w, nodeId, "問", { noteIds: Array.from({ length: 9 }, () => randomUUID()) }).then(() => null, (e) => e.code)).toBe("scope_too_big");
    expect((await q(`SELECT 1 FROM agent_sessions WHERE node_id = $1`, [nodeId])).rows).toHaveLength(0);

    fake.state.script.push(() => textMessage("好"));
    const { sessionId } = await ask(w, nodeId, "比較這兩則", { noteIds: [added, nodeId] });
    await run(sessionId);
    const sent = JSON.stringify(fake.requests[0]!.body.messages);
    expect(sent).toContain("開著的筆記內容");
    expect(sent).toContain("加進範圍的筆記內容");
    expect(sent).not.toContain("別的空間的筆記");
    const turn = (await panelChatThread(w.ws, nodeId, { actor: w.owner })).turns[0]!;
    expect(turn.scope.notes.map((n) => n.id)).toEqual([added]);
    expect(turn.sources.map((s) => s.node_id)).toEqual(expect.arrayContaining([nodeId, added]));
  });

  it("says what it is doing while it works: a step before each tool call, the text so far, then the end", async () => {
    const w = await apiWorld("chat-live");
    const nodeId = await w.note("筆記");
    const other = await w.note("要讀的筆記");
    const otherTitle = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [other])).rows[0]!.title;
    const { sessionId } = await ask(w, nodeId, "讀一下");
    // the first reply is held back, so the listener is attached before the first step
    fake.state.script.push(async () => { await new Promise((r) => setTimeout(r, 300)); return toolUseMessage("getNode", { id: other }); }, () => textMessage("讀完了，答案在此"));
    const events: Array<{ kind: string; [k: string]: unknown }> = [];
    let ended = false;
    const row = (await q<{ id: string }>(`SELECT id::text FROM outbox WHERE effect_kind = 'agent_session_run' AND payload->>'session_id' = $1`, [sessionId])).rows[0]!;
    await drainOutbox({ id: row.id });
    let live: ReturnType<typeof followPreview> = null;
    for (let i = 0; i < 100 && !live; i++) {
      live = followPreview(sessionId, (e) => { events.push(e); if (e.kind === "end") ended = true; });
      if (!live) await new Promise((r) => setTimeout(r, 10));
    }
    expect(live).not.toBeNull();
    await run(sessionId);
    for (let i = 0; i < 100 && !ended; i++) await new Promise((r) => setTimeout(r, 10));
    const steps = events.filter((e) => e.kind === "step").map((e) => (e as unknown as { step: { what: string; title: string | null } }).step);
    const text = events.filter((e) => e.kind === "text").map((e) => e.text as string).join("");
    expect(steps[0]).toEqual({ what: "read", title: otherTitle });
    expect(events.map((e) => e.kind)).toContain("end");
    // what was streamed before the tool call is dropped (restart); the rest is the answer
    expect(text.endsWith("讀完了，答案在此")).toBe(true);
  });
});

describe.skipIf(!isTestDb)("who may ask, and with what", () => {
  it("a reader sees the roles but cannot start: only the AI's owner can; no role means a plain reason, nothing is written", async () => {
    const w = await apiWorld("chat-who");
    const viewer = await persistActor(w.ws, { id: "", name: `Viewer ${w.stamp}`, role: "editor", type: "human" });
    const shared = await makeSpace(w.ws, `viewable ${w.stamp}`, [{ id: w.owner.id, role: "manager" }, { id: w.agent.id, role: "editor" }, { id: viewer.id, permission: "view" }]);
    const note = await w.note("唯讀筆記", shared);
    const { roles } = await panelChatRoles(w.ws, note, { actor: viewer });
    expect(roles.find((r) => r.actor_id === w.agent.id)).toMatchObject({ reason: "not_agents_owner" });
    expect(roles[0]!.runtimes[0]).toHaveProperty("unavailable_reason");
    const refused = await startPanelChat(w.ws, { actor: viewer, agentActorId: w.agent.id, nodeId: note, text: "問", requestId: randomUUID() }).then(() => null, (e) => e.code);
    expect(refused).toBe("not_agents_owner");
    expect((await q(`SELECT 1 FROM agent_sessions WHERE initiator_id = $1`, [viewer.id])).rows).toHaveLength(0);
    // someone who cannot read the note gets nothing, not even that it exists
    const outsider = await persistActor(w.ws, { id: "", name: `Outsider ${w.stamp}`, role: "editor", type: "human" });
    expect(await panelChatThread(w.ws, note, { actor: outsider }).then(() => null, (e) => e.code)).toBe("not_found");
    expect(await panelChatRoles(w.ws, note, { actor: outsider }).then(() => null, (e) => e.code)).toBe("not_found");
  });

  it("an API role set to 'only small actions' is not offered the chat; the owner is told why before anything is written", async () => {
    const w = await apiWorld("chat-small", { smallOnly: true });
    const nodeId = await w.note("筆記");
    expect(await ask(w, nodeId, "問").then(() => null, (e) => e.code)).toBe("runtime_not_allowed");
    expect((await q(`SELECT 1 FROM agent_sessions WHERE node_id = $1`, [nodeId])).rows).toHaveLength(0);
  });

  it("an mcp run's finish keeps the answer on the session, whatever the agent is set to write", async () => {
    const w = await apiWorld("chat-sub");
    const nodeId = await w.note("筆記");
    const { sessionId } = await startPanelChat(w.ws, { actor: w.owner, agentActorId: w.agent.id, nodeId, text: "問", requestId: randomUUID(), runtime: "mcp" });
    expect(await loadSession(sessionId)).toMatchObject({ kind: "panel_chat", runtime: "mcp", status: "queued", write_mode: "suggest" });
    await markDelivered(sessionId, (await q<{ id: string }>(`INSERT INTO agent_tokens (actor_id, token_hash, name, access) VALUES ($1, $2, 'runner', 'write') RETURNING id::text`, [w.agent.id, randomUUID()])).rows[0]!.id);
    await q(`UPDATE agent_sessions SET status = 'running' WHERE id = $1`, [sessionId]);
    const runner = await sessionActor((await loadSession(sessionId))!, w.agent);
    const before = await w.body(nodeId);
    await finish(sessionId, { actor: runner, status: "completed", markdown: "訂閱跑法的答案" });
    expect(await loadSession(sessionId)).toMatchObject({ status: "completed", reply_markdown: "訂閱跑法的答案", reply_event_id: null });
    expect(await w.body(nodeId)).toBe(before);
    expect((await panelChatThread(w.ws, nodeId, { actor: w.owner })).turns[0]!.reply).toBe("訂閱跑法的答案");
  });
});

describe("answer links", () => {
  it("reads [[Title]] and [[Title#^id|label]] and keeps the paragraph id when any link has one", () => {
    const links = answerLinks("見 [[甲]]、[[甲#^b1|那段]]、[[乙#^c-2]] 與 [[丙|別名]]");
    expect([...links]).toEqual([["甲", "b1"], ["乙", "c-2"], ["丙", null]]);
  });
});
