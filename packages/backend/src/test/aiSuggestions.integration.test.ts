// AI suggestions (docs/architecture/proposals/ai-collaboration-2026-10-27.md §3.2, §7.2;
// docs/agents/decisions-ai-collaboration.md): an agent set to suggest cannot
// write a note, its edit waits as pending places, and a person's accept is one
// bounded updateNode that never overwrites what they wrote since.
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, q } from "../db.js";
import type { ActorCtx } from "../types.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { AuthorityError } from "../spine/authority.js";
import { ScopeError } from "../spine/toolScope.js";
import { IdempotentReplay, withIdempotencyKey } from "../spine/mutate.js";
import { updateNode } from "../services/nodeUpdate.js";
import { createActor } from "../services/actors.js";
import {
  acceptSuggestionItems, createSuggestions, rejectSuggestionItems, suggestionsForNode,
} from "../services/aiSuggestions.js";
import { finish, insertReplyAsSuggestion, markDelivered, revertSession, startSession } from "../services/agentSessions.js";
import { updateNode as updateNodeTool } from "../services/agentTools/updateNode.js";
import { suggestEdit } from "../services/agentTools/suggestEdit.js";
import { commentOnNote } from "../services/agentTools/commentOnNote.js";
import { createNode as createNodeTool } from "../services/agentTools/createNode.js";
import { agentWorld, sessionActor } from "./helpers/agentSessionFixture.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
afterAll(async () => { await pool.end(); });

const doc = (...paragraphs: string[]) => paragraphs.join("\n\n") + "\n";

type World = Awaited<ReturnType<typeof agentWorld>>;

/** A world whose agent is set to suggest, with its resident token resolved as the server does. */
async function suggestWorld(label: string) {
  const w = await agentWorld(label);
  await q(`UPDATE actors SET write_mode = 'suggest' WHERE id = $1`, [w.agent.id]);
  const agent = await resolveCurrentActor({ id: w.agent.id, tokenScope: { tokenId: w.agent.tokenScope!.tokenId } }, w.ws);
  return { ...w, agent };
}

const noteBody = async (id: string) => (await q<{ markdown: string; title: string }>(`SELECT markdown, title FROM content_nodes WHERE id = $1`, [id])).rows[0]!;
const events = async (type: string, nodeId: string) =>
  (await q<{ id: string; actor_type: string; actor_id: string; payload: Record<string, unknown>; tx_meta: Record<string, unknown>; triggered_by_event_id: string | null }>(
    `SELECT id::text, actor_type, actor_id::text, payload, tx_meta, triggered_by_event_id::text FROM domain_events WHERE event_type = $1 AND target_id = $2 ORDER BY domain_events.id`,
    [type, nodeId])).rows;
const rejection = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

/** The agent proposes `proposed` for a note that currently reads `base`. */
async function propose(w: World & { agent: ActorCtx }, nodeId: string, base: string, proposed: string, extra: { sessionId?: string | null } = {}) {
  const saved = await createSuggestions(w.ws, {
    actor: w.agent, proposer: { agentActorId: w.agent.id, sessionId: extra.sessionId ?? null },
    nodeId, baseMarkdown: base, proposedMarkdown: proposed,
  });
  const listed = (await suggestionsForNode(w.ws, nodeId, { actor: w.owner }))!;
  return { saved, suggestion: listed.suggestions.find((s) => s.id === saved.suggestionId)! };
}

describe.skipIf(!isTestDb)("an agent set to suggest cannot write", () => {
  it("mutate refuses a direct note write whichever way it is asked", async () => {
    const w = await suggestWorld("gate");
    const nodeId = await w.note(doc("one", "two"));
    const direct = await rejection(updateNode(w.ws, nodeId, { markdown: "overwritten" }, { actor: w.agent, source: "agent" }));
    expect(direct).toBeInstanceOf(ScopeError);
    expect((await noteBody(nodeId)).markdown).toBe(doc("one", "two"));
    // a stale context that still claims apply is re-read under the lock: the agent's own setting wins
    const stale: ActorCtx = { ...w.agent, tokenScope: { ...w.agent.tokenScope!, writeMode: "apply" } };
    expect(await rejection(updateNode(w.ws, nodeId, { markdown: "overwritten" }, { actor: stale, source: "agent" }))).toBeInstanceOf(ScopeError);
    // an agent set to apply still writes (agents made before suggestions are unchanged)
    await q(`UPDATE actors SET write_mode = 'apply' WHERE id = $1`, [w.agent.id]);
    await updateNode(w.ws, nodeId, { markdown: "written" }, { actor: w.agent, source: "agent" });
    expect((await noteBody(nodeId)).markdown).toBe("written");
  });

  it("a new agent made through createActor starts in suggest mode", async () => {
    const w = await agentWorld("new");
    const created = await createActor(w.owner, async () => ({ name: `Fresh ${w.stamp}`, type: "agent" })) as { id: string };
    expect((await q<{ write_mode: string }>(`SELECT write_mode FROM actors WHERE id = $1`, [created.id])).rows[0]!.write_mode).toBe("suggest");
    const human = await createActor(w.owner, async () => ({ name: `Human ${w.stamp}`, type: "human", external_id: `ext-${randomUUID()}` })) as { id: string };
    expect((await q<{ write_mode: string }>(`SELECT write_mode FROM actors WHERE id = $1`, [human.id])).rows[0]!.write_mode).toBe("apply");
  });

  it("updateNode, suggestEdit and commentOnNote file suggestions and leave the note alone", async () => {
    const w = await suggestWorld("tools");
    const base = doc("# T", "alpha", "beta");
    const nodeId = await w.note(base);
    const ctx = { actor: w.agent, workspaceId: w.ws };
    const viaUpdate = await updateNodeTool.handler({ id: nodeId, markdown: doc("# T", "ALPHA", "beta"), base_markdown: base }, ctx);
    expect(viaUpdate).toMatchObject({ status: "suggested", places: 1 });
    const viaSuggest = await suggestEdit.handler({ id: nodeId, markdown: doc("# T", "alpha", "BETA"), base_markdown: base }, ctx);
    expect(viaSuggest).toMatchObject({ status: "suggested", places: 1 });
    expect(await commentOnNote.handler({ id: nodeId, text: "Is alpha right?", quote: "alpha" }, ctx)).toMatchObject({ status: "commented" });
    expect((await noteBody(nodeId)).markdown).toBe(base);
    const listed = (await suggestionsForNode(w.ws, nodeId, { actor: w.owner }))!;
    expect(listed.suggestions.flatMap((s) => s.items.map((i) => i.kind)).sort()).toEqual(["comment", "replace", "replace"]);
    expect(listed.canDecide).toBe(true);
    // the filing is the agent's event; no NODE_UPDATED exists
    const created = await events("AI_SUGGESTION_CREATED", nodeId);
    expect(created.length).toBe(3);
    expect(created.every((e) => e.actor_type === "ai_agent" && e.actor_id === w.agent.id)).toBe(true);
    expect((await events("NODE_UPDATED", nodeId)).filter((e) => e.actor_type === "ai_agent")).toEqual([]);
    // a tool the suggest rule cannot express says so instead of writing
    const refused = await rejection(createNodeTool.handler({ title: "new", parent_id: nodeId }, ctx));
    expect(refused).toBeInstanceOf(ScopeError);
  });

  it("an agent that may only read the space cannot suggest either (nothing saved, no event)", async () => {
    const w = await suggestWorld("readonly");
    const nodeId = await w.note(doc("a", "b"));
    await q(`UPDATE space_members SET permission = 'view' WHERE actor_id = $1 AND space_id = $2`, [w.agent.id, w.space]);
    const err = await rejection(createSuggestions(w.ws, {
      actor: w.agent, proposer: { agentActorId: w.agent.id, sessionId: null }, nodeId, proposedMarkdown: doc("a", "B"),
    }));
    expect(err).toBeInstanceOf(AuthorityError);
    expect((await q(`SELECT 1 FROM ai_edit_suggestions WHERE node_id = $1`, [nodeId])).rows).toEqual([]);
    expect(await events("AI_SUGGESTION_CREATED", nodeId)).toEqual([]);
  });
});

describe.skipIf(!isTestDb)("creating suggestions", () => {
  it("a retried call is the same set; an unchanged text saves nothing", async () => {
    const w = await suggestWorld("retry");
    const base = doc("a", "b");
    const nodeId = await w.note(base);
    const first = await propose(w, nodeId, base, doc("a", "B"));
    const again = await createSuggestions(w.ws, { actor: w.agent, proposer: { agentActorId: w.agent.id, sessionId: null }, nodeId, baseMarkdown: base, proposedMarkdown: doc("a", "B") });
    expect(again).toMatchObject({ suggestionId: first.saved.suggestionId, deduped: true });
    expect((await q(`SELECT 1 FROM ai_edit_suggestions WHERE node_id = $1`, [nodeId])).rows.length).toBe(1);
    expect(await events("AI_SUGGESTION_CREATED", nodeId)).toHaveLength(1);
    const none = await createSuggestions(w.ws, { actor: w.agent, proposer: { agentActorId: w.agent.id, sessionId: null }, nodeId, baseMarkdown: base, proposedMarkdown: base });
    expect(none).toEqual({ suggestionId: null, itemCount: 0, deduped: false });
  });

  it("a revised set from the same session replaces that session's pending places", async () => {
    const w = await suggestWorld("replace");
    const base = doc("a", "b");
    const nodeId = await w.note(base);
    const session = (await startSession(w.ws, { actor: w.owner, nodeId: await w.note(`@${w.handle} hi`), target: { blockText: `@${w.handle} hi` } })).session;
    const one = await propose(w, nodeId, base, doc("a", "B1"), { sessionId: session.id });
    const two = await propose(w, nodeId, base, doc("a", "B2"), { sessionId: session.id });
    const status = async (id: string) => (await q<{ status: string }>(`SELECT status FROM ai_edit_suggestion_items WHERE suggestion_id = $1`, [id])).rows.map((r) => r.status);
    expect(await status(one.saved.suggestionId!)).toEqual(["replaced"]);
    expect(await status(two.saved.suggestionId!)).toEqual(["pending"]);
    const listed = (await suggestionsForNode(w.ws, nodeId, { actor: w.owner }))!;
    expect(listed.suggestions.map((s) => s.id)).toEqual([two.saved.suggestionId]);
  });
});

describe.skipIf(!isTestDb)("a session's later suggestions do not hide its earlier ones", () => {
  async function sessionOf(w: Awaited<ReturnType<typeof suggestWorld>>) {
    return (await startSession(w.ws, { actor: w.owner, nodeId: await w.note(`@${w.handle} hi`), target: { blockText: `@${w.handle} hi` } })).session;
  }
  const shown = async (w: Awaited<ReturnType<typeof suggestWorld>>, nodeId: string) =>
    (await suggestionsForNode(w.ws, nodeId, { actor: w.owner }))!.suggestions.flatMap((s) => s.items.map((i) => `${i.kind}:${i.new_text}`));
  const comment = (w: Awaited<ReturnType<typeof suggestWorld>>, nodeId: string, sessionId: string, text: string) =>
    createSuggestions(w.ws, { actor: w.agent, proposer: { agentActorId: w.agent.id, sessionId }, nodeId, comments: [{ text }] });

  it("two comments in one session are both shown", async () => {
    const w = await suggestWorld("two-comments");
    const nodeId = await w.note(doc("a", "b"));
    const session = await sessionOf(w);
    await comment(w, nodeId, session.id, "first");
    await comment(w, nodeId, session.id, "second");
    expect((await shown(w, nodeId)).sort()).toEqual(["comment:first", "comment:second"]);
  });

  it("a comment then an edit: the comment stays", async () => {
    const w = await suggestWorld("comment-edit");
    const base = doc("a", "b");
    const nodeId = await w.note(base);
    const session = await sessionOf(w);
    await comment(w, nodeId, session.id, "look here");
    await propose(w, nodeId, base, doc("a", "B"), { sessionId: session.id });
    expect(await shown(w, nodeId)).toContain("comment:look here");
    expect((await shown(w, nodeId)).filter((x) => x.startsWith("replace:"))).toHaveLength(1);
  });

  it("edits to two different paragraphs from the same base are both shown", async () => {
    const w = await suggestWorld("two-places");
    const base = doc("a", "b");
    const nodeId = await w.note(base);
    const session = await sessionOf(w);
    await propose(w, nodeId, base, doc("A", "b"), { sessionId: session.id });
    await propose(w, nodeId, base, doc("a", "B"), { sessionId: session.id });
    const listed = (await suggestionsForNode(w.ws, nodeId, { actor: w.owner }))!;
    expect(listed.suggestions.flatMap((s) => s.items.map((i) => i.base_text)).sort()).toEqual(["a", "b"]);
  });

  it("a revision of the same paragraph still replaces the earlier one, and leaves a comment alone", async () => {
    const w = await suggestWorld("same-place");
    const base = doc("a", "b");
    const nodeId = await w.note(base);
    const session = await sessionOf(w);
    await comment(w, nodeId, session.id, "note to self");
    const one = await propose(w, nodeId, base, doc("a", "B1"), { sessionId: session.id });
    const two = await propose(w, nodeId, base, doc("a", "B2"), { sessionId: session.id });
    const statusOf = async (id: string) => (await q<{ status: string }>(`SELECT status FROM ai_edit_suggestion_items WHERE suggestion_id = $1`, [id])).rows.map((r) => r.status);
    expect(await statusOf(one.saved.suggestionId!)).toEqual(["replaced"]);
    expect(await statusOf(two.saved.suggestionId!)).toEqual(["pending"]);
    expect(await shown(w, nodeId)).toContain("comment:note to self");
  });
});

describe.skipIf(!isTestDb)("accepting", () => {
  it("applies every place as one save by the person, tied to the agent, and is final", async () => {
    const w = await suggestWorld("accept");
    const base = doc("# T", "alpha", "beta", "gamma");
    const nodeId = await w.note(base);
    const { suggestion } = await propose(w, nodeId, base, doc("# T", "ALPHA", "beta", "GAMMA", "delta"));
    expect(suggestion.items.length).toBe(3);
    const result = await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: "all" });
    expect(result.accepted.length).toBe(3);
    expect(result).toMatchObject({ stale: [], void: [], alreadyDecided: [] });
    expect((await noteBody(nodeId)).markdown).toBe(doc("# T", "ALPHA", "beta", "GAMMA", "delta"));

    const saves = (await events("NODE_UPDATED", nodeId)).filter((e) => e.tx_meta.ui_context === "ai.suggestion.accept");
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ actor_type: "user", actor_id: w.owner.id });
    expect(saves[0]!.tx_meta.suggested_by).toEqual({ actor_id: w.agent.id, session_id: null });
    const accepted = await events("AI_SUGGESTION_ACCEPTED", nodeId);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ actor_type: "user", triggered_by_event_id: saves[0]!.id });
    expect(accepted[0]!.payload).toMatchObject({ proposed_by_actor_id: w.agent.id });
    expect((accepted[0]!.payload.item_ids as string[]).length).toBe(3);

    // deciding again changes nothing (a second device, a double click)
    const again = await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: "all" });
    expect(again).toMatchObject({ accepted: [], alreadyDecided: expect.any(Array) });
    expect(again.alreadyDecided.length).toBe(3);
    expect(await events("AI_SUGGESTION_ACCEPTED", nodeId)).toHaveLength(1);
  });

  it("a paragraph the AI rewrote keeps its anchor: the same id still points at it", async () => {
    const w = await suggestWorld("blockid");
    const base = doc("alpha {mark}", "beta");
    const nodeId = await w.note(base);
    const anchorOf = async () => (await q<{ anchor_id: string; status: string; quote: string }>(
      `SELECT anchor_id, status, quote FROM block_anchors WHERE note_id = $1 AND quote LIKE 'alpha%' OR note_id = $1 AND quote LIKE 'ALPHA%'`, [nodeId])).rows;
    const [before] = await anchorOf();
    expect(before).toMatchObject({ status: "valid" });
    const { suggestion } = await propose(w, nodeId, base, doc("ALPHA {mark}", "beta"));
    await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: "all" });
    expect((await noteBody(nodeId)).markdown).toContain("ALPHA {mark}");
    const after = await anchorOf();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ anchor_id: before!.anchor_id, status: "valid", quote: "ALPHA {mark}" });
  });

  it("accepts just the chosen place", async () => {
    const w = await suggestWorld("one");
    const base = doc("alpha", "beta");
    const nodeId = await w.note(base);
    const { suggestion } = await propose(w, nodeId, base, doc("ALPHA", "BETA"));
    const second = suggestion.items[1]!;
    const r = await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: [second.id] });
    expect(r.accepted).toEqual([second.id]);
    expect((await noteBody(nodeId)).markdown).toBe(doc("alpha", "BETA"));
    const listed = (await suggestionsForNode(w.ws, nodeId, { actor: w.owner }))!;
    expect(listed.suggestions[0]!.items.map((i) => i.id)).toEqual([suggestion.items[0]!.id]);
  });

  it("keeps what the person wrote elsewhere in the note since the agent read it", async () => {
    const w = await suggestWorld("merge");
    const base = doc("alpha", "beta", "gamma");
    const nodeId = await w.note(base);
    const { suggestion } = await propose(w, nodeId, base, doc("alpha", "beta", "GAMMA"));
    await updateNode(w.ws, nodeId, { markdown: doc("ALPHA by me", "beta", "gamma") }, { actor: w.owner });
    const r = await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: "all" });
    expect(r.accepted.length).toBe(1);
    expect((await noteBody(nodeId)).markdown).toBe(doc("ALPHA by me", "beta", "GAMMA"));
  });

  it("a place the person changed too is stale: nothing written for it, the others land", async () => {
    const w = await suggestWorld("stale");
    const base = doc("alpha", "beta", "gamma");
    const nodeId = await w.note(base);
    const { suggestion } = await propose(w, nodeId, base, doc("ALPHA", "beta", "GAMMA"));
    await updateNode(w.ws, nodeId, { markdown: doc("alpha", "beta", "gamma, my words") }, { actor: w.owner });
    const r = await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: "all" });
    const [alphaItem, gammaItem] = suggestion.items;
    expect(r.accepted).toEqual([alphaItem!.id]);
    expect(r.stale).toEqual([gammaItem!.id]);
    expect((await noteBody(nodeId)).markdown).toBe(doc("ALPHA", "beta", "gamma, my words"));
    // the stale place is still listed (to say so) and cannot be accepted later
    const listed = (await suggestionsForNode(w.ws, nodeId, { actor: w.owner }))!;
    expect(listed.suggestions[0]!.items).toEqual([expect.objectContaining({ id: gammaItem!.id, status: "stale" })]);
    const retry = await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: [gammaItem!.id] });
    expect(retry).toMatchObject({ accepted: [], alreadyDecided: [gammaItem!.id] });
  });

  it("two suggestions for the same paragraph: the second goes stale after the first lands", async () => {
    const w = await suggestWorld("overlap");
    const base = doc("alpha", "beta");
    const nodeId = await w.note(base);
    const a = await propose(w, nodeId, base, doc("ALPHA one", "beta"));
    const b = await propose(w, nodeId, base, doc("ALPHA two", "beta"));
    expect((await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: a.suggestion.id, itemIds: "all" })).accepted.length).toBe(1);
    const second = await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: b.suggestion.id, itemIds: "all" });
    expect(second.stale.length).toBe(1);
    expect((await noteBody(nodeId)).markdown).toBe(doc("ALPHA one", "beta"));
  });

  it("a title suggestion renames only while the title is as the agent saw it", async () => {
    const w = await suggestWorld("title");
    const nodeId = await w.note(doc("body"));
    const before = (await noteBody(nodeId)).title;
    const saved = await createSuggestions(w.ws, { actor: w.agent, proposer: { agentActorId: w.agent.id, sessionId: null }, nodeId, proposedTitle: `${before} v2` });
    const r = await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: saved.suggestionId!, itemIds: "all" });
    expect(r.accepted.length).toBe(1);
    expect((await noteBody(nodeId)).title).toBe(`${before} v2`);
    const other = await w.note(doc("body"));
    const t2 = (await noteBody(other)).title;
    const s2 = await createSuggestions(w.ws, { actor: w.agent, proposer: { agentActorId: w.agent.id, sessionId: null }, nodeId: other, proposedTitle: `${t2} v2` });
    await updateNode(w.ws, other, { title: `${t2} mine` }, { actor: w.owner });
    expect((await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: s2.suggestionId!, itemIds: "all" })).stale.length).toBe(1);
    expect((await noteBody(other)).title).toBe(`${t2} mine`);
  });

  it("a comment accepted is only marked read: the note is not written", async () => {
    const w = await suggestWorld("comment");
    const nodeId = await w.note(doc("alpha"));
    const saved = await createSuggestions(w.ws, { actor: w.agent, proposer: { agentActorId: w.agent.id, sessionId: null }, nodeId, comments: [{ text: "check this", anchorText: "alpha" }] });
    const r = await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: saved.suggestionId!, itemIds: "all" });
    expect(r.accepted.length).toBe(1);
    expect((await events("NODE_UPDATED", nodeId)).filter((e) => e.tx_meta.ui_context === "ai.suggestion.accept")).toEqual([]);
    expect(await events("AI_SUGGESTION_ACCEPTED", nodeId)).toHaveLength(1);
  });

  it("uses the person's rights at the moment of accepting: a reader cannot, nothing is touched", async () => {
    const w = await suggestWorld("rights");
    const base = doc("alpha", "beta");
    const nodeId = await w.note(base);
    const { suggestion } = await propose(w, nodeId, base, doc("ALPHA", "beta"));
    const reader = await persistActor(w.ws, { id: "", name: `Reader ${w.stamp}`, role: "viewer", type: "human" });
    await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'view')`, [w.space, reader.id]);
    // can read and list, cannot decide
    expect((await suggestionsForNode(w.ws, nodeId, { actor: reader }))).toMatchObject({ canDecide: false });
    expect(await rejection(acceptSuggestionItems(w.ws, { actor: reader, suggestionId: suggestion.id, itemIds: "all" }))).toBeInstanceOf(AuthorityError);
    expect(await rejection(rejectSuggestionItems(w.ws, { actor: reader, suggestionId: suggestion.id, itemIds: "all" }))).toBeInstanceOf(AuthorityError);
    // an editor demoted after the agent proposed loses the right too
    const editor = await persistActor(w.ws, { id: "", name: `Editor ${w.stamp}`, role: "editor", type: "human" });
    await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'edit')`, [w.space, editor.id]);
    await q(`UPDATE space_members SET permission = 'view' WHERE space_id = $1 AND actor_id = $2`, [w.space, editor.id]);
    expect(await rejection(acceptSuggestionItems(w.ws, { actor: editor, suggestionId: suggestion.id, itemIds: "all" }))).toBeInstanceOf(AuthorityError);
    expect((await noteBody(nodeId)).markdown).toBe(base);
    expect((await suggestionsForNode(w.ws, nodeId, { actor: w.owner }))!.suggestions[0]!.items[0]!.status).toBe("pending");
    // a person who cannot read the note does not learn the suggestion exists
    const outsider = await persistActor(w.ws, { id: "", name: `Out ${w.stamp}`, role: "editor", type: "human" });
    await q(`DELETE FROM space_members WHERE actor_id = $1 AND space_id = $2`, [outsider.id, w.space]);
    expect(await suggestionsForNode(w.ws, nodeId, { actor: outsider })).toBeNull();
    expect(await rejection(acceptSuggestionItems(w.ws, { actor: outsider, suggestionId: suggestion.id, itemIds: "all" }))).toMatchObject({ code: "not_found" });
  });

  it("still works when the agent has since been switched to apply or lost the space (the person's rights decide)", async () => {
    const w = await suggestWorld("agentgone");
    const base = doc("alpha", "beta");
    const nodeId = await w.note(base);
    const { suggestion } = await propose(w, nodeId, base, doc("ALPHA", "beta"));
    await q(`DELETE FROM space_members WHERE actor_id = $1 AND space_id = $2`, [w.agent.id, w.space]);
    const r = await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: "all" });
    expect(r.accepted.length).toBe(1);
  });

  it("a note moved to another space makes the places void; a trashed note hides them until restored", async () => {
    const w = await suggestWorld("void");
    const base = doc("alpha", "beta");
    const moved = await w.note(base);
    const trashed = await w.note(base);
    const a = await propose(w, moved, base, doc("ALPHA", "beta"));
    const b = await propose(w, moved, base, doc("alpha", "BETA"));
    const c = await propose(w, trashed, base, doc("ALPHA", "beta"));
    const other = (await q<{ id: string }>(`INSERT INTO spaces (workspace_id, name, kind) VALUES ($1, 'elsewhere', 'shared') RETURNING id::text`, [w.ws])).rows[0]!.id;
    await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'edit')`, [other, w.owner.id]);
    await seedQ(`UPDATE content_nodes SET space_id = $2 WHERE id = $1`, [moved, other]);
    expect(await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: a.suggestion.id, itemIds: "all" })).toMatchObject({ accepted: [], void: [a.suggestion.items[0]!.id] });
    expect(await rejectSuggestionItems(w.ws, { actor: w.owner, suggestionId: b.suggestion.id, itemIds: "all" })).toMatchObject({ rejected: [], void: [b.suggestion.items[0]!.id] });
    expect((await noteBody(moved)).markdown).toBe(base);
    expect((await suggestionsForNode(w.ws, moved, { actor: w.owner }))!.suggestions).toEqual([]);

    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [trashed]);
    expect(await suggestionsForNode(w.ws, trashed, { actor: w.owner })).toBeNull();
    expect(await rejection(acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: c.suggestion.id, itemIds: "all" }))).toMatchObject({ code: "not_found" });
    await seedQ(`UPDATE content_nodes SET deleted_at = NULL WHERE id = $1`, [trashed]);
    expect((await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: c.suggestion.id, itemIds: "all" })).accepted.length).toBe(1);
  });

  it("two devices accepting at once: one save, the other is told it was decided", async () => {
    const w = await suggestWorld("race");
    const base = doc("alpha", "beta");
    const nodeId = await w.note(base);
    const { suggestion } = await propose(w, nodeId, base, doc("ALPHA", "BETA"));
    const results = await Promise.all(Array.from({ length: 6 }, () =>
      acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: "all" })));
    expect(results.filter((r) => r.accepted.length === 2)).toHaveLength(1);
    expect(results.filter((r) => r.alreadyDecided.length === 2)).toHaveLength(5);
    expect((await events("NODE_UPDATED", nodeId)).filter((e) => e.tx_meta.ui_context === "ai.suggestion.accept")).toHaveLength(1);
    expect(await events("AI_SUGGESTION_ACCEPTED", nodeId)).toHaveLength(1);
  });

  it("a retried request with the same key is acknowledged once, not saved twice", async () => {
    const w = await suggestWorld("key");
    const base = doc("alpha", "beta");
    const nodeId = await w.note(base);
    const { suggestion } = await propose(w, nodeId, base, doc("ALPHA", "beta"));
    const key = randomUUID();
    await withIdempotencyKey(key, () => acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: "all" }));
    // the retry finds the places decided: it says so (the client treats that as done) and saves nothing
    const replay = await withIdempotencyKey(key, () => acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: "all" }));
    expect(replay).toMatchObject({ accepted: [], alreadyDecided: [suggestion.items[0]!.id] });
    // a different request reusing a committed key is the spine's replay refusal
    const other = await propose(w, nodeId, base, doc("alpha", "BETA"));
    expect(await rejection(withIdempotencyKey(key, () => acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: other.suggestion.id, itemIds: "all" })))).toBeInstanceOf(IdempotentReplay);
    expect((await events("NODE_UPDATED", nodeId)).filter((e) => e.tx_meta.ui_context === "ai.suggestion.accept")).toHaveLength(1);
  });

  it("a failed save leaves no half decision: the state and the events roll back together", async () => {
    const w = await suggestWorld("rollback");
    const base = doc("alpha", "beta");
    const nodeId = await w.note(base);
    const { suggestion } = await propose(w, nodeId, base, doc("ALPHA", "beta"));
    // the first save lands, then the accept fails on something that is not a merge conflict:
    // an exclusion trigger stands in for "storage failed after the first write".
    await q(`CREATE OR REPLACE FUNCTION ai_suggestion_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'storage failed'; END $$`);
    await q(`CREATE TRIGGER ai_suggestion_test_fail BEFORE UPDATE ON ai_edit_suggestion_items FOR EACH ROW WHEN (NEW.status = 'accepted' AND NEW.suggestion_id = '${suggestion.id}') EXECUTE FUNCTION ai_suggestion_test_fail()`);
    try {
      const err = await rejection(acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: "all" }));
      expect(String((err as Error)?.message)).toContain("storage failed");
    } finally {
      await q(`DROP TRIGGER ai_suggestion_test_fail ON ai_edit_suggestion_items`);
    }
    expect((await noteBody(nodeId)).markdown).toBe(base);
    expect((await events("NODE_UPDATED", nodeId)).filter((e) => e.tx_meta.ui_context === "ai.suggestion.accept")).toEqual([]);
    expect(await events("AI_SUGGESTION_ACCEPTED", nodeId)).toEqual([]);
    expect((await suggestionsForNode(w.ws, nodeId, { actor: w.owner }))!.suggestions[0]!.items[0]!.status).toBe("pending");
    // and the same accept succeeds afterwards: the failure left nothing that swallows a valid retry
    expect((await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: "all" })).accepted.length).toBe(1);
  });
});

describe.skipIf(!isTestDb)("rejecting", () => {
  it("writes nothing to the note, records who turned it down, and is final", async () => {
    const w = await suggestWorld("reject");
    const base = doc("alpha", "beta");
    const nodeId = await w.note(base);
    const { suggestion } = await propose(w, nodeId, base, doc("ALPHA", "BETA"));
    const first = suggestion.items[0]!;
    const r = await rejectSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: [first.id] });
    expect(r).toMatchObject({ rejected: [first.id], alreadyDecided: [] });
    expect((await noteBody(nodeId)).markdown).toBe(base);
    const evs = await events("AI_SUGGESTION_REJECTED", nodeId);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ actor_type: "user", actor_id: w.owner.id });
    // a rejected place cannot be accepted afterwards
    expect(await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestion.id, itemIds: [first.id] })).toMatchObject({ accepted: [], alreadyDecided: [first.id] });
    expect((await noteBody(nodeId)).markdown).toBe(base);
  });
});

describe.skipIf(!isTestDb)("an @ai session of an agent set to suggest", () => {
  async function runningSession(w: World & { agent: ActorCtx }, noteMarkdown: string) {
    const nodeId = await w.note(noteMarkdown);
    const { session } = await startSession(w.ws, { actor: w.owner, nodeId, target: { blockText: noteMarkdown.split("\n")[0]! } });
    const delivered = (await markDelivered(session.id, w.agent.tokenScope!.tokenId))!;
    return { nodeId, session: delivered, runner: await sessionActor(delivered, w.agent) };
  }

  it("keeps its reply on the session; inserting it is one suggestion, accepted like any other", async () => {
    const w = await suggestWorld("reply");
    const { nodeId, session, runner } = await runningSession(w, `@${w.handle} what is two plus two?\n\nlater`);
    expect(runner.tokenScope!.writeMode).toBe("suggest");
    const before = (await noteBody(nodeId)).markdown;
    const done = await finish(session.id, { actor: runner, status: "completed", markdown: "Four." });
    expect(done.session).toMatchObject({ status: "completed", reply_markdown: "Four.", reply_event_id: null });
    expect((await noteBody(nodeId)).markdown).toBe(before);

    const { suggestionId } = await insertReplyAsSuggestion(session.id, { actor: w.owner });
    expect(suggestionId).toBeTruthy();
    expect((await noteBody(nodeId)).markdown).toBe(before);
    expect((await insertReplyAsSuggestion(session.id, { actor: w.owner })).suggestionId).toBe(suggestionId); // double click
    const listed = (await suggestionsForNode(w.ws, nodeId, { actor: w.owner }))!;
    expect(listed.suggestions[0]!.items.map((i) => i.kind)).toEqual(["insert"]);
    expect((await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestionId!, itemIds: "all" })).accepted.length).toBe(1);
    const after = (await noteBody(nodeId)).markdown;
    expect(after).toContain("> Four.");
    expect(after.indexOf("> Four.")).toBeGreaterThan(after.indexOf("what is two plus two"));
    expect(after.indexOf("> Four.")).toBeLessThan(after.indexOf("later"));
  });

  // 回覆是否「已在筆記裡」看回覆區塊的錨點：經建議接受寫進筆記的回覆，接受時就替它建了同一個錨點。
  it("once the reply is in the note there is nothing left to insert", async () => {
    const w = await suggestWorld("reply2");
    const { session, runner } = await runningSession(w, `@${w.handle} what is two plus two?\n\nlater`);
    await finish(session.id, { actor: runner, status: "completed", markdown: "Four." });
    const { suggestionId } = await insertReplyAsSuggestion(session.id, { actor: w.owner });
    await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: suggestionId!, itemIds: "all" });
    expect((await insertReplyAsSuggestion(session.id, { actor: w.owner })).suggestionId).toBeNull();
  });

  it("revertSession rejects what is pending and takes back what was accepted, keeping later edits", async () => {
    const w = await suggestWorld("revert");
    const { nodeId, session, runner } = await runningSession(w, `@${w.handle} tidy\n\nalpha\n\nbeta`);
    const base = (await noteBody(nodeId)).markdown;
    const ctx = { actor: runner, workspaceId: w.ws };
    await updateNodeTool.handler({ id: nodeId, markdown: base.replace("alpha", "ALPHA"), base_markdown: base }, ctx);
    const first = (await suggestionsForNode(w.ws, nodeId, { actor: w.owner }))!.suggestions[0]!;
    expect((await acceptSuggestionItems(w.ws, { actor: w.owner, suggestionId: first.id, itemIds: "all" })).accepted.length).toBe(1);
    const afterAccept = (await noteBody(nodeId)).markdown;
    await updateNodeTool.handler({ id: nodeId, markdown: afterAccept.replace("beta", "BETA"), base_markdown: afterAccept }, ctx);
    await updateNode(w.ws, nodeId, { markdown: (await noteBody(nodeId)).markdown + "\nmy own line\n" }, { actor: w.owner });
    await finish(session.id, { actor: runner, status: "completed", markdown: "done" });

    const reverted = await revertSession(session.id, { actor: w.owner });
    expect(reverted.reverted).toBeGreaterThanOrEqual(1);
    const body = (await noteBody(nodeId)).markdown;
    expect(body).toContain("alpha");
    expect(body).not.toContain("ALPHA");
    expect(body).toContain("my own line");
    const listed = (await suggestionsForNode(w.ws, nodeId, { actor: w.owner }))!;
    expect(listed.suggestions).toEqual([]); // the pending place was turned down
    expect((await events("AI_SUGGESTION_REJECTED", nodeId)).length).toBe(1);
  });
});
