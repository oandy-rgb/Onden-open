// State is a pure function of a set of ops. No clock, no database, no I/O: the same ops in any
// arrival order give the same World, which is the whole convergence argument (doc §4).
//
//   materialize(ops)  sort by (hlc, origin, seq), then apply each op to the state the earlier ones built.
//
// Every op gets a verdict while it is applied: valid ones change the state, invalid ones change nothing
// and say why. "Allowed?" is asked against the membership state AT THAT POINT of the order, so a late-arriving
// revocation (earlier in the order) retroactively invalidates what came after it, on every node alike.
import { mergeBody } from "../services/eventLog/index.js";
import { compareOps } from "./hlc.js";
import { ROLE_RANK, isGlobalTagSpace, type ActorId, type NoteId, type Op, type OpId, type Role, type SpaceId, type Verdict } from "./types.js";

export type Space = { id: SpaceId; name: string; owner: ActorId; members: Map<ActorId, Exclude<Role, "none">> };
export type Note = {
  id: NoteId; space: SpaceId; kind: "content" | "tag"; title: string; body: string;
  parent: NoteId | null; deleted: boolean; tags: Set<NoteId>; createdBy: ActorId;
  /** Both sides of every body conflict: the merge keeps the later op's text; the other text is kept here so it can be offered back. */
  conflicts: Array<{ op: OpId; kept: string; lost: string }>;
  suggestions: Array<{ op: OpId; author: ActorId; text: string }>;
  /** Every valid op that touched this note, in order, including ones a later op overwrote (title, tag, move): nothing merged away is unknowable. */
  history: OpId[];
};
export type World = { spaces: Map<SpaceId, Space>; notes: Map<NoteId, Note>; verdicts: Map<OpId, Verdict> };

export const emptyWorld = (): World => ({ spaces: new Map(), notes: new Map(), verdicts: new Map() });

/** What `actor` may do in `space` in this state: the member's role, nothing for a non-member. Same as the server's rule
 *  (spine/spaceAccess.ts: read = member, write = `edit`); the owner manages the space but reads it only as a member
 *  (`space.create` makes the creator a member). The global tag space is the one exception, as on the server (spine/spaceScope.ts:
 *  a tag definition is readable by everyone; changing it is the owner's). */
export function roleIn(world: World, space: SpaceId, actor: ActorId): Role {
  const s = world.spaces.get(space);
  if (!s) return "none";
  if (isGlobalTagSpace(space) && s.owner !== actor) return "view";
  return s.members.get(actor) ?? "none";
}
export const canRead = (world: World, space: SpaceId, actor: ActorId): boolean => ROLE_RANK[roleIn(world, space, actor)] >= ROLE_RANK.view;

const no = (reason: string): Verdict => ({ ok: false, reason });
const yes: Verdict = { ok: true };

function isDescendantOrSelf(world: World, ancestor: NoteId, start: NoteId | null): boolean {
  for (let cur = start, hops = 0; cur !== null && hops < 10_000; hops++) {
    if (cur === ancestor) return true;
    cur = world.notes.get(cur)?.parent ?? null;
  }
  return false;
}

/** Check `op` against `world` and, when valid, apply it. An invalid op leaves `world` untouched (verdict recorded either way). */
export function applyOp(world: World, op: Op): Verdict {
  const verdict = check(world, op);
  if (verdict.ok) apply(world, op);
  world.verdicts.set(op.id, verdict);
  return verdict;
}

function check(world: World, op: Op): Verdict {
  const b = op.body;
  if (b.kind === "space.create") {
    if (op.space !== b.space) return no("wrong_space");
    return world.spaces.has(b.space) ? no("space_exists") : yes;
  }
  const space = world.spaces.get(op.space);
  if (!space) return no("unknown_space");
  const rank = ROLE_RANK[roleIn(world, op.space, op.author)];
  if (b.kind === "member.set") {
    if (b.space !== op.space) return no("wrong_space");
    return space.owner === op.author ? yes : no("not_owner");
  }
  if (b.kind === "note.create") {
    if (rank < ROLE_RANK.edit) return no("cannot_edit");
    if (world.notes.has(b.note)) return no("note_exists");
    if (b.parent !== null) {
      const parent = world.notes.get(b.parent);
      if (!parent || parent.space !== op.space || parent.kind !== b.noteKind) return no("bad_parent");
      if (parent.deleted) return no("parent_deleted");
    }
    return yes;
  }
  const note = world.notes.get(b.note);
  if (!note) return no("unknown_note");
  if (note.space !== op.space) return no("wrong_space");
  if (b.kind === "note.suggest") return rank >= ROLE_RANK.suggest ? yes : no("cannot_suggest");
  if (rank < ROLE_RANK.edit) return no("cannot_edit");
  if (b.kind === "note.tag") {
    const tag = world.notes.get(b.tag);
    if (!tag || tag.kind !== "tag" || (tag.space !== op.space && !isGlobalTagSpace(tag.space)) || note.kind !== "content") return no("bad_tag");
    return yes;
  }
  if (b.kind === "note.move") {
    if (note.kind !== "content") return no("not_movable");
    if (b.parent === null) return yes;
    const parent = world.notes.get(b.parent);
    if (!parent || parent.space !== op.space || parent.kind !== "content") return no("bad_parent");
    if (parent.deleted) return no("parent_deleted");
    // Two people moving A under B and B under A at once: whichever sorts first lands, the other is refused here, on every node.
    return isDescendantOrSelf(world, b.note, b.parent) ? no("cycle") : yes;
  }
  return yes;
}

function apply(world: World, op: Op): void {
  const b = op.body;
  switch (b.kind) {
    case "space.create":
      world.spaces.set(b.space, { id: b.space, name: b.name, owner: op.author, members: new Map() });
      if ((b.ownerRole ?? "edit") !== "none") world.spaces.get(b.space)!.members.set(op.author, b.ownerRole === "view" || b.ownerRole === "suggest" ? b.ownerRole : "edit");
      return;
    case "member.set": {
      const members = world.spaces.get(b.space)!.members;
      if (b.role === "none") members.delete(b.actor); else members.set(b.actor, b.role);
      return;
    }
    case "note.create":
      world.notes.set(b.note, { id: b.note, space: op.space, kind: b.noteKind, title: b.title, body: b.body, parent: b.parent, deleted: false, tags: new Set(), createdBy: op.author, conflicts: [], suggestions: [], history: [op.id] });
      return;
  }
  const note = world.notes.get(b.note)!;
  note.history.push(op.id);
  switch (b.kind) {
    case "note.title": note.title = b.title; break;
    case "note.body": {
      if (note.body === b.before) { note.body = b.after; break; }
      const merged = mergeBody(b.before, b.after, note.body);
      for (const c of merged.conflicts) note.conflicts.push({ op: op.id, kept: c.incoming, lost: c.current });
      note.body = merged.merged;
      break;
    }
    case "note.tag": if (b.on) note.tags.add(b.tag); else note.tags.delete(b.tag); break;
    case "note.move": note.parent = b.parent; break;
    case "note.delete": note.deleted = true; break;
    case "note.restore": note.deleted = false; break;
    case "note.suggest": note.suggestions.push({ op: op.id, author: op.author, text: b.text }); break;
  }
}

/** The state every node holding exactly these ops agrees on. */
export function materialize(ops: Iterable<Op>): World {
  const world = emptyWorld();
  for (const op of [...ops].sort(compareOps)) applyOp(world, op);
  return world;
}

/** Canonical text of one space's state: equal digests = equal state. Order of Maps/Sets does not matter. */
export function spaceDigest(world: World, space: SpaceId): string {
  const s = world.spaces.get(space);
  if (!s) return "∅";
  const notes = [...world.notes.values()].filter((n) => n.space === space).sort((x, y) => (x.id < y.id ? -1 : 1))
    .map((n) => ({ ...n, tags: [...n.tags].sort(), conflicts: n.conflicts, suggestions: n.suggestions }));
  return JSON.stringify({ name: s.name, owner: s.owner, members: [...s.members].sort(), notes });
}
