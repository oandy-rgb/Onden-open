// Failure and hand-over edges of the AI collaboration code (review 2026-11-11).
// These tests pinned defects found by reading the code; they are fixed now (docs/archive/deep-review-ai-2026-11-11.md).
// Details, severity and fix directions: docs/archive/deep-review-ai-2026-11-11.md.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database. No real model is called.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool, q } from "../db.js";
import { AuthorityError } from "../spine/authority.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { createToken } from "../services/agentTokens.js";
import { acceptSuggestionItems, createSuggestions, rejectSuggestionItems, suggestionsForNode } from "../services/aiSuggestions.js";
import { addCredential } from "../services/aiCredentials.js";
import { loadSession, mayDirect, startSession, type AgentSession } from "../services/agentSessions.js";
import { startApiRun } from "../services/agentRuntime/api/run.js";
import { drainOutbox } from "../services/outbox.js";
import { agentWorld } from "./helpers/agentSessionFixture.js";
import { modelInfo, startFakeMessagesService, textMessage, toolUseMessage } from "./helpers/fakeMessagesService.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

registerShippedModules();
const enabled = isTestDatabase();
const KEY = "sk-ant-api03-edgesedgesedgesedgesedgesedges0123";
let fake: Awaited<ReturnType<typeof startFakeMessagesService>>;

beforeAll(async () => {
  if (!enabled) return;
  process.env.ONDEN_SECRET_KEY = "ef".repeat(32);
  fake = await startFakeMessagesService();
  process.env.ONDEN_AI_BASE_URL_OVERRIDE = fake.url;
});
afterAll(async () => {
  if (enabled) await fake.close();
  delete process.env.ONDEN_SECRET_KEY;
  delete process.env.ONDEN_AI_BASE_URL_OVERRIDE;
  await pool.end();
});
beforeEach(() => { if (enabled) { fake.requests.length = 0; fake.state.script.length = 0; fake.state.fallback = null; } });

const doc = (...paragraphs: string[]) => paragraphs.join("\n\n") + "\n";
const rejection = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

async function suggestWorld(label: string) {
  const w = await agentWorld(label);
  await q(`UPDATE actors SET write_mode = 'suggest' WHERE id = $1`, [w.agent.id]);
  const agent = await resolveCurrentActor({ id: w.agent.id, tokenScope: { tokenId: w.agent.tokenScope!.tokenId } }, w.ws);
  return { ...w, agent };
}
const propose = (w: Awaited<ReturnType<typeof suggestWorld>>, nodeId: string, base: string, proposed: string, sessionId: string | null = null) =>
  createSuggestions(w.ws, { actor: w.agent, proposer: { agentActorId: w.agent.id, sessionId }, nodeId, baseMarkdown: base, proposedMarkdown: proposed });
const itemStatuses = async (nodeId: string) => (await q<{ status: string }>(
  `SELECT i.status FROM ai_edit_suggestion_items i JOIN ai_edit_suggestions s ON s.id = i.suggestion_id WHERE s.node_id = $1 ORDER BY s.created_at, i.seq`, [nodeId])).rows.map((r) => r.status);

describe.skipIf(!enabled)("suggestions: who may settle them", () => {
  // AI-2: acceptSuggestionItems / rejectSuggestionItems check write rights only AFTER the "note moved to
  // another space" branch, and that branch settles the places as `void` for anyone who can READ the note
  // where it now is. A view-only member of the new space destroys the pending places for good (a final
  // status never changes), although they may not decide anything about the note.
  // Fix direction: assertAuthority(write_node) before the placeGone branch in both functions (the void is a
  // decision on the note like any other); 1 line each, plus the existing tests keep passing (they use the owner).
  it("a reader of the note's new space cannot void the places by rejecting or accepting", async () => {
    const w = await suggestWorld("voidreader");
    const base = doc("alpha", "beta");
    const nodeId = await w.note(base);
    const saved = await propose(w, nodeId, base, doc("ALPHA", "beta"));
    const viewer = await persistActor(w.ws, { id: "", name: `Viewer ${w.stamp}`, role: "viewer", type: "human" });
    const elsewhere = (await q<{ id: string }>(`INSERT INTO spaces (workspace_id, name, kind) VALUES ($1, 'elsewhere', 'shared') RETURNING id::text`, [w.ws])).rows[0]!.id;
    await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'edit'), ($1, $3, 'view')`, [elsewhere, w.owner.id, viewer.id]);
    await seedQ(`UPDATE content_nodes SET space_id = $2 WHERE id = $1`, [nodeId, elsewhere]);
    const refused = await rejection(rejectSuggestionItems(w.ws, { actor: viewer, suggestionId: saved.suggestionId!, itemIds: "all" }));
    expect(refused).toBeInstanceOf(AuthorityError);
    expect(await itemStatuses(nodeId)).toEqual(["pending"]);
  });

  // AI-5: "the agent's owner" is whoever issued one of its live resident tokens. `revoked_at IS NULL` is the
  // only liveness test, so a token that EXPIRED still makes its issuer the agent's owner.
  // Fix direction: add `AND (expires_at IS NULL OR expires_at > now())` to the query in mayDirect.
  it("a person whose only token for the agent has expired can no longer direct it", async () => {
    const w = await agentWorld("expiredowner");
    const member = await persistActor(w.ws, { id: "", name: `Member ${w.stamp}`, role: "editor", type: "human" });
    const token = await createToken(w.agent.id, { access: "write", issuedBy: member.id, expiresAt: new Date(Date.now() - 3600_000).toISOString() });
    expect(token.id).toBeTruthy();
    expect(await mayDirect(member, w.agent.id)).toBe(false);
  });
});

describe.skipIf(!enabled)("suggestions: a failed write leaves the earlier ones alone", () => {
  // The agent revises itself: a new set from the same session first marks its pending places for the same paragraph
  // `replaced`, then inserts the new ones. When the insert fails, the replace must roll back with it, or the person
  // is left with nothing to review.
  it("a revision that fails midway keeps the session's earlier pending places pending, and files no event", async () => {
    const w = await suggestWorld("failrevise");
    const base = doc("alpha", "beta");
    const nodeId = await w.note(base);
    const session = (await q<{ id: string }>(
      `INSERT INTO agent_sessions (workspace_id, agent_actor_id, initiator_id, node_id, space_id, anchor_block_id, prompt, deadline_at, status)
       VALUES ($1,$2,$3,$4,$5,'blk','p', now() + interval '1 hour', 'running') RETURNING id::text`, [w.ws, w.agent.id, w.owner.id, nodeId, w.space])).rows[0]!.id;
    await propose(w, nodeId, base, doc("ALPHA", "beta"), session);
    expect(await itemStatuses(nodeId)).toEqual(["pending"]);
    const eventsBefore = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM domain_events WHERE target_id = $1 AND event_type = 'AI_SUGGESTION_CREATED'`, [nodeId])).rows[0]!.n;

    // the Nth write fails: the item insert of the revision
    await seedQ(`CREATE OR REPLACE FUNCTION edges_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.new_text LIKE '%BOOM%' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`);
    await seedQ(`DROP TRIGGER IF EXISTS edges_boom_trg ON ai_edit_suggestion_items`);
    await seedQ(`CREATE TRIGGER edges_boom_trg BEFORE INSERT ON ai_edit_suggestion_items FOR EACH ROW EXECUTE FUNCTION edges_boom()`);
    try {
      const failed = await rejection(propose(w, nodeId, base, doc("BOOM", "beta"), session));
      expect(failed).not.toBeNull();
    } finally {
      await seedQ(`DROP TRIGGER IF EXISTS edges_boom_trg ON ai_edit_suggestion_items`);
    }
    expect(await itemStatuses(nodeId)).toEqual(["pending"]);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM domain_events WHERE target_id = $1 AND event_type = 'AI_SUGGESTION_CREATED'`, [nodeId])).rows[0]!.n).toBe(eventsBefore);
    // and the same proposal, retried after the fault is gone, lands once
    const retried = await propose(w, nodeId, base, doc("BOOM", "beta"), session);
    expect(retried).toMatchObject({ itemCount: 1, deduped: false });
    const listed = (await suggestionsForNode(w.ws, nodeId, { actor: w.owner }))!;
    expect(listed.suggestions.flatMap((s) => s.items.map((i) => i.new_text))).toEqual(["BOOM"]);
    // accepting what is left still works
    const only = listed.suggestions[0]!;
    expect((await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: only.id, itemIds: "all" })).accepted).toHaveLength(1);
  });
});

describe.skipIf(!enabled)("api sessions: stopping", () => {
  async function apiWorld(label: string) {
    const w = await agentWorld(label);
    const credential = await addCredential(w.ws, { label: "edges key", apiKey: KEY, baseUrl: fake.url, protocol: "v1_messages" }, { actor: w.owner });
    await q(`UPDATE agent_runners SET default_runtime = 'api', api_credential_id = $2, api_model = 'test-model', api_cap_choice = 'unlimited' WHERE actor_id = $1`, [w.agent.id, credential.id]);
    fake.state.models = [modelInfo("test-model")] as never;
    return w;
  }
  async function dispatchAndWait(session: AgentSession): Promise<AgentSession> {
    const row = (await q<{ id: string }>(`SELECT id::text FROM outbox WHERE effect_kind = 'agent_session_run' AND payload->>'session_id' = $1`, [session.id])).rows[0]!;
    await drainOutbox({ id: row.id });
    for (let i = 0; i < 200; i++) {
      const now = (await loadSession(session.id))!;
      if (["completed", "failed", "cancelled"].includes(now.status)) return now;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("session did not finish");
  }

  // AI-4: a session's deadline (timeout_seconds) is enforced by the token expiry and by the periodic
  // expireOverdue sweep, but assertMayContinue (run.ts), the check between paid calls, never looks at it.
  // Between two sweeps a session already past its deadline keeps paying for model turns (the tools it asks
  // for fail on the expired token, and the model sees that and may try again) up to MAX_TURNS.
  // Fix direction: `if (now.deadline_at <= new Date()) throw new Stop("timeout")` in assertMayContinue (+ the
  // same fail code expireOverdue writes). One line.
  it("a session past its deadline makes no further paid model call", async () => {
    const w = await apiWorld("deadline");
    const nodeId = await w.note(`@${w.handle} 看一下`);
    const { session } = await startSession(w.ws, { actor: w.owner, nodeId, target: { blockText: `@${w.handle} 看一下` } });
    fake.state.script.push(async () => {
      await seedQ(`UPDATE agent_sessions SET deadline_at = now() - interval '1 minute' WHERE id = $1`, [session.id]);
      return toolUseMessage("getNode", { id: nodeId });
    });
    fake.state.fallback = () => textMessage("還在花錢");
    await dispatchAndWait(session);
    expect(fake.requests.filter((r) => r.path.includes("messages"))).toHaveLength(1);
  });

  it("a session ended by someone else (cancelled) makes no further paid call", async () => {
    const w = await apiWorld("cancelmid");
    const nodeId = await w.note(`@${w.handle} 看一下`);
    const { session } = await startSession(w.ws, { actor: w.owner, nodeId, target: { blockText: `@${w.handle} 看一下` } });
    fake.state.script.push(async () => {
      await seedQ(`UPDATE agent_sessions SET status = 'cancelled' WHERE id = $1`, [session.id]);
      return toolUseMessage("getNode", { id: nodeId });
    });
    fake.state.fallback = () => textMessage("不該到這裡");
    await startApiRun(session.id);
    for (let i = 0; i < 100 && fake.requests.filter((r) => r.path.includes("messages")).length < 1; i++) await new Promise((r) => setTimeout(r, 25));
    await new Promise((r) => setTimeout(r, 300));
    expect(fake.requests.filter((r) => r.path.includes("messages"))).toHaveLength(1);
    expect((await loadSession(session.id))!.status).toBe("cancelled");
  });
});
