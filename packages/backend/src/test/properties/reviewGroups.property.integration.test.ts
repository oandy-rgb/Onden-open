// Review groups: what the status page offers to practise by (GET /api/review/groups, service `groups`).
//
// A group is no object: it is a tag, or a note with the notes under it. The read must give, for every
// group, the numbers a session of that group would give today, so the property compares it with the
// session itself (queue with the same scope) and with a small model of tags and note trees.
//
// Random worlds: a note tree (up to 6 notes), which notes are cards, up to 3 tags (one may sit under another,
// one may be hidden), which notes carry which tag, some cards graded / stopped, the person's daily cap and the
// clock. Public surface of the review service only (the same functions the routes call).
//
// Invariants (the failure message names them):
//   same-as-session   every group's due / new equal what queue(scope) returns for it (split by the card's state)
//   tag-rows          the "by tag" rows are exactly the shown tags with at least one card in their scope (a card is in a tag's scope
//                     when its note or any note above it carries the tag), plus
//                     「沒有標籤」 when some card is under no shown tag; and their union covers every card
//   note-rows         the "by note" rows are exactly the top-most notes that hold cards (a note card's holder is the note
//                     it sits under), and they partition the cards:
//                     without a cap their numbers add up to the whole queue
//   cap               one global cap: no group gives more than the cap allows
//   no-leak           a member sees no row for a note they cannot read, and the rows they see equal their own sessions
//
// Why a file of its own: reviewState.property.integration.test.ts models one person's grading over two devices with
// no tags; the generators here (tag trees, note trees, a second reader) would not fit its command model.
//
//   PROPS_SEED=123 PROPS_RUNS=200 npx vitest run src/test/properties/reviewGroups.property.integration.test.ts
//
// SAFETY: only runs against a *_test database; skips otherwise. Own workspace, own actors, own notes.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { randomUUID } from "node:crypto";

let WS = "";
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => WS }));

import { pool, q } from "../../db.js";
import { createNote } from "../../services/noteCreate.js";
import { createTag } from "../../services/tagHierarchy.js";
import { applyTagToNode } from "../../services/tagMembershipWrites.js";
import * as review from "../../modules/review/service.js";
import { setNoteCard } from "../../modules/review/cards.js";
import type { ActorCtx } from "../../types.js";
import type { ReviewGroup } from "@onden/contract";
import { checkAsync } from "../helpers/propsConfig.js";
import { persistActor } from "../helpers/persistActor.js";
import { registerShippedModules } from "../helpers/registerShippedModules.js";
import { setModulesOn } from "../helpers/setModulesOn.js";
import { adminOnlySpace, putInSpace } from "../helpers/spaceFixtures.js";
import { seedQ } from "../helpers/seedQ.js";
import { isTestDatabase } from "../helpers/testDatabase.js";

registerShippedModules();
const isTestDb = isTestDatabase();
afterAll(async () => { await pool.end(); });

const NOTES = 6;
const TAGS = 3;
const START = Date.parse("2026-11-13T02:00:00.000Z");

/** One world. Note i's parent is a note before it (null = top); tag t's parent is a tag before it. */
type World = {
  parent: Array<number | null>;
  card: boolean[];
  tagParent: Array<number | null>;
  tagHidden: boolean[];
  /** carries[i][t]: note i carries tag t. */
  carries: boolean[][];
  /** Per note: null = never graded, else the rating it was graded with at START. */
  graded: Array<1 | 3 | null>;
  stopped: boolean[];
  cap: number | null;
  hoursLater: number;
  /** The note moved to a space the member is not in (after the owner's checks). */
  privateNote: number;
};

const worldArb: fc.Arbitrary<World> = fc.record({
  parent: fc.tuple(...Array.from({ length: NOTES }, (_, i) => i === 0 ? fc.constant(null) : fc.option(fc.integer({ min: 0, max: i - 1 }), { nil: null }))),
  card: fc.array(fc.boolean(), { minLength: NOTES, maxLength: NOTES }),
  tagParent: fc.tuple(...Array.from({ length: TAGS }, (_, t) => t === 0 ? fc.constant(null) : fc.option(fc.integer({ min: 0, max: t - 1 }), { nil: null }))),
  tagHidden: fc.array(fc.boolean(), { minLength: TAGS, maxLength: TAGS }),
  carries: fc.array(fc.array(fc.boolean(), { minLength: TAGS, maxLength: TAGS }), { minLength: NOTES, maxLength: NOTES }),
  graded: fc.array(fc.constantFrom<1 | 3 | null>(null, null, 1, 3), { minLength: NOTES, maxLength: NOTES }),
  stopped: fc.array(fc.boolean(), { minLength: NOTES, maxLength: NOTES }),
  cap: fc.constantFrom<number | null>(null, null, 1, 2, 3),
  hoursLater: fc.constantFrom(0, 1, 30, 100),
  privateNote: fc.nat(NOTES - 1),
}) as fc.Arbitrary<World>;

// ── The model: which groups there must be (no schedule maths, that is the queue's) ──────────────

const tagScope = (w: World, t: number): number[] => {
  const out = [t];
  for (let k = 0; k < out.length; k++) w.tagParent.forEach((p, c) => { if (p === out[k] && !out.includes(c)) out.push(c); });
  return out;
};
const cardsOf = (w: World): number[] => w.card.flatMap((isCard, i) => isCard ? [i] : []);
/** Note i, and every note above it, up to the top. */
const withAncestors = (w: World, i: number): number[] => {
  const out = [i];
  for (let p = w.parent[i]; p !== null && p !== undefined; p = w.parent[p]) out.push(p);
  return out;
};
/** A card is under a tag when its note, or any note above its note, carries the tag or one under it (read-time; block-nodes.md §5 still holds for paragraphs). */
const inTag = (w: World, i: number, t: number): boolean => withAncestors(w, i).some(n => tagScope(w, t).some(s => w.carries[n]![s]));
const noteSubtree = (w: World, root: number): number[] => {
  const out = [root];
  for (let k = 0; k < out.length; k++) w.parent.forEach((p, c) => { if (p === out[k] && !out.includes(c)) out.push(c); });
  return out;
};
const shownTags = (w: World): number[] => Array.from({ length: TAGS }, (_, t) => t).filter(t => !w.tagHidden[t]);
/** Rows "by tag" the model expects: shown tags with a card in scope; null = 「沒有標籤」. */
function expectedTagRows(w: World): Array<number | null> {
  const rows: Array<number | null> = shownTags(w).filter(t => cardsOf(w).some(i => inTag(w, i, t)));
  if (cardsOf(w).some(i => !shownTags(w).some(t => inTag(w, i, t)))) rows.push(null);
  return rows;
}
/** The note that holds card i: the note it sits under, or itself at the top (every parent is readable to the owner). */
const holderOf = (w: World, i: number): number => w.parent[i] ?? i;
/** Rows "by note": holders of cards with no other holder above them. */
function expectedNoteRows(w: World): number[] {
  const holders = [...new Set(cardsOf(w).map(i => holderOf(w, i)))];
  return holders.filter(h => !holders.some(o => o !== h && noteSubtree(w, o).includes(h)));
}

// ── One run ──────────────────────────────────────────────────────────────────

const countOf = (queue: Awaited<ReturnType<typeof review.queue>>) => {
  const fresh = queue.cards.filter(card => card.state === null).length;
  return { due: queue.total - fresh, new: fresh };
};

async function playWorld(w: World, owner: ActorCtx, member: ActorCtx): Promise<string | null> {
  const noteIds: string[] = [];
  const tagIds: string[] = [];
  const spaces: string[] = [];
  const tail = randomUUID().slice(0, 8);
  const now = new Date(START + w.hoursLater * 3_600_000);
  const problems: string[] = [];
  const fail = (msg: string) => { problems.push(msg); };
  try {
    for (let t = 0; t < TAGS; t++) {
      const parentId = w.tagParent[t] === null ? null : tagIds[w.tagParent[t]!]!;
      tagIds.push((await createTag({ actor: owner, workspaceId: WS, name: `rg-${tail}-t${t}`, parentId })).id);
      if (w.tagHidden[t]) await seedQ("UPDATE content_nodes SET hidden = true WHERE id = $1", [tagIds[t]]);
    }
    for (let i = 0; i < NOTES; i++) {
      const parentId = w.parent[i] === null ? undefined : noteIds[w.parent[i]!]!;
      noteIds.push((await createNote({ actor: owner, workspaceId: WS, title: `rg-${tail}-n${i}`, markdown: "", parentId, event: { uiContext: "test" } })).node.id as string);
      if (w.card[i]) await setNoteCard(owner, noteIds[i]!, true);
      for (let t = 0; t < TAGS; t++) if (w.carries[i]![t]) await applyTagToNode({ workspaceId: WS, actor: owner, nodeId: noteIds[i]!, tagId: tagIds[t]! });
      if (w.card[i] && w.graded[i]) await review.grade(owner, noteIds[i]!, w.graded[i]!, new Date(START));
      if (w.card[i] && w.stopped[i]) await review.stopReviewing(owner, { kind: "node", id: noteIds[i]! });
    }
    await seedQ("DELETE FROM actor_prefs WHERE actor_id = $1 AND key = 'reviewsPerDay'", [owner.id]);
    if (w.cap !== null) await seedQ(`INSERT INTO actor_prefs (actor_id, key, value, updated_at) VALUES ($1, 'reviewsPerDay', $2::jsonb, now())`, [owner.id, JSON.stringify(w.cap)]);

    const whole = await review.queue(owner, { now });
    const byTag = await review.groups(owner, { by: "tag", now });
    const byNote = await review.groups(owner, { by: "note", now });

    // same-as-session, tag-rows
    const wantTags = expectedTagRows(w);
    const rowIds = byTag.groups.map(g => g.id);
    const wantIds = wantTags.map(t => t === null ? null : tagIds[t]!);
    if (JSON.stringify([...rowIds].sort()) !== JSON.stringify([...wantIds].sort())) fail(`tag-rows: expected rows ${JSON.stringify(wantTags)} (by tag index), got ${JSON.stringify(rowIds.map(id => id === null ? null : tagIds.indexOf(id)))}`);
    for (const group of byTag.groups) {
      const session = await review.queue(owner, { now, ...(group.id === null ? { untagged: true } : { tagId: group.id }) });
      if (JSON.stringify(countOf(session)) !== JSON.stringify({ due: group.due, new: group.new })) fail(`same-as-session: tag row ${group.id === null ? "(none)" : tagIds.indexOf(group.id)} says ${group.due} due / ${group.new} new, its session gives ${JSON.stringify(countOf(session))}`);
      if (group.due + group.new > (w.cap ?? Infinity)) fail(`cap: tag row gives ${group.due + group.new}, cap ${w.cap}`);
    }
    // the union covers every card: every card is reachable through some row's scope (the model's scopes)
    for (const i of cardsOf(w)) {
      const covered = wantTags.some(t => t === null ? !shownTags(w).some(s => inTag(w, i, s)) : inTag(w, i, t));
      if (!covered) fail(`tag-rows: card ${i} is in no row`);
    }

    // note-rows
    const wantNotes = expectedNoteRows(w).map(i => noteIds[i]!);
    if (JSON.stringify(byNote.groups.map(g => g.id).sort()) !== JSON.stringify([...wantNotes].sort())) fail(`note-rows: expected the top-most holders ${JSON.stringify(expectedNoteRows(w))}, got ${JSON.stringify(byNote.groups.map(g => noteIds.indexOf(g.id!)))}`);
    let sum = 0;
    for (const group of byNote.groups) {
      const session = await review.queue(owner, { now, root: group.id! });
      if (JSON.stringify(countOf(session)) !== JSON.stringify({ due: group.due, new: group.new })) fail(`same-as-session: note row ${noteIds.indexOf(group.id!)} says ${group.due} due / ${group.new} new, its session gives ${JSON.stringify(countOf(session))}`);
      if (group.due + group.new > (w.cap ?? Infinity)) fail(`cap: note row gives ${group.due + group.new}, cap ${w.cap}`);
      sum += group.due + group.new;
    }
    if (w.cap === null && sum !== whole.total) fail(`note-rows: the rows add up to ${sum}, the whole queue is ${whole.total}`);
    const busy = (rows: ReviewGroup[]) => rows.map(g => g.due + g.new > 0);
    for (const rows of [byTag.groups, byNote.groups]) if (busy(rows).some((b, k, all) => b && all.slice(0, k).some(x => !x))) fail("the rows with something to do must come first");

    // no-leak: a member who cannot read one note sees no row for it, and equals their own sessions
    const space = await adminOnlySpace(WS, `rg-private-${tail}`, [owner.id]);
    spaces.push(space);
    await putInSpace(noteIds[w.privateNote]!, space);
    const hidden = new Set((await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE space_id = $1`, [space])).rows.map(r => r.id));
    const mTag = await review.groups(member, { by: "tag", now });
    const mNote = await review.groups(member, { by: "note", now });
    for (const group of mNote.groups) {
      if (hidden.has(group.id!)) fail(`no-leak: the member is given a row for a note they cannot read (${noteIds.indexOf(group.id!)})`);
      const session = await review.queue(member, { now, root: group.id! });
      if (JSON.stringify(countOf(session)) !== JSON.stringify({ due: group.due, new: group.new })) fail(`no-leak: the member's note row differs from their session`);
    }
    for (const group of mTag.groups) {
      const session = await review.queue(member, { now, ...(group.id === null ? { untagged: true } : { tagId: group.id }) });
      if (JSON.stringify(countOf(session)) !== JSON.stringify({ due: group.due, new: group.new })) fail(`no-leak: the member's tag row differs from their session`);
    }
    const mAll = (await review.queue(member, { now })).total;
    const mSum = mNote.groups.reduce((n, g) => n + g.due + g.new, 0);
    if (mSum !== mAll) fail(`no-leak: the member's note rows add up to ${mSum}, their queue is ${mAll}`);
    return problems.length ? problems.join("\n") : null;
  } finally {
    await seedQ("DELETE FROM actor_prefs WHERE actor_id = $1 AND key = 'reviewsPerDay'", [owner.id]);
    await seedQ("DELETE FROM review_states WHERE node_id = ANY($1::uuid[])", [noteIds]);
    await seedQ("DELETE FROM content_nodes WHERE id = ANY($1::uuid[])", [[...noteIds, ...tagIds]]);
    for (const space of spaces) {
      await seedQ("DELETE FROM space_members WHERE space_id = $1", [space]);
      await seedQ("DELETE FROM spaces WHERE id = $1", [space]);
    }
  }
}

describe.skipIf(!isTestDb)("review groups agree with their sessions (random worlds of tags, note trees and a second reader)", () => {
  let owner: ActorCtx;
  let member: ActorCtx;

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Props review groups', $1) RETURNING id::text`, [`props-groups-${randomUUID()}`])).rows[0]!.id;
    await setModulesOn(WS, null);
    owner = await persistActor(WS, { id: "rg-owner", name: "Owner", role: "admin", type: "human" });
    member = await persistActor(WS, { id: "rg-member", name: "Member", role: "editor", type: "human" });
  });

  it("random worlds: every group's numbers are its session's; rows cover and partition the cards; a member sees only what they can read", { timeout: 600_000 }, async () => {
    await checkAsync(fc.asyncProperty(worldArb, async (w) => {
      const problem = await playWorld(w, owner, member);
      if (problem) throw new Error(problem);
    }), process.env.PROPS_RUNS ? Infinity : 25);
  });

  // ── Fixed minimal worlds: one per rule, so a failure names it without luck ──────────────────
  const base = (): World => ({
    parent: [null, null, null, null, null, null], card: [false, false, false, false, false, false],
    tagParent: [null, null, null], tagHidden: [false, false, false],
    carries: Array.from({ length: NOTES }, () => [false, false, false]),
    graded: [null, null, null, null, null, null], stopped: [false, false, false, false, false, false],
    cap: null, hoursLater: 0, privateNote: 5,
  });
  const run = async (w: World) => expect(await playWorld(w, owner, member)).toBeNull();

  it("a card whose only tag is hidden is listed under 「沒有標籤」, so the union still covers it", async () => {
    const w = base();
    w.card[0] = true; w.carries[0]![1] = true; w.tagHidden[1] = true;
    await run(w);
  });
  it("a card under a child tag counts under the parent tag too, the way the tag scope counts it", async () => {
    const w = base();
    w.tagParent[1] = 0; w.card[0] = true; w.carries[0]![1] = true;
    await run(w);
  });
  it("a card note under another card note belongs to the top-most one: two cards, one row, nothing counted twice", async () => {
    const w = base();
    w.parent[1] = 0; w.card[0] = true; w.card[1] = true;
    await run(w);
  });
  it("note cards under a plain note (a lecture) are one row named by the lecture, not a row each", async () => {
    const w = base();
    w.parent[1] = 0; w.parent[2] = 0; w.card[1] = true; w.card[2] = true;
    await run(w);
    expect(expectedNoteRows(w)).toEqual([0]);
  });
  it("the daily cap is global: a cap of 1 gives no group more than one card", async () => {
    const w = base();
    w.card[0] = true; w.card[1] = true; w.card[2] = true; w.cap = 1;
    await run(w);
  });
  it("a stopped card still has its group, with nothing due or new, listed after the busy ones", async () => {
    const w = base();
    w.card[0] = true; w.stopped[0] = true; w.card[1] = true;
    await run(w);
  });
});
