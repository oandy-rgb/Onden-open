// Who may see which domain events (docs/architecture/spaces.md). One rule for
// every reader of the event log — the event feed, bootstrap, cascade previews:
//
//   * an event about a note (a task or a canvas is a note too): whoever can
//     read that note;
//   * an event about a tag definition or one of its views: every member (tag
//     definitions are global);
//   * an event about a space: that space's members;
//   * any other event (workspace settings, members, tokens, agent tool calls,
//     edges, outbox effects, reviews of other events): the workspace owner and
//     the actor who caused it — but the actor only while the event names no
//     note they cannot read (NOTE_REF_PAYLOAD_KEYS in the payload, the ids in
//     tx_meta.args.ids of a tool call). A member removed from a space, or whose
//     note was moved away, keeps no event that names that note; a note in the
//     trash they could read still counts as readable;
//   * a delegated token: only events about notes it can read.
//
// Events carry no space of their own, so the rule reads the target: the note's
// current readability, or the space id. A note moved out of a reader's spaces
// takes its history with it.

import { q } from "../db.js";
import { db } from "../dbKysely.js";
import { isWorkspaceOwner } from "../spine/authority.js";
import { hiddenTagIds } from "../spine/spaceScope.js";
import type { ActorCtx } from "../types.js";
import { NODE_TARGET_TYPES } from "./eventTargets.js";
import { readableTrashedNodeIds } from "./readPolicy.js";

/** Target types whose target_id is a note: the note's readers see the event. */
const NOTE_TARGETS: readonly string[] = NODE_TARGET_TYPES;
/** Target types about global tag definitions: every member sees the event. */
const TAG_DEFINITION_TARGETS: readonly string[] = ["tag", "collection_view"];

/** Who the reader is, for event visibility. Build it with eventAudience(). */
export type EventAudience = {
  /** Live notes the reader can read, tasks included (readableNodeIdSet, from the caller's snapshot). */
  readable: ReadonlySet<string>;
  /** Events not about a note: "all" for the owner, "none" for a token or an
   *  anonymous reader, otherwise tag-definition events, events about the
   *  reader's spaces and the reader's own events. */
  others: "all" | "none" | {
    actorId: string;
    spaceIds: string[];
    /** Every note of the workspace (trashed ones too) the reader cannot read.
     *  An event of theirs that names one of these is hidden. */
    unreadableNoteIds: ReadonlySet<string>;
    /** Tag definitions the reader may not know the name of (spine/spaceScope.ts tagScopeSql: only a temporary session has any), so the events about
     *  them are hidden too; a view of a tag (`collection_view`) is hidden from a reader who has any. Empty for everyone else. */
    hiddenTagIds?: ReadonlySet<string>;
  };
};

/** Payload keys that hold a note id, in events that are not themselves about a
 *  note (EDGE_CREATED, FOCUS_*, AGENT_SESSION_STARTED). */
const NOTE_REF_PAYLOAD_KEYS: readonly string[] = ["source_node_id", "target_node_id", "task_id", "node_id"];

const sqlList = (types: readonly string[]) => `(${types.map((t) => `'${t}'`).join(",")})`;

/** The audience for `actor`; `readable` is the caller's readableNodeIdSet
 *  (all the reader's live notes, not only the ones a response carries). */
export async function eventAudience(actor: ActorCtx | null, workspaceId: string, readable: ReadonlySet<string>): Promise<EventAudience> {
  if (!actor || actor.tokenScope) return { readable, others: "none" };
  if (await isWorkspaceOwner(actor)) return { readable, others: "all" };
  const spaces = await q<{ id: string }>(
    `SELECT m.space_id::text AS id FROM space_members m JOIN spaces s ON s.id = m.space_id
      WHERE s.workspace_id = $1 AND s.deleted_at IS NULL AND m.actor_id::text = $2`,
    [workspaceId, actor.id],
  );
  const trashed = await readableTrashedNodeIds(actor, workspaceId);
  const allNotes = await db.selectFrom("content_nodes").select("id").where("workspace_id", "=", workspaceId).execute();
  const unreadableNoteIds = new Set(allNotes.map((r) => r.id).filter((id) => !readable.has(id) && !trashed.has(id)));
  return { readable, others: { actorId: actor.id, spaceIds: spaces.rows.map((r) => r.id), unreadableNoteIds, hiddenTagIds: await hiddenTagIds(actor, workspaceId) } };
}

/** The rule as a SQL predicate over an event row aliased `alias` (pushes its
 *  params), so it binds before any LIMIT. target_id is stored as text. */
export function eventVisibleSql(alias: string, audience: EventAudience, params: unknown[]): string {
  const p = (value: unknown) => `$${params.push(value)}`;
  const note = `(${alias}.target_type IN ${sqlList(NOTE_TARGETS)} AND ${alias}.target_id = ANY(${p([...audience.readable])}::text[]))`;
  if (audience.others === "none") return note;
  const other = `${alias}.target_type NOT IN ${sqlList(NOTE_TARGETS)}`;
  if (audience.others === "all") return `(${note} OR ${other})`;
  const { actorId, spaceIds, unreadableNoteIds } = audience.others;
  const hiddenTagIds = audience.others.hiddenTagIds ?? new Set<string>();
  return `(${note}
    OR (${alias}.target_type IN ${sqlList(TAG_DEFINITION_TARGETS)}
        AND ${hiddenTagIds.size === 0 ? "true" : `${alias}.target_type = 'tag' AND NOT ${alias}.target_id = ANY(${p([...hiddenTagIds])}::text[])`})
    OR (${alias}.target_type = 'space' AND ${alias}.target_id = ANY(${p(spaceIds)}::text[]))
    OR (${other} AND ${alias}.actor_id::text = ${p(actorId)} AND ${namesNoUnreadableNoteSql(alias, p([...unreadableNoteIds]))}))`;
}

/** The event names no note in `unreadable` (a $n text[] param): neither in its
 *  payload keys nor in the ids a tool call recorded. */
function namesNoUnreadableNoteSql(alias: string, unreadable: string): string {
  const payloadRefs = `ARRAY[${NOTE_REF_PAYLOAD_KEYS.map((key) => `${alias}.payload->>'${key}'`).join(", ")}]`;
  const argIds = `jsonb_each(CASE WHEN jsonb_typeof(${alias}.tx_meta->'args'->'ids') = 'object' THEN ${alias}.tx_meta->'args'->'ids' ELSE '{}'::jsonb END) kv,
        LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(kv.value) = 'array' THEN kv.value ELSE jsonb_build_array(kv.value) END) a(ref)`;
  return `NOT (${payloadRefs} && ${unreadable}::text[]
    OR EXISTS (SELECT 1 FROM ${argIds} WHERE a.ref = ANY(${unreadable}::text[])))`;
}

/** The ids a row's payload and recorded tool arguments name. */
function namedIds(row: { payload?: Record<string, unknown> | null; tx_meta?: unknown }): string[] {
  const ids: string[] = [];
  for (const key of NOTE_REF_PAYLOAD_KEYS) {
    const id = row.payload?.[key];
    if (typeof id === "string") ids.push(id);
  }
  const args = (row.tx_meta as { args?: { ids?: unknown } } | null | undefined)?.args?.ids;
  if (args && typeof args === "object") {
    for (const value of Object.values(args)) {
      for (const v of Array.isArray(value) ? value : [value]) if (typeof v === "string") ids.push(v);
    }
  }
  return ids;
}

/** The same rule for one event row already loaded (select payload and tx_meta). */
export function eventVisible(
  row: { target_type: string; target_id: string; actor_id?: string | null; payload?: Record<string, unknown> | null; tx_meta?: unknown },
  audience: EventAudience,
): boolean {
  if (NOTE_TARGETS.includes(row.target_type)) return audience.readable.has(row.target_id);
  if (audience.others === "none") return false;
  if (audience.others === "all") return true;
  if (TAG_DEFINITION_TARGETS.includes(row.target_type)) {
    const hiddenTagIds = audience.others.hiddenTagIds ?? new Set<string>();
    return hiddenTagIds.size === 0 || (row.target_type === "tag" && !hiddenTagIds.has(row.target_id));
  }
  if (row.target_type === "space") return audience.others.spaceIds.includes(row.target_id);
  if (row.actor_id !== audience.others.actorId) return false;
  const { unreadableNoteIds } = audience.others;
  return !namedIds(row).some((id) => unreadableNoteIds.has(id));
}
