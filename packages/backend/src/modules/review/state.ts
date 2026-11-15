import type { ReviewHold } from "@onden/contract";
import { sql } from "kysely";
import { q } from "../../db.js";
import { db } from "../../dbKysely.js";

// One person's review schedule for one card (review_states, migration 092; a
// card is a note or a block node, one table since migration 183).
// Personal progress, not a change to the shared note: no domain event. The
// route runs these inside its event transaction after its read and
// enrolment checks; the row lock serializes concurrent grades from the same
// person.

/** What a card is: a whole note, or one block node of a note. */
export type CardTarget = { kind: "node" | "block"; id: string };

// The card's column per kind (fixed names, never interpolated from input).
const COLUMN = { node: "node_id", block: "block_id" } as const;

/** Lock (creating if absent) the person's row and return its current state
 *  text ('' for a card never graded). */
export async function lockReviewState(workspaceId: string, target: CardTarget, actorId: string): Promise<string | null> {
  const col = COLUMN[target.kind];
  await q(`INSERT INTO review_states(workspace_id,${col},actor_id,state) VALUES($1,$2,$3,'')
      ON CONFLICT(${col},actor_id) DO NOTHING`, [workspaceId, target.id, actorId]);
  const prevRow = await q<{ state: string }>(
    `SELECT state FROM review_states WHERE ${col}=$1 AND actor_id=$2 FOR UPDATE`, [target.id, actorId]);
  return prevRow.rows[0]?.state || null;
}

// What `previous_state` says about the one-step undo (no migration: the marker
// is a value in the existing text column):
//   a schedule text → undo restores it;
//   FIRST_GRADE     → this grade was the card's first, undo makes the card new (deletes the row);
//   NULL            → nothing to undo (already undone once, or a row older than the marker).
// NULL must never delete the row: a second undo (another device or tab, a new
// Idempotency-Key) would otherwise reset a card with many reviews to new.
const FIRST_GRADE = '{"first_grade":true}';

/** The id of the grade that wrote this state text (kept in the state JSON
 *  beside the hold; `parseReviewState` never returns it), or null for a
 *  schedule written before grades had ids. Reps alone cannot name a grade:
 *  grade, undo, and another device's grade all land on the same reps. */
export function gradeIdOf(raw: string | null | undefined): string | null {
  const id = readJson(raw).grade_id;
  return typeof id === "string" ? id : null;
}

/** Store a new schedule, keeping the one before it (`previousJson`, null for
 *  a first grade) for a one-step undo. */
export async function saveGradedState(target: CardTarget, actorId: string, stateJson: string, previousJson: string | null): Promise<void> {
  const col = COLUMN[target.kind];
  await q(`UPDATE review_states SET previous_state=$4, state=$3, updated_at=now() WHERE ${col}=$1 AND actor_id=$2`,
    [target.id, actorId, stateJson, previousJson ?? FIRST_GRADE]);
}

// ── Holds ───────────────────────────────────────────────────────────────────
// A person can put a card off until a later time ("tomorrow") or leave it out
// of their reviews (stop reviewing). It is kept in the same row, under a
// `hold` key of the state JSON, so a card never graded can carry one too (a
// row whose JSON is only `{"hold":…}` is a new card on hold) and no schema
// changes. Grading writes a fresh schedule without it, which ends the hold.

type StateJson = Record<string, unknown>;
function readJson(raw: string | null | undefined): StateJson {
  if (!raw) return {};
  try { const value = JSON.parse(raw); return value && typeof value === "object" && !Array.isArray(value) ? value as StateJson : {}; }
  catch { return {}; }
}

/** The hold stored in a state text, or null. */
export function holdOf(raw: string | null | undefined): ReviewHold | null {
  const hold = readJson(raw).hold as Partial<ReviewHold> | undefined;
  if (!hold || typeof hold !== "object") return null;
  const until = typeof hold.until === "string" ? hold.until : null;
  return hold.suspended === true || until ? { suspended: hold.suspended === true, until } : null;
}

/** The schedule text without its hold; null when nothing but a hold was there
 *  (a card never graded). */
export function scheduleWithoutHold(raw: string | null | undefined): string | null {
  const { hold: _hold, ...rest } = readJson(raw);
  return typeof rest.due === "string" ? JSON.stringify(rest) : null;
}

/** Put the person's hold on a card, or clear it (null), keeping its schedule
 *  and its one-step undo. Creates the row for a card never graded. */
export async function saveHold(workspaceId: string, target: CardTarget, actorId: string, hold: ReviewHold | null): Promise<void> {
  const col = COLUMN[target.kind];
  const current = readJson(await lockReviewState(workspaceId, target, actorId));
  const { hold: _previous, ...rest } = current;
  const next = hold ? { ...rest, hold } : rest;
  await db.updateTable("review_states").set({ state: Object.keys(next).length ? JSON.stringify(next) : "", updated_at: sql`now()` })
    .where(col, "=", target.id).where("actor_id", "=", actorId).execute();
}

/** The person's row, locked for an undo (undefined when there is none). */
export async function lockForUndo(target: CardTarget, actorId: string): Promise<{ previous_state: string | null; state: string } | undefined> {
  const col = COLUMN[target.kind];
  return (await q<{ previous_state: string | null; state: string }>(
    `SELECT previous_state, state FROM review_states WHERE ${col}=$1 AND actor_id=$2 FOR UPDATE`, [target.id, actorId])).rows[0];
}

/** The person's current state text for a card (undefined when never graded). */
export async function readReviewState(target: CardTarget, actorId: string): Promise<string | undefined> {
  const col = COLUMN[target.kind];
  return (await q<{ state: string }>(`SELECT state FROM review_states WHERE ${col}=$1 AND actor_id=$2`, [target.id, actorId])).rows[0]?.state;
}

/** Step back one grade: a first grade removes the row (the card is new
 *  again); otherwise the previous schedule returns. Returns false, changing
 *  nothing, when there is nothing to step back to (`previous_state` NULL). */
export async function stepBackReviewState(target: CardTarget, actorId: string, previousState: string | null): Promise<boolean> {
  const col = COLUMN[target.kind];
  if (previousState === null) return false;
  if (previousState === FIRST_GRADE) {
    await q(`DELETE FROM review_states WHERE ${col}=$1 AND actor_id=$2`, [target.id, actorId]);
    return true;
  }
  await q(`UPDATE review_states SET state=previous_state, previous_state=NULL, updated_at=now() WHERE ${col}=$1 AND actor_id=$2`,
    [target.id, actorId]);
  return true;
}

/** The schedule an undo returns to, or null when it returns the card to new. */
export function undoTargetState(previousState: string): string | null {
  return previousState === FIRST_GRADE ? null : previousState;
}
