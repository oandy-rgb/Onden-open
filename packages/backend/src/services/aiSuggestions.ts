// AI suggestions: an agent's edit to a note, kept pending until a person
// accepts or rejects each place (docs/architecture/proposals/ai-collaboration-2026-10-27.md §3.2;
// decisions: docs/agents/decisions-ai-collaboration.md).
//
//   createSuggestions       the agent (or a person filing its reply) proposes;
//                           nothing in the note changes. One call = one set of
//                           items (replace / insert / delete / title / comment).
//   acceptSuggestionItems   a person applies the chosen items as ONE
//                           updateNode against the note as it is now.
//   rejectSuggestionItems   a person turns them down; the note is untouched.
//   suggestionsForNode      what the editor draws.
//
// Accepting is a bounded updateNode, never a second write path: the chosen
// items are applied to the text the agent read (base_markdown) and three-way
// merged against the note today with onConflict "refuse", so a person's later
// edits survive and a place they changed too is `stale` (nothing written,
// said so) rather than overwritten. The writer is the person accepting, under
// their CURRENT rights; the agent only appears as tx_meta.suggested_by, which
// History uses to count accepted places as part of the AI's run.
//
// Item status moves only through a guarded UPDATE … WHERE status = 'pending'
// under the workspace event lock; a final status never changes. Failed
// attempts are not events: only a committed accept or reject is.
//
//   createSuggestions(ws, { actor: agent, proposer, nodeId, baseMarkdown, proposedMarkdown })
//   acceptSuggestionItems(ws, { actor: person, suggestionId, itemIds: "all" })
//     → { accepted, stale, void, alreadyDecided }  // stale: "this place changed, nothing written"

import { randomUUID } from "node:crypto";
import { cutToUnits, findParagraph, pairParagraphs, paragraphOccurrence, splitParagraphs } from "@onden/markdown";
import { q, withSavepoint } from "../db.js";
import { db } from "../dbKysely.js";
import type { ActorCtx } from "../types.js";
import { mutate } from "../spine/mutate.js";
import { assertAuthority, carriedActorId } from "../spine/authority.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { withIdempotencyClaim } from "../spine/idempotency.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { CodedStatusError } from "../statusError.js";
import { sha256Hex } from "../utils.js";
import { canReadNode } from "./readPolicy.js";
import { BodyConflictError, updateNode } from "./nodeUpdate.js";
import { replyAnchorFor } from "./agentReplyBlock.js";
import {
  applyItems, decodeUnit, MAX_ITEMS, proposeItems, type ItemChange, type ItemDraft,
} from "./aiSuggestionBlocks.js";
import type { NoteSuggestion, SuggestionItem, SuggestionItemKind, SuggestionItemStatus } from "@onden/contract";
import { liveNodeSql } from "../spine/nodeSql.js";

/** Items still worth showing: undecided, or stale (the person is told the place changed). */
const LISTED: readonly SuggestionItemStatus[] = ["pending", "stale"];
export const OLDER_AFTER_DAYS = 30;
export const COMMENT_MAX = 2_000;

const refuse = (status: 400 | 404 | 409, code: string, message: string) => new CodedStatusError(status, code, message);

type NodeRow = { id: string; space_id: string; markdown: string; title: string };

async function liveNode(workspaceId: string, nodeId: string, lock: boolean): Promise<NodeRow | null> {
  return (await q<NodeRow>(
    `SELECT id::text, space_id::text, markdown, title FROM content_nodes
      WHERE workspace_id = $1 AND id = $2 AND ${liveNodeSql()}${lock ? " FOR UPDATE" : ""}`, [workspaceId, nodeId])).rows[0] ?? null;
}

// ── proposing ───────────────────────────────────────────────────────────────

export type CreateInput = {
  /** Who files it: the agent (a tool call), or a person filing the agent's reply. */
  actor: ActorCtx;
  /** The agent the suggestion is from and the session it ran in (null: a resident token, no session). */
  proposer: { agentActorId: string; sessionId: string | null };
  nodeId: string;
  /** The body the agent read: where its proposal starts from. Defaults to the note now. */
  baseMarkdown?: string;
  baseTitle?: string;
  proposedMarkdown?: string;
  proposedTitle?: string;
  /** Notes that change nothing: `anchorText` is the paragraph they are about. */
  comments?: Array<{ text: string; anchorText?: string }>;
};

export type CreateResult = { suggestionId: string | null; itemCount: number; deduped: boolean };

/** Save an agent's proposal as pending items. Needs write rights on the note
 *  (an agent that may only read can neither edit nor suggest). A proposal that
 *  changes nothing saves nothing (suggestionId null). Sent again unchanged
 *  (a retried tool call) it returns the set already there. A new set from the
 *  same session for the same note replaces that session's still-pending items:
 *  the agent revising itself, not piling up. Refused 404 (no such note),
 *  400 (a proposal too large to review place by place, or too many places). */
export async function createSuggestions(workspaceId: string, input: CreateInput): Promise<CreateResult> {
  return withIdempotencyClaim(workspaceId, (claim) => withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(input.actor, workspaceId);
    const note = await liveNode(workspaceId, input.nodeId, true);
    if (!note) throw refuse(404, "not_found", "note not found");
    const authority = { kind: "node", nodeId: input.nodeId, op: "write_node" } as const;
    await assertAuthority(actor, authority);

    const baseMarkdown = input.baseMarkdown ?? note.markdown;
    const baseTitle = input.baseTitle ?? note.title;
    // A change too large to cut into places throws SuggestionTooLargeError (a 400).
    const drafts: ItemDraft[] = input.proposedMarkdown !== undefined ? proposeItems(baseMarkdown, input.proposedMarkdown) : [];
    const items: Array<{ kind: SuggestionItemKind; baseText: string; baseOccurrence: number; newText: string | null }> = drafts.map((d) => ({
      kind: d.kind, baseText: d.baseText, baseOccurrence: d.baseOccurrence, newText: d.kind === "delete" ? null : d.newText,
    }));
    if (input.proposedTitle !== undefined && input.proposedTitle !== baseTitle) {
      items.push({ kind: "title", baseText: baseTitle, baseOccurrence: 0, newText: input.proposedTitle });
    }
    for (const c of input.comments ?? []) {
      const text = c.text.trim();
      if (text) items.push({ kind: "comment", baseText: c.anchorText ?? "", baseOccurrence: 0, newText: cutToUnits(text, COMMENT_MAX) });
    }
    if (items.length === 0) return { suggestionId: null, itemCount: 0, deduped: false };
    if (items.length > MAX_ITEMS) throw refuse(400, "suggestion_too_large", `more than ${MAX_ITEMS} places to review`);

    const { agentActorId, sessionId } = input.proposer;
    const proposalHash = sha256Hex(JSON.stringify([baseMarkdown, baseTitle, items]));
    const same = await q<{ id: string }>(
      `SELECT s.id::text FROM ai_edit_suggestions s
        WHERE s.node_id = $1 AND s.agent_actor_id = $2 AND s.session_id IS NOT DISTINCT FROM $3::uuid AND s.proposal_hash = $4
          AND EXISTS (SELECT 1 FROM ai_edit_suggestion_items i WHERE i.suggestion_id = s.id AND i.status = 'pending')
        ORDER BY s.created_at DESC LIMIT 1`,
      [input.nodeId, agentActorId, sessionId, proposalHash]);
    if (same.rows[0]) return { suggestionId: same.rows[0].id, itemCount: items.length, deduped: true };

    await claim();
    const suggestionId = randomUUID();
    const kinds: Record<string, number> = {};
    for (const item of items) kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;
    await mutate({
      actor, workspaceId, authority,
      event: {
        type: "AI_SUGGESTION_CREATED", targetType: "node", targetId: input.nodeId,
        payload: { suggestion_id: suggestionId, agent_actor_id: agentActorId, ...(sessionId ? { session_id: sessionId } : {}), item_count: items.length, kinds },
        txMeta: { ui_context: "ai.suggestion.create" },
      },
      apply: async ({ eventId }) => {
        // The session revising itself: its still-pending replace / insert / delete / title items about the same
        // place as a new item (same kind of place, base text and occurrence) become `replaced`. Other places stay
        // pending, and a comment is never replaced: it is not a version of anything.
        const places = items.filter((i) => i.kind !== "comment");
        if (sessionId && places.length > 0) {
          await q(
            `UPDATE ai_edit_suggestion_items i SET status = 'replaced'
              WHERE i.status = 'pending' AND i.kind <> 'comment'
                AND i.suggestion_id IN (SELECT id FROM ai_edit_suggestions WHERE node_id = $1 AND session_id = $2 AND agent_actor_id = $3)
                AND EXISTS (SELECT 1 FROM unnest($4::boolean[], $5::text[], $6::int[]) AS n(is_title, base_text, base_occurrence)
                             WHERE n.is_title = (i.kind = 'title') AND n.base_text = i.base_text AND n.base_occurrence = i.base_occurrence)`,
            [input.nodeId, sessionId, agentActorId, places.map((i) => i.kind === "title"), places.map((i) => i.baseText), places.map((i) => i.baseOccurrence)]);
        }
        await q(
          `INSERT INTO ai_edit_suggestions (id, workspace_id, space_id, node_id, agent_actor_id, session_id, base_markdown, base_title, proposal_hash, created_event_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::bigint)`,
          [suggestionId, workspaceId, note.space_id, input.nodeId, agentActorId, sessionId, baseMarkdown, baseTitle, proposalHash, eventId]);
        await q(
          `INSERT INTO ai_edit_suggestion_items (suggestion_id, seq, kind, base_text, base_occurrence, new_text)
           SELECT $1, x.seq - 1, x.kind, x.base_text, x.base_occurrence, x.new_text
             FROM unnest($2::text[], $3::text[], $4::int[], $5::text[]) WITH ORDINALITY AS x(kind, base_text, base_occurrence, new_text, seq)`,
          [suggestionId, items.map((i) => i.kind), items.map((i) => i.baseText), items.map((i) => i.baseOccurrence), items.map((i) => i.newText)]);
      },
    });
    return { suggestionId, itemCount: items.length, deduped: false };
  }));
}

// ── deciding ────────────────────────────────────────────────────────────────

type Loaded = {
  suggestion: { id: string; node_id: string; space_id: string; agent_actor_id: string; session_id: string | null; base_markdown: string; base_title: string };
  /** Pending items the caller named, in seq order. */
  chosen: Array<{ id: string; seq: number; kind: SuggestionItemKind; base_text: string; base_occurrence: number; new_text: string | null }>;
  alreadyDecided: string[];
};

export type DecideResult = { accepted: string[]; stale: string[]; void: string[]; alreadyDecided: string[] };
export type RejectResult = { rejected: string[]; void: string[]; alreadyDecided: string[] };

/** Lock the suggestion's items and split the named ones into pending and decided. */
async function loadForDecision(
  workspaceId: string, suggestionId: string, itemIds: string[] | "all", actor: ActorCtx, open: readonly SuggestionItemStatus[] = ["pending"],
): Promise<Loaded> {
  const suggestion = (await q<Loaded["suggestion"]>(
    `SELECT id::text, node_id::text, space_id::text, agent_actor_id::text, session_id::text, base_markdown, base_title
       FROM ai_edit_suggestions WHERE id = $1 AND workspace_id = $2`, [suggestionId, workspaceId])).rows[0];
  if (!suggestion || !(await canReadNode(actor, suggestion.node_id))) throw refuse(404, "not_found", "suggestion not found");
  const rows = (await q<Loaded["chosen"][number] & { status: SuggestionItemStatus }>(
    `SELECT id::text, seq, kind, base_text, base_occurrence, new_text, status FROM ai_edit_suggestion_items
      WHERE suggestion_id = $1 ${itemIds === "all" ? "" : "AND id = ANY($2::uuid[])"} ORDER BY seq FOR UPDATE`,
    itemIds === "all" ? [suggestionId] : [suggestionId, itemIds])).rows;
  if (itemIds !== "all" && rows.length !== new Set(itemIds).size) throw refuse(404, "not_found", "item not found");
  return {
    suggestion,
    chosen: rows.filter((r) => open.includes(r.status)),
    alreadyDecided: rows.filter((r) => !open.includes(r.status)).map((r) => r.id),
  };
}

/** The note was deleted or moved to another space since it was proposed: the
 *  places no longer exist where the agent saw them. */
async function placeGone(workspaceId: string, suggestion: Loaded["suggestion"]): Promise<boolean> {
  const note = await liveNode(workspaceId, suggestion.node_id, true);
  return !note || note.space_id !== suggestion.space_id;
}

async function settle(ids: string[], status: SuggestionItemStatus, actor: ActorCtx, eventId: string | null, from: readonly SuggestionItemStatus[] = ["pending"]): Promise<void> {
  if (ids.length === 0) return;
  const r = await q(
    `UPDATE ai_edit_suggestion_items SET status = $2, decided_by = $3, decided_at = now(), decided_event_id = $4::bigint
      WHERE id = ANY($1::uuid[]) AND status = ANY($5::text[])`, [ids, status, carriedActorId(actor), eventId, from]);
  // The rows are locked and the workspace event lock is held: a loser here is a bug, not a race.
  if ((r.rowCount ?? 0) !== ids.length) throw new Error("suggestion items changed while deciding");
}

const decisionPayload = (s: Loaded["suggestion"], ids: string[]) => ({
  suggestion_id: s.id, item_ids: ids, proposed_by_actor_id: s.agent_actor_id,
  ...(s.session_id ? { proposed_by_session_id: s.session_id } : {}),
});

/** Apply the named pending items (or "all") to the note, as the person `actor`.
 *  All of them in one save first; when that cannot merge, one by one, so the
 *  places that can land do and each place that cannot is `stale`. Nothing is
 *  written for a stale place, and a person without write rights on the note
 *  gets an AuthorityError with every item still pending. A deleted or moved
 *  note makes the items void (committed, nothing written). */
export async function acceptSuggestionItems(
  workspaceId: string,
  input: { actor: ActorCtx; suggestionId: string; itemIds: string[] | "all" },
): Promise<DecideResult> {
  return withIdempotencyClaim(workspaceId, (claim) => withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(input.actor, workspaceId);
    const { suggestion, chosen, alreadyDecided } = await loadForDecision(workspaceId, input.suggestionId, input.itemIds, actor);
    const result: DecideResult = { accepted: [], stale: [], void: [], alreadyDecided };
    if (chosen.length === 0) return result;
    const authority = { kind: "node", nodeId: suggestion.node_id, op: "write_node" } as const;
    await assertAuthority(actor, authority); // before placeGone: voiding is a decision too
    if (await placeGone(workspaceId, suggestion)) {
      await settle(chosen.map((i) => i.id), "void", actor, null);
      return { ...result, void: chosen.map((i) => i.id) };
    }
    await claim();

    const note = (await liveNode(workspaceId, suggestion.node_id, true))!;
    type Chosen = ItemChange & { id: string; seq: number };
    const asChange = (i: { id: string; seq: number; kind: SuggestionItemKind; base_text: string; base_occurrence: number; new_text: string | null }): Chosen[] =>
      i.kind === "replace" ? [{ id: i.id, seq: i.seq, kind: "replace", baseText: i.base_text, baseOccurrence: i.base_occurrence, newText: i.new_text! }]
        : i.kind === "insert" ? [{ id: i.id, seq: i.seq, kind: "insert", baseText: i.base_text, baseOccurrence: i.base_occurrence, newText: i.new_text! }]
        : i.kind === "delete" ? [{ id: i.id, seq: i.seq, kind: "delete", baseText: i.base_text, baseOccurrence: i.base_occurrence }]
        : [];
    const body = chosen.flatMap(asChange);
    // What this suggestion already put in the note. The text to write is the agent's text with those places AND the
    // chosen ones made, so the note's side of the merge sees the same change and what is new lands in the order it
    // was proposed (two places after one paragraph, one accepted before the other, are not two unordered inserts).
    const earlier: Chosen[] = (await db.selectFrom("ai_edit_suggestion_items")
      .select(["id", "seq", "kind", "base_text", "base_occurrence", "new_text"])
      .where("suggestion_id", "=", suggestion.id).where("status", "=", "accepted").orderBy("seq").execute())
      .flatMap((row) => asChange({ ...row, kind: row.kind as SuggestionItemKind }));
    const withEarlier = (group: readonly Chosen[]) => [...earlier, ...group].sort((a, b) => a.seq - b.seq);
    // The merge starts from the text with what was accepted already made: the note's side is then only what the person
    // wrote since, and ours only what is chosen now. (Against the agent's original text, a place next to an
    // accepted one is one overlapping change to the merge.)
    // (Recomputed for each save: when everything at once cannot merge and the places are saved one by one, each one
    // that landed is an accepted place for the next.)
    const baseNow = () => (earlier.length > 0 ? applyItems(suggestion.base_markdown, earlier).markdown : suggestion.base_markdown);
    const title = chosen.filter((i) => i.kind === "title");
    const comments = chosen.filter((i) => i.kind === "comment");

    // A place that is not in the text the agent read, or a title someone
    // renamed since, cannot be located: stale before any merge.
    const missing = new Set(applyItems(suggestion.base_markdown, body).missing.map((index) => body[index]!.id));
    const tryBody = body.filter((i) => !missing.has(i.id));
    const tryTitle = title.filter((t) => t.base_text === note.title);
    result.stale.push(...body.filter((i) => missing.has(i.id)).map((i) => i.id), ...title.filter((t) => t.base_text !== note.title).map((t) => t.id));

    const save = async (group: { body: Chosen[]; title: typeof title }, ack: string[]): Promise<boolean> => {
      const markdown = group.body.length > 0 ? applyItems(suggestion.base_markdown, withEarlier(group.body)).markdown : undefined;
      const ids = [...group.body, ...group.title].map((i) => i.id).concat(ack);
      // An agent's reply that lands through this suggestion is a block of the note like one it wrote itself: it takes
      // the anchor its session names, so the reply counts as "already in the note" afterwards.
      const reply = markdown !== undefined && suggestion.session_id ? await replyAnchorFor(workspaceId, suggestion.session_id, markdown) : null;
      try {
        await withSavepoint(() => updateNode(workspaceId, suggestion.node_id, {
          ...(markdown !== undefined ? { markdown } : {}),
          ...(group.title.length > 0 ? { title: group.title[group.title.length - 1]!.new_text! } : {}),
        }, {
          actor, onConflict: "refuse",
          ...(markdown !== undefined ? { baseMarkdown: baseNow() } : {}),
          ...(reply ? { adoptAnchors: [reply] } : {}),
          event: {
            uiContext: "ai.suggestion.accept",
            txMeta: { suggested_by: { actor_id: suggestion.agent_actor_id, session_id: suggestion.session_id }, suggestion_id: suggestion.id },
            cascadeLabel: "ai.suggestion.accept.cascade", backupPrefix: "NODE_UPDATED",
          },
          within: async ({ nodeId }) => {
            await mutate({
              actor, workspaceId, authority: { kind: "cascade" },
              event: { type: "AI_SUGGESTION_ACCEPTED", targetType: "node", targetId: nodeId, payload: decisionPayload(suggestion, ids) },
              apply: async ({ eventId: decidedBy }) => settle(ids, "accepted", actor, decidedBy),
            });
          },
        }));
      } catch (error) {
        if (error instanceof BodyConflictError) return false;
        throw error;
      }
      result.accepted.push(...ids);
      earlier.push(...group.body);
      return true;
    };

    const units = tryBody.length + tryTitle.length;
    if (units > 0) {
      const all = { body: tryBody, title: tryTitle };
      if (!(await save(all, comments.map((c) => c.id)))) {
        // One by one: what can land does. A comment rides on the first save.
        let ack = comments.map((c) => c.id);
        for (const one of [...tryBody.map((b) => ({ body: [b], title: [] })), ...tryTitle.map((t) => ({ body: [], title: [t] }))]) {
          if (await save(one, ack)) ack = [];
          else result.stale.push(...one.body.map((i) => i.id), ...one.title.map((i) => i.id));
        }
        if (ack.length > 0) await acknowledge(workspaceId, suggestion, ack, actor, result);
      }
    } else if (comments.length > 0) {
      await acknowledge(workspaceId, suggestion, comments.map((c) => c.id), actor, result);
    }
    await markStale(result.stale, actor);
    return result;
  }));
}

/** Comments change no text: accepting one is the person marking it read. */
async function acknowledge(workspaceId: string, suggestion: Loaded["suggestion"], ids: string[], actor: ActorCtx, result: DecideResult): Promise<void> {
  await mutate({
    actor, workspaceId, authority: { kind: "node", nodeId: suggestion.node_id, op: "write_node" },
    event: { type: "AI_SUGGESTION_ACCEPTED", targetType: "node", targetId: suggestion.node_id, payload: decisionPayload(suggestion, ids) },
    apply: async ({ eventId }) => settle(ids, "accepted", actor, eventId),
  });
  result.accepted.push(...ids);
}

async function markStale(ids: string[], actor: ActorCtx): Promise<void> {
  const unique = [...new Set(ids)];
  await settle(unique, "stale", actor, null);
}

/** Turn the named pending items (or "all") down. Writes nothing to the note.
 *  Needs write rights on it; a deleted or moved note makes the items void.
 *  A `stale` item (its place changed, nothing was written) is turned down the same way:
 *  that is the person's "dismiss", the only thing that ends it. */
export async function rejectSuggestionItems(
  workspaceId: string,
  input: { actor: ActorCtx; suggestionId: string; itemIds: string[] | "all" },
): Promise<RejectResult> {
  return withIdempotencyClaim(workspaceId, (claim) => withEventTransaction(workspaceId, async () => {
    const actor = await resolveCurrentActor(input.actor, workspaceId);
    const { suggestion, chosen, alreadyDecided } = await loadForDecision(workspaceId, input.suggestionId, input.itemIds, actor, ["pending", "stale"]);
    const result: RejectResult = { rejected: [], void: [], alreadyDecided };
    if (chosen.length === 0) return result;
    const ids = chosen.map((i) => i.id);
    await assertAuthority(actor, { kind: "node", nodeId: suggestion.node_id, op: "write_node" }); // before placeGone: voiding is a decision too
    if (await placeGone(workspaceId, suggestion)) {
      await settle(ids, "void", actor, null, ["pending", "stale"]);
      return { ...result, void: ids };
    }
    await claim();
    await mutate({
      actor, workspaceId, authority: { kind: "node", nodeId: suggestion.node_id, op: "write_node" },
      event: { type: "AI_SUGGESTION_REJECTED", targetType: "node", targetId: suggestion.node_id, payload: decisionPayload(suggestion, ids) },
      apply: async ({ eventId }) => settle(ids, "rejected", actor, eventId, ["pending", "stale"]),
    });
    return { ...result, rejected: ids };
  }));
}

// ── reading ─────────────────────────────────────────────────────────────────

/** The skill each session used, for the sessions `actor` started. A skill the
 *  person named is the title of its note; one the AI chose is the name it kept
 *  with its reason (agent_sessions.picked_skill_*). */
async function skillsBehind(workspaceId: string, actor: ActorCtx, sessionIds: string[]): Promise<Map<string, NonNullable<NoteSuggestion["skill"]>>> {
  const out = new Map<string, NonNullable<NoteSuggestion["skill"]>>();
  if (sessionIds.length === 0) return out;
  const rows = (await q<{ id: string; named: string | null; picked: string | null; reason: string | null }>(
    `SELECT s.id::text, c.title AS named, s.picked_skill_name AS picked, s.picked_skill_reason AS reason
       FROM agent_sessions s LEFT JOIN content_nodes c ON c.id = s.skill_node_id AND ${liveNodeSql("c")}
      WHERE s.workspace_id = $1 AND s.id = ANY($2::uuid[]) AND s.initiator_id = $3`,
    [workspaceId, sessionIds, actor.id])).rows;
  for (const r of rows) {
    if (r.named) out.set(r.id, { name: r.named, picked: false, reason: null });
    else if (r.picked) out.set(r.id, { name: r.picked, picked: true, reason: r.reason });
  }
  return out;
}

/** The suggestions of a note that still need the person (items pending, or
 *  stale to tell them), newest first, for readers of the note. A set made for
 *  a space the note has since left is not listed. `canDecide` is whether
 *  `actor` may accept or reject (write rights). Null when the note cannot be read. */
export async function suggestionsForNode(
  workspaceId: string, nodeId: string, { actor }: { actor: ActorCtx },
): Promise<{ suggestions: NoteSuggestion[]; canDecide: boolean } | null> {
  if (!(await canReadNode(actor, nodeId))) return null;
  const rows = (await q<Omit<NoteSuggestion, "items" | "skill"> & { base_markdown: string; note_markdown: string }>(
    `SELECT s.id::text, s.agent_actor_id::text, COALESCE(a.name, '') AS agent_name, s.session_id::text, s.created_at,
            s.base_markdown, n.markdown AS note_markdown,
            s.created_at < now() - make_interval(days => $3) AS older
       FROM ai_edit_suggestions s
       JOIN content_nodes n ON n.id = s.node_id AND ${liveNodeSql("n")} AND n.space_id = s.space_id
       LEFT JOIN actors a ON a.id = s.agent_actor_id
      WHERE s.workspace_id = $1 AND s.node_id = $2
        AND EXISTS (SELECT 1 FROM ai_edit_suggestion_items i WHERE i.suggestion_id = s.id AND i.status = ANY($4::text[]))
      ORDER BY s.created_at DESC, s.id`,
    [workspaceId, nodeId, OLDER_AFTER_DAYS, LISTED])).rows;
  const items = rows.length === 0 ? [] : (await q<SuggestionItem & { suggestion_id: string }>(
    `SELECT suggestion_id::text, id::text, seq, kind, base_text, base_occurrence, new_text, status
       FROM ai_edit_suggestion_items WHERE suggestion_id = ANY($1::uuid[]) AND status = ANY($2::text[]) ORDER BY suggestion_id, seq`,
    [rows.map((r) => r.id), LISTED])).rows;
  const skills = await skillsBehind(workspaceId, actor, rows.flatMap((r) => (r.session_id ? [r.session_id] : [])));
  let canDecide = false;
  try { await assertAuthority(actor, { kind: "node", nodeId, op: "write_node" }); canDecide = true; } catch { /* a reader only */ }
  return {
    canDecide,
    suggestions: rows.map(({ base_markdown, note_markdown, ...r }) => {
      const before = splitParagraphs(base_markdown), now = splitParagraphs(note_markdown);
      const counterpart = pairParagraphs(before, now);
      const placeOf = (item: { kind: SuggestionItemKind; base_text: string; base_occurrence: number }): SuggestionItem["place"] => {
        if (item.kind === "title" || item.base_text === "") return undefined;
        const at = findParagraph(before, item.base_text, item.base_occurrence);
        const j = at === -1 ? -1 : counterpart[at]!;
        return j === -1 ? null : { text: now[j]!.text, occurrence: paragraphOccurrence(now, j) };
      };
      return {
        ...r,
        skill: (r.session_id && skills.get(r.session_id)) || null,
        items: items.filter((i) => i.suggestion_id === r.id).map(({ suggestion_id: _s, ...item }) => {
          // The stored text of a place carries the separator after it (aiSuggestionBlocks): not part of what is shown.
          const text = item.new_text !== null && (item.kind === "replace" || item.kind === "insert") ? decodeUnit(item.new_text).text : item.new_text;
          const same = item.kind === "replace" && text !== null && text !== item.base_text && splitParagraphs(text)[0]?.norm === splitParagraphs(item.base_text)[0]?.norm;
          return {
            ...item, new_text: text, place: placeOf(item),
            change: item.kind !== "replace" || text === null ? null : text === item.base_text ? "spacing" as const : same ? "indent" as const : null,
          };
        }),
      };
    }),
  };
}
