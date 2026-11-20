import { validAnchorRangesByNote } from "../../services/blockAnchors/index.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { StatusError } from "../../statusError.js";
import { q, getWorkspaceId } from "../../db.js";
import { sql } from "kysely";
import { db } from "../../dbKysely.js";
import { addDays, dayStartInstant, localDayId } from "../../localDay.js";
import { mutatePersonal, requireActor } from "../../spine/mutate.js";
import { personalDataOwnerId } from "../../spine/authority.js";
import { canReadNode, canSeeTag, readableScopeSql } from "../../services/readPolicy.js";
import { withActorReadSnapshot, withActorReadSnapshotOrChain } from "../../services/actorReadSnapshot.js";
import { subtreeIds } from "../../services/nodeTree.js";
import { readPrefOf } from "../../services/actorPrefs.js";
import { ownRefSql } from "../../services/functionRefSql.js";
import { moduleTagInfo, ownRefId } from "../../services/functionRefs.js";
import { memberTagIds } from "../../services/tagHierarchy.js";
import { workspaceHasModule } from "../../services/workspaceModules.js";
import type { ActorCtx } from "../../types.js";
import { blockCardSides, blockNeighbours, type BlockNeighbours } from "@onden/markdown";
import type { ReviewCard, ReviewContext, ReviewGradeResult, ReviewGroup, ReviewGroupBy, ReviewGroups, ReviewHold, ReviewQueue, ReviewRating, ReviewState, ReviewStatus, ReviewStatusCard } from "@onden/contract";
import { gradeIdOf, lockReviewState, saveGradedState, lockForUndo, readReviewState, stepBackReviewState, undoTargetState, saveHold, holdOf, scheduleWithoutHold, type CardTarget } from "./state.js";
import { replacePersonalSettings, mergePersonalSettings, clearPersonalSettings } from "./settings.js";
import { DEFAULT_PARAMS, isDue, parseReviewState, previewIntervals, schedule, type SchedulerParams } from "./fsrs.js";
import { liveNodeSql, liveTagNodeSql } from "../../spine/nodeSql.js";
import { TAG_NODE_TYPE, isNote } from "@onden/markdown/contract";

// The review service: what a person studies, and their grades. The HTTP
// routes (routes.ts) and the agent tool (reviewQueueTool.ts) both call it,
// so the queue an agent pulls is the queue the app shows.
//
// Enrolment. A card is a note or a paragraph (block node) that holds a review
// function reference of its own (function_refs; migration 195): nothing a tag
// does makes a card. Tags only pick cards to study (a tag scope: the notes
// carrying the tag or a tag under it, and their paragraphs). A workspace that
// has not imported Review enrols nothing.
//
// Progress is per PERSON (review_states, migration 092): the note is shared,
// each reader's schedule is their own, and grading changes only the grader's
// row — it is not an edit of the note, so reading it is enough. Disabling or
// removing a note's last module tag retires the card but keeps every
// person's state, so re-enrolment resumes it.
//
// Settings layer module default → the setting on the review module's tag, while
// the workspace still has one (behaviour.review; migration 196 keeps a tag a
// person set limits on) → personal override (actor_module_settings, keyed by that
// tag). Without the tag the defaults apply to everyone. Re-keying these by
// function is a later batch.
//
// Failures a caller must show (tag or note not found, note not reviewable,
// nothing to undo) throw ReviewError, which the HTTP boundary maps to
// { error: message } with its status. Everything here reads under the
// current actor and one snapshot or event transaction; callers pass the
// authenticated ActorCtx and never re-check read policy themselves.

/** The default size of one queue page. */
const QUEUE_CAP = 100;

export class ReviewError extends StatusError {
  constructor(status: 404 | 409, message: string) {
    super(status, message);
    this.name = "ReviewError";
  }
}

// ── Settings ────────────────────────────────────────────────────────────────

/** The allowed range of each review setting, the one copy the tag settings
 *  (clamped on read) and personal overrides (validated on write) share. */
const SETTINGS_RANGES = {
  request_retention: { min: 0.7, max: 0.97, int: false },
  maximum_interval_days: { min: 1, max: 36500, int: true },
} as const;
type SettingKey = keyof typeof SETTINGS_RANGES;

const r = SETTINGS_RANGES;
/** The 400 message for settings outside SETTINGS_RANGES. */
export const SETTINGS_RANGE_MESSAGE = `use `
  + `${r.request_retention.min}–${r.request_retention.max} recall and `
  + `${r.maximum_interval_days.min}–${r.maximum_interval_days.max} days`;

function settingField(key: SettingKey) {
  const { min, max, int } = SETTINGS_RANGES[key];
  return (int ? z.number().int() : z.number()).min(min).max(max);
}
const fields = { request_retention: settingField("request_retention"),
  maximum_interval_days: settingField("maximum_interval_days") };

/** A person's full settings for one source tag (PUT): every field optional,
 *  unknown fields rejected. */
export const settingsSchema = z.object({
  request_retention: fields.request_retention.optional(),
  maximum_interval_days: fields.maximum_interval_days.optional(),
}).strict();
/** A change to them (PATCH): a field sent replaces it, null removes it, a
 *  field not sent is kept. */
export const settingsPatchSchema = z.object({
  request_retention: fields.request_retention.nullable().optional(),
  maximum_interval_days: fields.maximum_interval_days.nullable().optional(),
}).strict();
export type PersonalSettings = z.infer<typeof settingsSchema>;
export type PersonalSettingsPatch = z.infer<typeof settingsPatchSchema>;

/** A card as the service holds it: the wire card (@onden/contract
 *  ReviewCard) before its intervals and context are worked out. */
export type Card = Omit<ReviewCard, "next_days" | "context">;
export type ReviewBehaviour = SchedulerParams;
export const DEFAULT_BEHAVIOUR: ReviewBehaviour = { ...DEFAULT_PARAMS };
/** Where review's settings come from: the workspace's review module tag while it exists, else NO_SETTINGS_TAG (the defaults).
 *  Only the scheduler's two numbers come from here; how many reviews a day is the person's one cap (actor_prefs "reviewsPerDay"). */
type ReviewTag = { id: string; source: string; behaviour: ReviewBehaviour };
/** The settings source of a workspace with no review module tag: not a tag, so it has no page and no personal override. */
const NO_SETTINGS_TAG = "";
type EnrolledCard = Card & { parent_id: string | null; module_tag_ids: string[]; created_at: string; hold?: ReviewHold | null; neighbours?: BlockNeighbours | null; source_title?: string | null };
type CardRow = { id: string; title: string; markdown: string; state_raw: string | null; ink_data: string | null; parent_id: string | null; parent_title: string | null; created_at: string };
type BlockCardRow = { id: string; block_ref: string; label: string; note_id: string; note_title: string; markdown: string; state_raw: string | null; created_at: string };

function clamped(key: SettingKey, value: unknown, dflt: number): number {
  const { min, max, int } = SETTINGS_RANGES[key];
  const v = typeof value === "number" && Number.isFinite(value) ? value : dflt;
  const bounded = Math.min(Math.max(v, min), max);
  return int ? Math.floor(bounded) : bounded;
}

/** Existing behaviour.review settings remain portable in TagPacks. Invalid
 * values use defaults; counts and days are whole numbers. Enrolment is a
 * separate explicit module setting, never inferred from these preferences. */
export function reviewBehaviourFromSchema(behaviour: Record<string, unknown> | null | undefined): ReviewBehaviour {
  const value = behaviour?.review;
  const b = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    requestRetention: clamped("request_retention", b.request_retention, DEFAULT_BEHAVIOUR.requestRetention),
    maximumIntervalDays: clamped("maximum_interval_days", b.maximum_interval_days, DEFAULT_BEHAVIOUR.maximumIntervalDays),
  };
}

/** A person's overrides of review settings, per source tag. */
async function loadPersonalOverrides(actorId: string | null): Promise<Map<string, Record<string, unknown>>> {
  if (!actorId) return new Map();
  const rows = await q<{ tag_id: string; settings: Record<string, unknown> }>(
    "SELECT tag_id, settings FROM actor_module_settings WHERE actor_id=$1", [actorId]);
  return new Map(rows.rows.map(row => [row.tag_id, row.settings]));
}

/** Overlay a person's overrides on the tag's stored review settings. */
function personalBehaviour(tagBehaviour: Record<string, unknown> | null | undefined, override: Record<string, unknown> | undefined): ReviewBehaviour {
  if (!override) return reviewBehaviourFromSchema(tagBehaviour);
  const stored = tagBehaviour?.review && typeof tagBehaviour.review === "object" ? tagBehaviour.review as Record<string, unknown> : {};
  return reviewBehaviourFromSchema({ review: { ...stored, ...override } });
}

/** All active memberships contribute: retaining more and capping sooner are
 * compatible constraints, independent of tag order, name, or visibility. */
export function combineReviewBehaviour(behaviours: ReviewBehaviour[]): SchedulerParams {
  if (!behaviours.length) return DEFAULT_PARAMS;
  return {
    requestRetention: Math.max(...behaviours.map(b => b.requestRetention)),
    maximumIntervalDays: Math.min(...behaviours.map(b => b.maximumIntervalDays)),
  };
}

// ── Enrolment ───────────────────────────────────────────────────────────────

/** The settings source of the actor's cards (one entry; none while the module is off): the live review module tag with the person's own
 *  override laid over it, else the defaults. */
async function loadReviewTags(workspaceId: string, actorId: string | null = null): Promise<ReviewTag[]> {
  if (!(await workspaceHasModule(workspaceId, "review"))) return [];
  const module = await moduleTagInfo(workspaceId, "review");
  if (!module) return [{ id: NO_SETTINGS_TAG, source: NO_SETTINGS_TAG, behaviour: DEFAULT_BEHAVIOUR }];
  const override = (await loadPersonalOverrides(actorId)).get(module.id);
  return [{ id: module.id, source: module.id, behaviour: personalBehaviour(module.behaviour, override) }];
}

/** The cards a tag picks (the ONE rule: queue, deck, stats and the group counts all read it). A card is under tag T when it carries a
 *  tag under or extending T itself (tagHierarchy.memberTagIds, the rule a tag page lists notes by), its note does, or a note above its
 *  note does (the whole chain to the top). Worked out when read: nothing is written onto the cards, and a paragraph still does not
 *  inherit tags (block-nodes.md §5). Returns the note ids (the tagged notes and everything under them) and the tagged paragraph ids. */
async function tagScope(workspaceId: string, tagId: string): Promise<{ notes: Set<string>; blocks: Set<string> }> {
  const tagIds = await memberTagIds(workspaceId, tagId);
  if (!tagIds.length) return { notes: new Set(), blocks: new Set() };
  const notes = (await sql<{ id: string }>`
    WITH RECURSIVE below AS (
      SELECT n.id FROM content_nodes n
       WHERE n.workspace_id = ${workspaceId} AND ${sql.raw(liveNodeSql("n"))}
         AND n.id IN (SELECT node_id FROM node_tags WHERE tag_id = ANY(${tagIds}::uuid[]))
      UNION
      SELECT c.id FROM content_nodes c JOIN below b ON c.parent_id = b.id
       WHERE c.workspace_id = ${workspaceId} AND ${sql.raw(liveNodeSql("c"))}
    )
    SELECT id::text FROM below`.execute(db)).rows.map((row) => row.id);
  const blocks = new Set((await db.selectFrom("block_node_tags").select("block_node_id").distinct().where("tag_id", "in", tagIds).execute()).map((row) => row.block_node_id));
  return { notes: new Set(notes), blocks };
}
const inTagScope = (card: EnrolledCard, scope: { notes: Set<string>; blocks: Set<string> }): boolean =>
  scope.notes.has(card.node_id) || (card.block !== null && scope.blocks.has(card.block.id));

async function assertVisibleTag(actor: ActorCtx, workspaceId: string, tagId: string): Promise<void> {
  const exists = await q(`SELECT 1 FROM content_nodes WHERE workspace_id=$1 AND id=$2 AND ${liveTagNodeSql()}`, [workspaceId, tagId]);
  if (!exists.rows.length || !(await canSeeTag(actor, tagId))) throw new ReviewError(404, "tag not found");
}

/** The tags a person can study by, with the cards each covers: every live tag that is not hidden (the one hide rule: no list shows a
 *  hidden tag; a layout tag the app keeps for itself is no group either), each with its tagScope. The list "by tag" rows and the
 *  「沒有標籤」 scope share. */
async function groupTagScopes(workspaceId: string, actor: ActorCtx): Promise<Array<{ id: string; title: string; scope: { notes: Set<string>; blocks: Set<string> } }>> {
  const rows = { rows: await db.selectFrom("content_nodes").select(["id", "title"])
    .where("workspace_id", "=", workspaceId).where("node_type", "=", TAG_NODE_TYPE).where("deleted_at", "is", null)
    .where("hidden", "=", false).where("reserved_key", "is", null).orderBy("title").orderBy("id").execute() };
  const visible: Array<{ id: string; title: string }> = [];
  for (const row of rows.rows) if (await canSeeTag(actor, row.id)) visible.push(row);
  return Promise.all(visible.map(async tag => ({ ...tag, scope: await tagScope(workspaceId, tag.id) })));
}

/** Which cards a study session covers: every card, the cards in one note's subtree, the cards of one tag, or the cards no tag
 *  group covers (「沒有標籤」). Queue, deck and the group counts all select through cardsInScope, so a group's numbers are its session's. */
type CardScope = { root?: string; tagId?: string; untagged?: boolean };

async function cardsInScope(workspaceId: string, actor: ActorCtx, cards: EnrolledCard[], { root, tagId, untagged }: CardScope): Promise<EnrolledCard[]> {
  if (tagId) await assertVisibleTag(actor, workspaceId, tagId);
  const subtree = root ? new Set(await subtreeIds(workspaceId, root, { lifecycle: "live", includeRoot: true })) : null;
  const scope = tagId ? await tagScope(workspaceId, tagId) : null;
  const groupScopes = untagged ? await groupTagScopes(workspaceId, actor) : null;
  return cards.filter(card => (!scope || inTagScope(card, scope)) && (!subtree || subtree.has(card.node_id))
    && (!groupScopes || !groupScopes.some(group => inTagScope(card, group.scope))));
}

/** The actor's enrolled cards. Counting surfaces (stats, decks) pass
 *  `bodies: false`: the note bodies and ink are not read at all (they are
 *  the heavy part), and the cards carry "" / null in their place. */
async function loadEnrolledCards(workspaceId: string, actor: ActorCtx, tags: ReviewTag[], { bodies = true }: { bodies?: boolean } = {}): Promise<EnrolledCard[]> {
  if (!tags.length) return [];
  const params: unknown[] = [workspaceId, personalDataOwnerId(actor)];
  const scope = readableScopeSql(actor, "n", params);
  // A card's parent is named only when the actor can read it too.
  const parentScope = readableScopeSql(actor, "p", params);
  const body = bodies ? "n.markdown, ink.value AS ink_data" : "'' AS markdown, NULL::text AS ink_data";
  const inkJoin = bodies ? "LEFT JOIN node_attributes ink ON ink.node_id=n.id AND ink.key='ink_data'" : "";
  const rows = await q<CardRow>(
    `SELECT n.id,n.title,${body},n.parent_id,p.title AS parent_title,rs.state AS state_raw,
       to_char(n.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at
     FROM content_nodes n
     LEFT JOIN review_states rs ON rs.node_id=n.id AND rs.actor_id=$2
     LEFT JOIN content_nodes p ON p.id=n.parent_id AND p.node_type='content' AND ${liveNodeSql("p")} AND ${parentScope}
     ${inkJoin}
     WHERE n.workspace_id=$1 AND ${liveNodeSql("n")} AND n.hidden=false AND n.node_type='content'
       AND ${ownRefSql("node", "n.id", "review")}
       AND ${scope}
     ORDER BY n.created_at ASC,n.id ASC`, params);
  const sourceIds = tags.map(tag => tag.id);
  const notes: EnrolledCard[] = rows.rows.map(row => ({ node_id: row.id, title: row.title, markdown: row.markdown,
    ink_data: row.ink_data, state: parseReviewState(row.state_raw), parent_id: row.parent_id, module_tag_ids: sourceIds,
    block: null, created_at: row.created_at, hold: holdOf(row.state_raw), neighbours: null, source_title: row.parent_title }));
  const blocks = await loadBlockCards(workspaceId, actor, sourceIds, bodies);
  if (!blocks.length) return notes;
  // Enrolment order across both kinds: when the card (note / block) was made.
  return [...notes, ...blocks].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** The actor's enrolled block cards: block nodes holding a review reference of their own (a note's reference does not reach the
 *  blocks below it — block-nodes.md 已決定 6), in a note they can read. A card's deck is its note. */
async function loadBlockCards(workspaceId: string, actor: ActorCtx, sourceIds: string[], bodies: boolean): Promise<EnrolledCard[]> {
  const params: unknown[] = [workspaceId, personalDataOwnerId(actor)];
  const scope = readableScopeSql(actor, "n", params);
  const rows = await q<BlockCardRow>(
    `SELECT b.id,b.block_ref,b.label,b.note_id,n.title AS note_title,${bodies ? "n.markdown" : "'' AS markdown"},rs.state AS state_raw,
       to_char(b.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at
     FROM block_nodes b
     JOIN content_nodes n ON n.id=b.note_id
     LEFT JOIN review_states rs ON rs.block_id=b.id AND rs.actor_id=$2
     WHERE b.workspace_id=$1 AND b.hidden_at IS NULL AND b.detached_note_id IS NULL
       AND ${liveNodeSql("n")} AND n.hidden=false AND n.node_type='content'
       AND ${ownRefSql("block", "b.id", "review")}
       AND ${scope}
     ORDER BY b.created_at ASC,b.id ASC`, params);
  // A card's id is its anchor: the note's valid anchors say which block of the text it is.
  const anchorsByNote = bodies ? await validAnchorRangesByNote(workspaceId, [...new Set(rows.rows.map(row => row.note_id))]) : new Map<string, Array<{ id: string; from: number; to: number }>>();
  const cardRefsByNote = new Map<string, Set<string>>();
  for (const row of rows.rows) (cardRefsByNote.get(row.note_id) ?? cardRefsByNote.set(row.note_id, new Set()).get(row.note_id)!).add(row.block_ref);
  return rows.rows.map(row => {
    // The note's text is the source; the label stands in when the two have
    // drifted (a save in flight) or bodies were not read.
    const sides = bodies ? blockCardSides(row.markdown, row.block_ref, anchorsByNote.get(row.note_id) ?? []) : null;
    return { node_id: row.note_id, title: sides?.front || row.label, markdown: sides?.back ?? "", ink_data: null,
      state: parseReviewState(row.state_raw), parent_id: row.note_id, module_tag_ids: sourceIds,
      block: { id: row.id, ref: row.block_ref }, created_at: row.created_at, hold: holdOf(row.state_raw),
      neighbours: bodies ? blockNeighbours(row.markdown, row.block_ref, anchorsByNote.get(row.note_id) ?? [], cardRefsByNote.get(row.note_id)) : null,
      source_title: row.note_title };
  });
}

function publicCard(card: EnrolledCard): Card {
  return { node_id: card.node_id, title: card.title, markdown: card.markdown, ink_data: card.ink_data, state: card.state, block: card.block };
}

/** A card as the screen gets it: with what each grade would schedule next
 *  (the grade route's own scheduler, under the card's combined settings) and
 *  where it sits in its source. */
function queueCard(card: EnrolledCard, tags: ReviewTag[], now: Date): ReviewCard {
  const behaviour = combineReviewBehaviour(tags.filter(tag => card.module_tag_ids.includes(tag.id)).map(tag => tag.behaviour));
  const context: ReviewContext = card.block
    ? { source_title: card.source_title ?? null, before: card.neighbours?.before ?? null, after: card.neighbours?.after ?? null }
    : { source_title: card.source_title ?? null, before: null, after: null };
  return { ...publicCard(card), next_days: previewIntervals(card.state, now, behaviour), context };
}

// ── Holds: put off, left out ────────────────────────────────────────────────

/** A card the person put off until later, or stopped reviewing. */
function isHeld(card: EnrolledCard, now: Date): boolean {
  const hold = card.hold;
  return !!hold && (hold.suspended || (hold.until !== null && new Date(hold.until) > now));
}

/** When a scheduled card is next due for this person: its schedule, pushed
 *  back by "tomorrow". */
function dueAt(card: EnrolledCard & { state: ReviewState }): string {
  const until = card.hold?.until;
  return until && until > card.state.due ? until : card.state.due;
}

// ── When a card was introduced ───────────────────────────────────────────────

/** The day a card was introduced (first graded), or null when unknown.
 *  Older multi-review states do not prove their introduction date: they keep
 *  none rather than an invented one; old first-review states still have it. */
function introductionDate(state: ReviewState | null): string | null {
  return state?.introduced_at ?? (state?.reps === 1 ? state.last_review : null);
}

// ── The person's daily cap ──────────────────────────────────────────────────
// One number per person (actor_prefs "reviewsPerDay"), counted once across all
// the cards they have, due and new together. It reads no tag: a card with no
// source tag is counted like any other. What it holds back is only hidden at
// read time; no schedule is rewritten.

/** The key a card is counted by: its block, or its note. */
const cardKey = (card: EnrolledCard) => card.block?.id ?? card.node_id;

/** How many reviews today's cap still allows (Infinity without a cap).
 *  Everything graded today counts, new cards too, whatever its tags. */
export function reviewsLeftToday(cards: EnrolledCard[], limit: number | null, now: Date): number {
  return limit === null ? Infinity : Math.max(0, limit - reviewedToday(cards, now));
}

/** How many cards were graded today (each once, new or due). */
export function reviewedToday(cards: EnrolledCard[], now: Date): number {
  const day = localDayId(now);
  return new Set(cards.filter(card => card.state && localDayId(new Date(card.state.last_review)) === day).map(cardKey)).size;
}

/** `due` (in the order to review) split by what the cap allows: what fits today, and what rolls to tomorrow. */
export function withinDailyCap<C>(due: C[], left: number): { kept: C[]; rolledOver: C[] } {
  return { kept: due.slice(0, left), rolledOver: due.slice(left) };
}

async function loadDailyLimit(actorId: string): Promise<number | null> {
  const value = await readPrefOf(actorId, "reviewsPerDay");
  return typeof value === "number" ? value : null;
}

// ── Reading ─────────────────────────────────────────────────────────────────

export type QueueOptions = CardScope & {
  now?: Date;
  /** Page size; `total` still counts the whole queue. Default QUEUE_CAP. */
  cap?: number;
};
export type Queue = ReviewQueue;

/** What one session over `inScope` gives today: due cards most overdue first, then new cards in enrolment order, both within what the
 *  person's one daily cap (`left`, global) still allows. Held cards are not offered. The ONE selection rule: the queue is this list and a
 *  group's counts are its lengths. */
function planSession(inScope: EnrolledCard[], left: number, now: Date): { scheduled: EnrolledCard[]; fresh: EnrolledCard[] } {
  const candidates = inScope.filter(card => !isHeld(card, now));
  // Most overdue first; the cap covers due and new cards together, and what it
  // holds back rolls to tomorrow (hidden, not rewritten).
  const due = candidates.filter(card => card.state !== null && isDue(card.state, now))
    .sort((a, b) => a.state!.due.localeCompare(b.state!.due));
  const scheduled = withinDailyCap(due, left).kept;
  // New cards fill what the cap has left after the due ones; nothing else limits them.
  const fresh = candidates.filter(card => card.state === null).slice(0, Math.max(0, left - scheduled.length));
  return { scheduled, fresh };
}

/** What `authenticated` studies now (planSession), optionally limited to a scope.
 *  Example: queue(actor, { tagId, cap: 20 }). */
export async function queue(authenticated: ActorCtx | null, { now = new Date(), cap = QUEUE_CAP, ...scope }: QueueOptions = {}): Promise<Queue> {
  const workspaceId = await getWorkspaceId();
  return withActorReadSnapshotOrChain(authenticated, workspaceId, async actor => {
    if (scope.tagId) await assertVisibleTag(actor, workspaceId, scope.tagId);
    const tags = await loadReviewTags(workspaceId, personalDataOwnerId(actor));
    const cards = await loadEnrolledCards(workspaceId, actor, tags);
    const left = reviewsLeftToday(cards, await loadDailyLimit(personalDataOwnerId(actor)), now);
    const { scheduled, fresh } = planSession(await cardsInScope(workspaceId, actor, cards, scope), left, now);
    const all = [...scheduled, ...fresh];
    return { cards: all.slice(0, cap).map(card => queueCard(card, tags, now)), total: all.length };
  });
}

/** Every card `authenticated` has enrolled (in `scope`), due or not and regardless of
 *  the daily cap, in enrolment order. */
export async function deck(authenticated: ActorCtx | null, scope: CardScope = {}): Promise<Card[]> {
  const workspaceId = await getWorkspaceId();
  return withActorReadSnapshotOrChain(authenticated, workspaceId, async actor =>
    (await cardsInScope(workspaceId, actor, await loadEnrolledCards(workspaceId, actor, await loadReviewTags(workspaceId, personalDataOwnerId(actor))), scope)).map(publicCard));
}

export type Deck = { node_id: string; title: string; due: number };

/** The parents of due cards, as decks to study by subtree, most due first.
 *  A parent that is itself enrolled is a card, not a deck. */
export async function decks(authenticated: ActorCtx | null, now: Date = new Date()): Promise<Deck[]> {
  const workspaceId = await getWorkspaceId();
  return withActorReadSnapshot(authenticated, workspaceId, async actor => {
    const tags = await loadReviewTags(workspaceId, personalDataOwnerId(actor));
    const cards = await loadEnrolledCards(workspaceId, actor, tags, { bodies: false });
    // Opening a deck gives at most what the daily cap still allows.
    const left = reviewsLeftToday(cards, await loadDailyLimit(personalDataOwnerId(actor)), now);
    const ready = cards.filter(card => !isHeld(card, now) && isDue(card.state, now));
    const parents = [...new Set(ready.flatMap(card => card.parent_id ? [card.parent_id] : []))];
    if (!parents.length) return [];
    const params: unknown[] = [workspaceId, parents];
    const scope = readableScopeSql(actor, "p", params);
    const rows = await q<{ id: string; title: string }>(
      `SELECT p.id,p.title FROM content_nodes p
        WHERE p.workspace_id=$1 AND p.id=ANY($2::uuid[]) AND p.node_type='content' AND ${liveNodeSql("p")}
          AND NOT ${ownRefSql("node", "p.id", "review")}
          AND ${scope}`, params);
    const counts = new Map<string, number>();
    for (const card of ready) if (card.parent_id) counts.set(card.parent_id, (counts.get(card.parent_id) ?? 0) + 1);
    return rows.rows.map(row => ({ node_id: row.id, title: row.title, due: Math.min(counts.get(row.id)!, left) })).filter(deck => deck.due > 0).sort((a, b) => b.due - a.due);
  });
}

// ── Groups: what to study by ────────────────────────────────────────────────
// A group is not an object: it is a tag or a note that already exists. One
// read lists them with what a session of that group would give today, so the
// status page does not ask once per tag.

/** One row of the group list. `id` is the tag or the top note; null on the
 *  「沒有標籤」 row (title ""). `due` and `new` are planSession's for that group. */
export type Group = ReviewGroup;

/** The groups to study by, `by` tag or by note, busiest first and the ones with nothing to do after them.
 *  Every number is planSession over the same cards the group's session reads (queue with that scope), under the global daily cap. */
export async function groups(authenticated: ActorCtx | null, { by, now = new Date() }: { by: ReviewGroupBy; now?: Date }): Promise<ReviewGroups> {
  const workspaceId = await getWorkspaceId();
  return withActorReadSnapshot(authenticated, workspaceId, async actor => {
    const tags = await loadReviewTags(workspaceId, personalDataOwnerId(actor));
    const all = await loadEnrolledCards(workspaceId, actor, tags, { bodies: false });
    const left = reviewsLeftToday(all, await loadDailyLimit(personalDataOwnerId(actor)), now);
    const row = (id: string | null, title: string, members: EnrolledCard[]): Group => {
      const { scheduled, fresh } = planSession(members, left, now);
      return { id, title, due: scheduled.length, new: fresh.length };
    };
    const rows: Group[] = [];
    if (by === "tag") {
      const tagGroups = await groupTagScopes(workspaceId, actor);
      for (const tag of tagGroups) {
        const members = all.filter(card => inTagScope(card, tag.scope));
        if (members.length) rows.push(row(tag.id, tag.title, members));
      }
      const untagged = all.filter(card => !tagGroups.some(tag => inTagScope(card, tag.scope)));
      if (untagged.length) rows.push(row(null, "", untagged));
    } else {
      // The note that holds a card: the note a paragraph card is in; for a note card, the note it sits under (a lecture and the
      // notes of its cards), or itself when it sits under nothing the actor can read. A holder inside another holder's subtree is
      // that holder's: the rows are the top-most ones, and what each counts is its session (queue with `root`).
      const holderOf = (card: EnrolledCard) => card.block || card.source_title == null || !card.parent_id ? card.node_id : card.parent_id;
      const holders = [...new Set(all.map(holderOf))];
      const subtrees = new Map(await Promise.all(holders.map(async id => [id, new Set(await subtreeIds(workspaceId, id, { lifecycle: "live", includeRoot: true }))] as const)));
      const titles = new Map(all.map(card => [holderOf(card), card.block || holderOf(card) !== card.node_id ? card.source_title ?? "" : card.title]));
      for (const id of holders) {
        if (holders.some(other => other !== id && subtrees.get(other)!.has(id))) continue;
        rows.push(row(id, titles.get(id) ?? "", all.filter(card => subtrees.get(id)!.has(card.node_id))));
      }
    }
    const busy = (group: Group) => group.due + group.new > 0;
    return { by, groups: rows.sort((a, b) => Number(busy(b)) - Number(busy(a)) || b.due - a.due || b.new - a.new || a.title.localeCompare(b.title)) };
  });
}

export type Stats = { due: number; new: number; learned: number; new_available: number };

/** Counts for the actor's cards (or one tag's, ReviewError 404 when not
 *  visible). `due` and `new_available` are what the person's daily cap allows today. */
export async function stats(authenticated: ActorCtx | null, { now = new Date(), ...scope }: { now?: Date } & CardScope = {}): Promise<Stats> {
  const workspaceId = await getWorkspaceId();
  return withActorReadSnapshot(authenticated, workspaceId, async actor => {
    const tags = await loadReviewTags(workspaceId, personalDataOwnerId(actor));
    const allCards = await loadEnrolledCards(workspaceId, actor, tags, { bodies: false });
    const cards = (await cardsInScope(workspaceId, actor, allCards, scope)).filter(card => !isHeld(card, now));
    const fresh = cards.filter(card => card.state === null).length;
    // What a person's cap rolls to tomorrow is not due today.
    const left = reviewsLeftToday(allCards, await loadDailyLimit(personalDataOwnerId(actor)), now);
    const keptDue = Math.min(cards.filter(card => card.state !== null && isDue(card.state, now)).length, left);
    return { due: Math.min(cards.filter(card => isDue(card.state, now)).length, left), new: fresh, learned: cards.length - fresh, new_available: Math.min(fresh, Math.max(0, left - keptDue)) };
  });
}

/** The note a card target belongs to, checked live: the note itself, or
 *  the note holding a shown block node. ReviewError 404 when
 *  there is no such card or the actor cannot read its note. */
async function cardNote(actor: ActorCtx, workspaceId: string, target: CardTarget): Promise<string> {
  let noteId = target.id;
  if (target.kind === "block") {
    const row = (await q<{ note_id: string }>(
      "SELECT note_id FROM block_nodes WHERE id=$1 AND workspace_id=$2 AND hidden_at IS NULL", [target.id, workspaceId])).rows[0];
    if (!row) throw new ReviewError(404, "card not found");
    noteId = row.note_id;
  }
  if (!(await canReadNode(actor, noteId))) throw new ReviewError(404, target.kind === "block" ? "card not found" : "node not found");
  return noteId;
}

/** The actor's own schedule for a card (null when they have not graded it) and
 *  whether they put it off or stopped it.
 *  ReviewError 404 when they cannot read the note. */
export async function cardState(identity: ActorCtx | null, nodeId: string, target: CardTarget = { kind: "node", id: nodeId }): Promise<{ state: ReviewState | null; hold: ReviewHold | null }> {
  const actor = requireActor(identity);
  await cardNote(actor, await getWorkspaceId(), target);
  const raw = (await readReviewState(target, personalDataOwnerId(actor))) || null;
  return { state: parseReviewState(raw), hold: holdOf(raw) };
}

// ── Grading ─────────────────────────────────────────────────────────────────

/** Grade a card for the actor: their schedule advances with the settings of
 *  every enabled review tag on the card (the note's, or the block node's own)
 *  combined. Personal progress, not a change to the shared note: no domain
 *  event. A retried request (same Idempotency-Key) does not count twice.
 *  `seenReps` is the card's reps the client saw (0 for a new card); when given
 *  and different from the stored schedule's, another device graded it first:
 *  409, nothing written. Omitted (older clients) grades whatever is stored.
 *  ReviewError 404 when the card's note is not readable, 409 when it is not
 *  content or the card has no enabled review tag. `nodeId` is the note for a
 *  note card and the block node's id for a block card (`target`). */
export async function grade(identity: ActorCtx | null, nodeId: string, rating: ReviewRating, now: Date = new Date(), target: CardTarget = { kind: "node", id: nodeId }, seenReps?: number): Promise<ReviewGradeResult> {
  const workspaceId = await getWorkspaceId();
  const authenticated = requireActor(identity);
  return mutatePersonal({ actor: authenticated, workspaceId, apply: async ({ actor }) => {
    const { noteId, behaviour } = await enrolledCard(actor, workspaceId, target);
    // The row lock serializes concurrent grades from the same person.
    const previousRaw = await lockReviewState(workspaceId, target, actor.id);
    // A card this person stopped (perhaps on another device) is not graded by a stale queue.
    if (holdOf(previousRaw)?.suspended) throw new ReviewError(409, "card is stopped");
    const previous = parseReviewState(previousRaw);
    // The client graded a card as it saw it; another device may have graded it since.
    if (seenReps !== undefined && seenReps !== (previous?.reps ?? 0)) throw new ReviewError(409, "card changed since it was shown");
    const introducedAt = previous ? introductionDate(previous) : now.toISOString();
    const state: ReviewState = { ...schedule(previous, rating, now, behaviour), ...(introducedAt ? { introduced_at: introducedAt } : {}) };
    // A new schedule ends any hold; the one before it (without its hold) is the undo step.
    // The grade's own id rides in the stored JSON (never in `state`): an undo names the grade it removes by it.
    const gradeId = randomUUID();
    await saveGradedState(target, actor.id, JSON.stringify({ ...state, grade_id: gradeId }), scheduleWithoutHold(previousRaw));
    return { node_id: noteId, ...(target.kind === "block" ? { block_id: target.id } : {}), rating, state, grade_id: gradeId };
  } });
}

/** The card's note and the settings its review is run under, after checking the actor can read it and it is a card: the note's or
 *  paragraph's own review reference (migration 195), in a workspace that has imported Review.
 *  ReviewError 404 when the note is not readable, 409 otherwise. */
async function enrolledCard(actor: ActorCtx, workspaceId: string, target: CardTarget): Promise<{ noteId: string; behaviour: SchedulerParams }> {
  const noteId = await cardNote(actor, workspaceId, target);
  const node = (await q<{ node_type: string }>(
    `SELECT node_type FROM content_nodes WHERE id=$1 AND workspace_id=$2 AND ${liveNodeSql()}`, [noteId, workspaceId])).rows[0];
  if (!node) throw new ReviewError(404, "node not found");
  if (!isNote(node)) throw new ReviewError(409, "only content notes can be reviewed");
  const enabledTags = await loadReviewTags(workspaceId, personalDataOwnerId(actor));
  if (!enabledTags.length || !(await ownRefId({ kind: target.kind, id: target.id }, "review"))) {
    throw new ReviewError(409, target.kind === "block" ? "block is not a review card" : "note is not a review card");
  }
  return { noteId, behaviour: combineReviewBehaviour(enabledTags.map(tag => tag.behaviour)) };
}

/** Step back the actor's latest grade on a card: the schedule returns to
 *  what it was, or the card is new again (state null) after a first grade.
 *  One step only; a retried request does not step back twice. ReviewError
 *  404 when the note is not readable, 409 when there is nothing to undo.
 *  `graded.id` names the one grade this undo may remove (a grade id, since
 *  reps repeat after grade, undo, grade); `graded.reps` is the reps it
 *  produced. When given and
 *  different from the stored schedule's, another device graded since: 409, so
 *  this undo never removes that grade. */
export async function undoGrade(identity: ActorCtx | null, nodeId: string, target: CardTarget = { kind: "node", id: nodeId }, graded: { id?: string; reps?: number } = {}): Promise<{ node_id: string; block_id?: string; state: ReviewState | null }> {
  const workspaceId = await getWorkspaceId();
  const authenticated = requireActor(identity);
  return mutatePersonal({ actor: authenticated, workspaceId, apply: async ({ actor }) => {
    const noteId = await cardNote(actor, workspaceId, target);
    const row = await lockForUndo(target, actor.id);
    // A row holding only a hold is a card never graded: nothing to step back.
    if (!row || !parseReviewState(row.state)) throw new ReviewError(409, "nothing to undo");
    // Stepping back would undo the grade but lose the stop (the earlier schedule has no hold): leave it as it is.
    if (holdOf(row.state)?.suspended) throw new ReviewError(409, "card is stopped");
    if (graded.reps !== undefined && graded.reps !== parseReviewState(row.state)!.reps) throw new ReviewError(409, "card changed since it was graded");
    if (graded.id !== undefined && graded.id !== gradeIdOf(row.state)) throw new ReviewError(409, "card changed since it was graded");
    // NULL previous_state: already undone once (see state.ts); never reset the card.
    if (!(await stepBackReviewState(target, actor.id, row.previous_state))) throw new ReviewError(409, "nothing to undo");
    const restored = undoTargetState(row.previous_state!);
    return { node_id: noteId, ...(target.kind === "block" ? { block_id: target.id } : {}),
      state: restored === null ? null : parseReviewState(restored) };
  } });
}

// ── Putting a card off, leaving it out ───────────────────────────────────────

export type HoldResult = { node_id: string; block_id?: string; hold: ReviewHold | null };

/** Change the actor's hold on a card without grading it. Personal progress,
 *  like a grade: no domain event, and a retried request lands once. */
async function changeHold(identity: ActorCtx | null, target: CardTarget, holdFor: () => ReviewHold | null, mustBeEnrolled: boolean): Promise<HoldResult> {
  const workspaceId = await getWorkspaceId();
  const authenticated = requireActor(identity);
  return mutatePersonal({ actor: authenticated, workspaceId, apply: async ({ actor }) => {
    const noteId = mustBeEnrolled ? (await enrolledCard(actor, workspaceId, target)).noteId : await cardNote(actor, workspaceId, target);
    const hold = holdFor();
    await saveHold(workspaceId, target, actor.id, hold);
    return { node_id: noteId, ...(target.kind === "block" ? { block_id: target.id } : {}), hold };
  } });
}

/** 明天再說: no grade; the card comes back when the workspace's next day begins. */
export const putOffUntilTomorrow = (identity: ActorCtx | null, target: CardTarget, now: Date = new Date()) =>
  changeHold(identity, target, () => ({ suspended: false, until: dayStartInstant(addDays(localDayId(now), 1)).toISOString() }), true);

/** Stop reviewing a card: it leaves this person's queue and counts until resumed. */
export const stopReviewing = (identity: ActorCtx | null, target: CardTarget) =>
  changeHold(identity, target, () => ({ suspended: true, until: null }), true);

/** Bring a card back after putting it off or stopping it. */
export const resumeReviewing = (identity: ActorCtx | null, target: CardTarget) =>
  changeHold(identity, target, () => null, false);

// ── Status ──────────────────────────────────────────────────────────────────

/** A card forgotten this many times or more is listed on the status page. */
const FORGOTTEN_MIN = 4;
const FORECAST_DAYS = 7;
const statusListMax = 50;

const statusCard = (card: EnrolledCard): ReviewStatusCard => ({ node_id: card.node_id, title: card.title, lapses: card.state?.lapses ?? 0, block: card.block });

/** How the actor's reviews stand, counted by workspace day. Overdue cards
 *  are counted apart from the forecast; what the daily cap holds back rolls
 *  into tomorrow. */
export async function status(authenticated: ActorCtx | null, { now = new Date(), ...scope }: { now?: Date } & CardScope = {}): Promise<ReviewStatus> {
  const workspaceId = await getWorkspaceId();
  return withActorReadSnapshot(authenticated, workspaceId, async actor => {
    const tags = await loadReviewTags(workspaceId, personalDataOwnerId(actor));
    const everyCard = await loadEnrolledCards(workspaceId, actor, tags, { bodies: false });
    // The page follows the chosen scope; the daily cap stays the person's one number over every card.
    const all = await cardsInScope(workspaceId, actor, everyCard, scope);
    const today = localDayId(now);
    const live = all.filter(card => !card.hold?.suspended);
    const scheduled = live.filter((card): card is EnrolledCard & { state: ReviewState } => card.state !== null);
    const dayOf = (card: EnrolledCard & { state: ReviewState }) => localDayId(new Date(dueAt(card)));
    const dueByToday = scheduled.filter(card => dayOf(card) <= today).sort((a, b) => dueAt(a).localeCompare(dueAt(b)));
    const limit = await loadDailyLimit(personalDataOwnerId(actor));
    const left = reviewsLeftToday(everyCard, limit, now);
    const { kept, rolledOver } = withinDailyCap(dueByToday, left);
    const overdue = kept.filter(card => dayOf(card) < today).length;
    const forecast = Array.from({ length: FORECAST_DAYS }, (_, index) => {
      const date = addDays(today, index + 1);
      return { date, count: scheduled.filter(card => dayOf(card) === date).length + (index === 0 ? rolledOver.length : 0) };
    });
    const heldNow = new Set(live.filter(card => isHeld(card, now)).map(card => card.block?.id ?? card.node_id));
    const fresh = live.filter(card => !heldNow.has(card.block?.id ?? card.node_id));
    return {
      today_date: today, overdue, today: kept.length - overdue,
      new_available: Math.min(fresh.filter(card => card.state === null).length, Math.max(0, left - kept.length)),
      rolled_over: rolledOver.length,
      reviews_per_day: limit,
      reviewed_today: reviewedToday(everyCard, now),
      forecast,
      forgotten_min: FORGOTTEN_MIN,
      forgotten: scheduled.filter(card => card.state.lapses >= FORGOTTEN_MIN)
        .sort((a, b) => b.state.lapses - a.state.lapses || a.title.localeCompare(b.title)).slice(0, statusListMax).map(statusCard),
      stopped: all.filter(card => card.hold?.suspended).slice(0, statusListMax).map(statusCard),
    };
  });
}

/** The cards the actor stopped inside one note: the note itself, its paragraphs
 *  and everything under it (the note's own review command offers them back).
 *  Read lazily, once, when that command opens. ReviewError 404 when the note
 *  is not readable. */
export async function stoppedUnder(authenticated: ActorCtx | null, rootId: string): Promise<ReviewStatusCard[]> {
  const workspaceId = await getWorkspaceId();
  return withActorReadSnapshot(authenticated, workspaceId, async actor => {
    await cardNote(actor, workspaceId, { kind: "node", id: rootId });
    const subtree = new Set(await subtreeIds(workspaceId, rootId, { lifecycle: "live", includeRoot: true }));
    const cards = await loadEnrolledCards(workspaceId, actor, await loadReviewTags(workspaceId, personalDataOwnerId(actor)), { bodies: false });
    return cards.filter(card => card.hold?.suspended && subtree.has(card.node_id)).slice(0, statusListMax).map(statusCard);
  });
}

// ── Personal settings ───────────────────────────────────────────────────────
// Anyone who can see a source tag may set their own settings for it; the
// tag's shared settings stay with the tag's editors (PATCH /api/tags/:id/schema).
// Each throws ReviewError 404 when the actor cannot see the tag. Values are
// validated by the callers with settingsSchema / settingsPatchSchema.

/** The actor's stored settings for the tag, or null. */
export async function personalSettings(identity: ActorCtx | null, tagId: string): Promise<Record<string, unknown> | null> {
  const actor = requireActor(identity);
  await assertVisibleTag(actor, await getWorkspaceId(), tagId);
  const row = await q<{ settings: Record<string, unknown> }>(
    "SELECT settings FROM actor_module_settings WHERE actor_id=$1 AND tag_id=$2", [personalDataOwnerId(actor), tagId]);
  return row.rows[0]?.settings ?? null;
}

/** Replace the actor's settings for the tag. */
export async function replaceSettings(identity: ActorCtx | null, tagId: string, settings: PersonalSettings): Promise<PersonalSettings> {
  const actor = requireActor(identity);
  const workspaceId = await getWorkspaceId();
  await assertVisibleTag(actor, workspaceId, tagId);
  await mutatePersonal({ actor, workspaceId, apply: ({ actor: current }) => replacePersonalSettings(current.id, tagId, settings) });
  return settings;
}

/** Merge a change into the actor's settings; answers the result, or null
 *  when nothing is left (the row is then removed). */
export async function patchSettings(identity: ActorCtx | null, tagId: string, patch: PersonalSettingsPatch): Promise<Record<string, unknown> | null> {
  const actor = requireActor(identity);
  const workspaceId = await getWorkspaceId();
  await assertVisibleTag(actor, workspaceId, tagId);
  return mutatePersonal({ actor, workspaceId, apply: ({ actor: current }) => mergePersonalSettings(current.id, tagId, patch) });
}

/** Remove the actor's settings for the tag. */
export async function clearSettings(identity: ActorCtx | null, tagId: string): Promise<void> {
  const actor = requireActor(identity);
  const workspaceId = await getWorkspaceId();
  await assertVisibleTag(actor, workspaceId, tagId);
  await mutatePersonal({ actor, workspaceId, apply: ({ actor: current }) => clearPersonalSettings(current.id, tagId) });
}
