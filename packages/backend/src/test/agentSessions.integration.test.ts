// Agent sessions, core (docs/archive/architecture/agent-mentions-2026-10-22.md PR 1):
// start (idempotent, refusals, rollback), the progress log, finish (the server
// writes the reply), cancel, timeout and the kill switch.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, describe, expect, it } from "vitest";
import { pool, q } from "../db.js";
import {
  appendEvent, cancel, configureRunner, expireOverdue, finish, loadSession, markDelivered, replyBlockId, sessionLog,
  setRunnerEnabled, startSession, AgentSessionError, type AgentSession,
} from "../services/agentSessions.js";
import { AuthorityError } from "../spine/authority.js";
import { updateNode } from "../services/nodeUpdate.js";
import { persistActor } from "./helpers/persistActor.js";
import { agentWorld, sessionActor } from "./helpers/agentSessionFixture.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

afterAll(async () => { await pool.end(); });

async function started(w: Awaited<ReturnType<typeof agentWorld>>, markdown: string) {
  const nodeId = await w.note(markdown);
  const { session } = await startSession(w.ws, { actor: w.owner, nodeId, target: { blockText: markdown.split("\n")[0]! } });
  return { nodeId, session };
}
/** Claim as a runner would, then ack: the session is running. */
async function running(w: Awaited<ReturnType<typeof agentWorld>>, session: AgentSession) {
  const delivered = (await markDelivered(session.id, w.agent.tokenScope!.tokenId))!;
  const runner = await sessionActor(delivered, w.agent);
  await appendEvent(session.id, { actor: runner, seq: 1, kind: "ack", text: "hi" });
  return runner;
}
const rejection = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
const startedEvents = async (nodeId: string) =>
  Number((await q<{ n: string }>(`SELECT count(*) AS n FROM domain_events WHERE event_type = 'AGENT_SESSION_STARTED' AND payload->>'node_id' = $1`, [nodeId])).rows[0]!.n);

describe.skipIf(!isTestDb)("startSession", () => {
  it("creates one session, anchors the paragraph (the text stays as written), snapshots the prompt and roots the chain", async () => {
    const w = await agentWorld("start");
    const nodeId = await w.note(`前言\n\n看這個 @${w.handle} 幫我整理\n這段\n\n後面`);
    const { session, created } = await startSession(w.ws, { actor: w.owner, nodeId, target: { blockText: `看這個 @${w.handle} 幫我整理\n這段` } });
    expect(created).toBe(true);
    expect(session).toMatchObject({ status: "queued", prompt: "幫我整理\n這段", lead_in: "看這個", revision: 1, initiator_id: w.owner.id, agent_actor_id: w.agent.id, space_id: w.space });
    // 提及的段落身分在錨點表；送出不改寫筆記內文。
    expect(await w.body(nodeId)).toBe(`前言\n\n看這個 @${w.handle} 幫我整理\n這段\n\n後面`);
    expect((await q(`SELECT 1 FROM block_anchors WHERE note_id = $1 AND anchor_id = $2 AND status = 'valid'`, [nodeId, session.anchor_block_id])).rows).toHaveLength(1);
    const root = (await q<{ event_type: string; actor_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, actor_type, payload FROM domain_events WHERE id = $1`, [session.root_event_id])).rows[0]!;
    expect(root).toMatchObject({ event_type: "AGENT_SESSION_STARTED", actor_type: "user" });
    expect(JSON.stringify(root.payload)).not.toContain("幫我整理"); // length only, never the prompt
    // sending edits no text, so no NODE_UPDATED hangs under the root
    const chained = await q(`SELECT 1 FROM domain_events WHERE triggered_by_event_id = $1 AND event_type = 'NODE_UPDATED'`, [session.root_event_id]);
    expect(chained.rows.length).toBe(0);
    expect(new Date(session.deadline_at).getTime()).toBeGreaterThan(Date.now() + 590_000);
  });

  it("12 concurrent sends of one mention make one session and one root event", async () => {
    const w = await agentWorld("race");
    const nodeId = await w.note(`@${w.handle} 一次就好`);
    const target = { blockText: `@${w.handle} 一次就好` };
    const results = await Promise.all(Array.from({ length: 12 }, () => startSession(w.ws, { actor: w.owner, nodeId, target })));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.session.id)).size).toBe(1);
    expect(await startedEvents(nodeId)).toBe(1);
    expect((await q(`SELECT 1 FROM agent_sessions WHERE node_id = $1`, [nodeId])).rows).toHaveLength(1);
    // and a later send by the block id (as the editor does once it knows it) is the same session
    const again = await startSession(w.ws, { actor: w.owner, nodeId, target: { blockId: results[0]!.session.anchor_block_id! } });
    expect(again).toMatchObject({ created: false, session: { id: results[0]!.session.id } });
  });

  it("resend makes revision 2 and cancels the open first one", async () => {
    const w = await agentWorld("resend");
    const { nodeId, session } = await started(w, `@${w.handle} 再來一次`);
    const second = await startSession(w.ws, { actor: w.owner, nodeId, target: { blockId: session.anchor_block_id! }, resend: true });
    expect(second).toMatchObject({ created: true, session: { revision: 2, anchor_block_id: session.anchor_block_id } });
    expect(await loadSession(session.id)).toMatchObject({ status: "cancelled", fail_code: "superseded" });
  });

  it("refuses before writing anything", async () => {
    const w = await agentWorld("refuse");
    const md = `@${w.handle} 問題`;
    const target = { blockText: md };
    const code = async (nodeId: string, over: Partial<Parameters<typeof startSession>[1]> = {}) => {
      const err = await rejection(startSession(w.ws, { actor: w.owner, nodeId, target, ...over }));
      return err instanceof AgentSessionError ? err.code : err;
    };
    const noRows = async (nodeId: string) => {
      expect((await q(`SELECT 1 FROM agent_sessions WHERE node_id = $1`, [nodeId])).rows).toHaveLength(0);
      expect(await startedEvents(nodeId)).toBe(0);
      expect(await w.body(nodeId)).toBe(md); // nothing written into the note
    };

    // an agent token cannot start one (D1)
    const nodeA = await w.note(md);
    expect(await code(nodeA, { actor: w.agent })).toBe("human_required");
    // unknown handle, empty prompt, skill
    const nodeB = await w.note("@nobody123 hi");
    expect(await rejection(startSession(w.ws, { actor: w.owner, nodeId: nodeB, target: { blockText: "@nobody123 hi" } }))).toMatchObject({ code: "unknown_agent" });
    const nodeC = await w.note(`@${w.handle}`);
    expect(await rejection(startSession(w.ws, { actor: w.owner, nodeId: nodeC, target: { blockText: `@${w.handle}` } }))).toMatchObject({ code: "empty_prompt" });
    const nodeD = await w.note(`@${w.handle} /[[摘要]] x`);
    expect(await rejection(startSession(w.ws, { actor: w.owner, nodeId: nodeD, target: { blockText: `@${w.handle} /[[摘要]] x` } }))).toMatchObject({ code: "skill_not_found" });
    expect(await rejection(startSession(w.ws, { actor: w.owner, nodeId: nodeD, target: { blockText: "nothing" } }))).toMatchObject({ code: "mention_not_found" });

    // the agent is not in the note's space
    const outside = (await import("./helpers/spaceFixtures.js")).makeSpace;
    const lonely = await outside(w.ws, `lonely ${w.stamp}`, [{ id: w.owner.id, role: "manager" }]);
    const nodeE = await w.note(md, lonely);
    expect(await code(nodeE)).toBe("agent_cannot_write");
    await noRows(nodeE);
    // the space keeps external AI out
    const closed = await outside(w.ws, `closed ${w.stamp}`, [{ id: w.owner.id, role: "manager" }, { id: w.agent.id, role: "editor" }], { publish: false, external_ai: false, backup: true });
    const nodeF = await w.note(md, closed);
    expect(await code(nodeF)).toBe("agent_cannot_write");
    await noRows(nodeF);

    // a viewer cannot write the note; an editor who is not the agent's owner is refused too
    const viewer = await persistActor(w.ws, { id: "", name: `viewer ${w.stamp}`, role: "viewer", type: "human" });
    const editor = await persistActor(w.ws, { id: "", name: `editor ${w.stamp}`, role: "editor", type: "human" });
    await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'view'), ($1, $3, 'edit')`, [w.space, viewer.id, editor.id]);
    expect(await rejection(startSession(w.ws, { actor: viewer, nodeId: nodeA, target }))).toBeInstanceOf(AuthorityError);
    expect(await code(nodeA, { actor: editor })).toBe("not_agents_owner");
    await noRows(nodeA);

    // trashed note
    const nodeG = await w.note(md);
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [nodeG]);
    expect(await rejection(startSession(w.ws, { actor: w.owner, nodeId: nodeG, target }))).toBeTruthy();

    // switched off
    await setRunnerEnabled(w.ws, w.agent.id, false, { actor: w.owner });
    expect(await code(nodeA)).toBe("agent_disabled");
    await noRows(nodeA);
  });

  it("holds the per-hour limit", async () => {
    const w = await agentWorld("hour");
    await configureRunner(w.ws, w.agent.id, { handle: w.handle, maxPerHour: 1 }, { actor: w.owner });
    await started(w, `@${w.handle} one`);
    const nodeId = await w.note(`@${w.handle} two`);
    expect(await rejection(startSession(w.ws, { actor: w.owner, nodeId, target: { blockText: `@${w.handle} two` } }))).toMatchObject({ code: "agent_rate_limited", status: 429 });
  });
});

describe.skipIf(!isTestDb)("runner side", () => {
  it("ack moves delivered → running; a re-sent seq changes nothing; a foreign token is refused", async () => {
    const w = await agentWorld("log");
    const { session } = await started(w, `@${w.handle} log`);
    expect(await rejection(markDelivered(session.id, "00000000-0000-0000-0000-000000000000").then((r) => { if (!r) throw new Error("claimed"); }))).toBeNull(); // queued: any token may claim
    const delivered = (await loadSession(session.id))!;
    expect(delivered).toMatchObject({ status: "delivered", attempt: 1 });
    const runner = await sessionActor(delivered, w.agent);
    expect(await appendEvent(session.id, { actor: runner, seq: 1, kind: "ack", text: "x" })).toEqual({ status: "running", deduped: false });
    expect(await appendEvent(session.id, { actor: runner, seq: 1, kind: "ack", text: "x" })).toEqual({ status: "running", deduped: true });
    await appendEvent(session.id, { actor: runner, seq: 2, kind: "thought", text: "y".repeat(5000) });
    await appendEvent(session.id, { actor: runner, seq: 3, kind: "action", tool: "getNode", targetId: "abc" });
    const log = await sessionLog(session.id);
    expect(log.map((l) => l.kind)).toEqual(["ack", "thought", "action"]);
    expect((log[1]!.body.text as string).length).toBe(2048);
    // the resident token (no session) and another session's token are refused
    expect(await rejection(appendEvent(session.id, { actor: w.agent, seq: 4, kind: "thought", text: "z" }))).toMatchObject({ code: "forbidden" });
    const other = await started(w, `@${w.handle} other`);
    const otherRunner = await sessionActor((await markDelivered(other.session.id, w.agent.tokenScope!.tokenId))!, w.agent);
    expect(await rejection(appendEvent(session.id, { actor: otherRunner, seq: 4, kind: "thought", text: "z" }))).toMatchObject({ code: "forbidden" });
  });

  it("only the same runner token may re-claim a delivered session", async () => {
    const w = await agentWorld("reclaim");
    const { session } = await started(w, `@${w.handle} reclaim`);
    const t1 = "11111111-1111-1111-1111-111111111111", t2 = "22222222-2222-2222-2222-222222222222";
    expect((await markDelivered(session.id, t1))!.attempt).toBe(1);
    expect(await markDelivered(session.id, t2)).toBeNull();
    expect((await markDelivered(session.id, t1))!.attempt).toBe(2);
  });
});

describe.skipIf(!isTestDb)("finish", () => {
  it("writes the reply under the mention, as the agent, in the session's chain; reply-only is reviewed", async () => {
    const w = await agentWorld("finish");
    const { nodeId, session } = await started(w, `@${w.handle} 整理\n\n後面一段`);
    const runner = await running(w, session);
    const result = await finish(session.id, { actor: runner, status: "completed", markdown: "三個重點：\n\n- a\n- b" });
    expect(result.replayed).toBe(false);
    const id = replyBlockId(session.anchor_block_id!, 1);
    const md = await w.body(nodeId);
    expect(md).toMatch(new RegExp(`^@${w.handle} 整理\\n\\n> \\*\\*Claude [^*]+\\*\\* · \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC\\n> 三個重點：\\n>\\n> - a\\n> - b\\n\\n後面一段$`));
    // 回覆區塊的身分是 id 為 `${anchor}r` 的錨點，不在文字裡
    expect((await q(`SELECT 1 FROM block_anchors WHERE note_id = $1 AND anchor_id = $2 AND status = 'valid'`, [nodeId, id])).rows).toHaveLength(1);
    const done = (await loadSession(session.id))!;
    expect(done).toMatchObject({ status: "completed" });
    expect(done.reply_event_id).toBeTruthy();
    const reply = (await q<{ actor_id: string; actor_type: string; triggered_by_event_id: string; tx_meta: { session_id: string } }>(
      `SELECT actor_id, actor_type, triggered_by_event_id::text, tx_meta FROM domain_events WHERE id = $1`, [done.reply_event_id])).rows[0]!;
    expect(reply).toMatchObject({ actor_id: w.agent.id, actor_type: "ai_agent", triggered_by_event_id: session.root_event_id });
    expect(reply.tx_meta.session_id).toBe(session.id);
    expect((await q(`SELECT decision, reviewed_by, note FROM event_reviews WHERE event_id = $1`, [done.reply_event_id])).rows[0])
      .toEqual({ decision: "approved", reviewed_by: w.owner.id, note: "session_reply" });
    expect((await q(`SELECT 1 FROM domain_events WHERE event_type = 'AGENT_SESSION_ENDED' AND target_id = $1`, [session.id])).rows).toHaveLength(1);
    // tokens die with the session
    expect((await q(`SELECT 1 FROM agent_tokens WHERE session_id = $1 AND revoked_at IS NULL`, [session.id])).rows).toHaveLength(0);
    // finishing again is a replay: nothing more is written
    expect(await finish(session.id, { actor: runner, status: "completed", markdown: "x" })).toMatchObject({ replayed: true });
    expect(await w.body(nodeId)).toBe(md);
  });

  it("another agent write in the session keeps the reply in the inbox", async () => {
    const w = await agentWorld("pending");
    const { session } = await started(w, `@${w.handle} 做事`);
    const runner = await running(w, session);
    const other = await w.note("別篇");
    const { runCascade } = await import("../spine/mutate.js");
    await runCascade({ actor: runner, workspaceId: w.ws, authority: { kind: "any_space_write" }, causeEventId: session.root_event_id! },
      () => updateNode(w.ws, other, { title: "別篇改過" }, { actor: runner, source: "agent" }));
    const { session: done } = await finish(session.id, { actor: runner, status: "completed", markdown: "好了" });
    expect((await q(`SELECT 1 FROM event_reviews WHERE event_id = $1`, [done.reply_event_id])).rows).toHaveLength(0);
  });

  it("never inserts the reply block twice, and appends at the end when the mention is gone", async () => {
    const w = await agentWorld("twice");
    const { nodeId, session } = await started(w, `@${w.handle} q`);
    const runner = await running(w, session);
    // the user deletes the mention line while it runs
    await updateNode(w.ws, nodeId, { markdown: "只剩這行\n" }, { actor: w.owner });
    await finish(session.id, { actor: runner, status: "completed", markdown: "答案" });
    const md = await w.body(nodeId);
    expect(md).toMatch(/^只剩這行\n\n> \*\*Claude[^\n]*\n> 答案\n$/);
    expect((await q(`SELECT 1 FROM block_anchors WHERE note_id = $1 AND anchor_id = $2`, [nodeId, replyBlockId(session.anchor_block_id!, 1)])).rows).toHaveLength(1);
  });

  it("a failed finish records the code; a cancelled or failed session cannot finish", async () => {
    const w = await agentWorld("fail");
    const a = await started(w, `@${w.handle} a`);
    const runnerA = await running(w, a.session);
    expect((await finish(a.session.id, { actor: runnerA, status: "failed", failCode: "credit_exhausted" })).session).toMatchObject({ status: "failed", fail_code: "credit_exhausted" });
    expect(await rejection(finish(a.session.id, { actor: runnerA, status: "completed", markdown: "x" }))).toMatchObject({ code: "session_ended" });
    expect(await w.body(a.nodeId)).not.toContain("> ");

    const b = await started(w, `@${w.handle} b`);
    const runnerB = await running(w, b.session);
    await cancel(b.session.id, { actor: w.owner });
    expect(await rejection(finish(b.session.id, { actor: runnerB, status: "completed", markdown: "x" }))).toMatchObject({ code: "session_ended" });
    expect(await w.body(b.nodeId)).not.toContain("> ");
  });

  it("fails the session when the agent lost write rights before the reply", async () => {
    const w = await agentWorld("lost");
    const { nodeId, session } = await started(w, `@${w.handle} q`);
    const runner = await running(w, session);
    await q(`UPDATE space_members SET permission = 'view' WHERE space_id = $1 AND actor_id = $2`, [w.space, w.agent.id]);
    const { session: ended } = await finish(session.id, { actor: runner, status: "completed", markdown: "答案" });
    expect(ended).toMatchObject({ status: "failed", fail_code: "reply_rejected" });
    expect(await w.body(nodeId)).not.toContain("答案");
  });

  it("refuses a session that was never claimed", async () => {
    const w = await agentWorld("unclaimed");
    const { session } = await started(w, `@${w.handle} q`);
    const delivered = (await markDelivered(session.id, w.agent.tokenScope!.tokenId))!;
    await q(`UPDATE agent_sessions SET status = 'queued' WHERE id = $1`, [session.id]);
    const runner = await sessionActor(delivered, w.agent);
    expect(await rejection(finish(session.id, { actor: runner, status: "completed", markdown: "x" }))).toMatchObject({ code: "not_claimable" });
  });
});

describe.skipIf(!isTestDb)("cancel, timeout and kill switch", () => {
  it("cancel is idempotent, limited to the sender or owner, and revokes tokens", async () => {
    const w = await agentWorld("cancel");
    const { session } = await started(w, `@${w.handle} c`);
    const runner = await running(w, session);
    const stranger = await persistActor(w.ws, { id: "", name: `x ${w.stamp}`, role: "editor", type: "human" });
    expect(await rejection(cancel(session.id, { actor: stranger }))).toMatchObject({ code: "forbidden" });
    expect(await rejection(cancel(session.id, { actor: runner }))).toMatchObject({ code: "human_required" });
    expect(await cancel(session.id, { actor: w.owner })).toMatchObject({ changed: true, session: { status: "cancelled" } });
    expect(await cancel(session.id, { actor: w.owner })).toMatchObject({ changed: false });
    expect((await q(`SELECT 1 FROM agent_tokens WHERE session_id = $1 AND revoked_at IS NULL`, [session.id])).rows).toHaveLength(0);
    expect(await rejection(appendEvent(session.id, { actor: runner, seq: 9, kind: "thought", text: "late" }))).toMatchObject({ code: "session_ended" });
  });

  it("cancelling a finished session answers session_ended", async () => {
    const w = await agentWorld("late");
    const { session } = await started(w, `@${w.handle} c`);
    const runner = await running(w, session);
    await finish(session.id, { actor: runner, status: "completed", markdown: "ok" });
    expect(await rejection(cancel(session.id, { actor: w.owner }))).toMatchObject({ code: "session_ended" });
  });

  it("expireOverdue fails queued and running sessions past their deadline, and only those", async () => {
    const w = await agentWorld("expire");
    const queued = (await started(w, `@${w.handle} q`)).session;
    const live = (await started(w, `@${w.handle} l`)).session;
    const running_ = (await started(w, `@${w.handle} r`)).session;
    await running(w, running_);
    await q(`UPDATE agent_sessions SET deadline_at = now() - interval '1 second' WHERE id = ANY($1::uuid[])`, [[queued.id, running_.id]]);
    expect(await expireOverdue()).toBeGreaterThanOrEqual(2);
    expect(await loadSession(queued.id)).toMatchObject({ status: "failed", fail_code: "timed_out" });
    expect(await loadSession(running_.id)).toMatchObject({ status: "failed", fail_code: "timed_out" });
    expect(await loadSession(live.id)).toMatchObject({ status: "queued" });
  });

  it("the kill switch cancels open sessions, revokes their tokens and only the owner may use it", async () => {
    const w = await agentWorld("kill");
    const { session } = await started(w, `@${w.handle} k`);
    const runner = await running(w, session);
    const editor = await persistActor(w.ws, { id: "", name: `e ${w.stamp}`, role: "editor", type: "human" });
    expect(await rejection(setRunnerEnabled(w.ws, w.agent.id, false, { actor: editor }))).toBeInstanceOf(AuthorityError);
    expect(await setRunnerEnabled(w.ws, w.agent.id, false, { actor: w.owner })).toMatchObject({ cancelled: 1, runner: { enabled: false } });
    expect(await loadSession(session.id)).toMatchObject({ status: "cancelled", fail_code: "agent_disabled" });
    expect((await q(`SELECT 1 FROM agent_tokens WHERE session_id = $1 AND revoked_at IS NULL`, [session.id])).rows).toHaveLength(0);
    expect(await rejection(finish(session.id, { actor: runner, status: "completed", markdown: "x" }))).toMatchObject({ code: "session_ended" });
  });

  it("configureRunner keeps handles unique and valid", async () => {
    const w = await agentWorld("handle");
    const second = await persistActor(w.ws, { id: "", name: `second ${w.stamp}`, role: "editor", type: "agent", tokenScope: { tokenId: "", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null } });
    expect(await rejection(configureRunner(w.ws, second.id, { handle: w.handle }, { actor: w.owner }))).toMatchObject({ code: "handle_taken" });
    expect(await rejection(configureRunner(w.ws, second.id, { handle: "Bad Handle" }, { actor: w.owner }))).toMatchObject({ code: "invalid_runner" });
    expect(await rejection(configureRunner(w.ws, second.id, { handle: "today" }, { actor: w.owner }))).toMatchObject({ code: "invalid_runner" });
    expect(await rejection(configureRunner(w.ws, w.owner.id, { handle: "human1" }, { actor: w.owner }))).toMatchObject({ code: "invalid_runner" });
  });
});
