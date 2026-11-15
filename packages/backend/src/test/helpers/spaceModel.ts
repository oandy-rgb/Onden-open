// The reference model of space access, written once for the property tests that
// compare it with the real app (properties/spineModel.property.integration.test.ts)
// and the database-free laws on the model itself (properties/spaceModel.property.test.ts).
//
// The rule is spine/spaceAccess.ts's header (docs/architecture/proposals/
// roles-owner-member-2026-10-22.md §3.3):
//
//   read(actor, S)  = member of S                       (token: and S.external_ai on)
//   write(actor, S) = read ∧ permission 'edit'          (token: and its access is 'write')
//
// A revoked or missing token reads and writes nothing. Deleted notes are not
// visible to anyone; the trash is a different read path.

export type Perm = "view" | "edit";
/** Who is a member of a space: three people and the agent the token belongs to. */
export type Member = "owner" | "A" | "B" | "G";
/** Who sends a request: a person's session, or the agent's bearer token. */
export type Who = "owner" | "A" | "B" | "tok";
export const WHO: Who[] = ["owner", "A", "B", "tok"];
export type Access = "read" | "write";

export type MSpace = { id: string; externalAi: boolean; members: Map<Member, Perm> };
export type MNote = {
  id: string;
  /** Unique text inside the title and body, so a leak is found by searching a response for it. */
  mark: string;
  space: string;
  /** Every space the note has lived in: a response is not a leak when any of them is readable. */
  everIn: Set<string>;
  parent: string | null;
  title: string;
  body: string;
  deleted: boolean;
  /** The note whose delete took this one to the trash. */
  deletedBy: string | null;
  /** A descendant was moved out of this note: old events may still name its id. */
  lostChild: boolean;
};
export type MToken = { id: string; plaintext: string; access: Access; revoked: boolean };
export type MEdge = { id: string; from: string; to: string };
export type Model = { spaces: MSpace[]; notes: MNote[]; edges: MEdge[]; token: MToken | null };

export const newModel = (): Model => ({ spaces: [], notes: [], edges: [], token: null });
export const memberOf = (w: Who): Member => (w === "tok" ? "G" : w);
export const tokenDead = (m: Model, w: Who): boolean => w === "tok" && (m.token === null || m.token.revoked);

export function canReadIn(m: Model, w: Who, spaceId: string): boolean {
  if (tokenDead(m, w)) return false;
  const s = m.spaces.find((x) => x.id === spaceId);
  if (!s || !s.members.has(memberOf(w))) return false;
  return w !== "tok" || s.externalAi;
}

export function canWriteIn(m: Model, w: Who, spaceId: string): boolean {
  if (!canReadIn(m, w, spaceId)) return false;
  const s = m.spaces.find((x) => x.id === spaceId)!;
  return s.members.get(memberOf(w)) === "edit" && (w !== "tok" || m.token!.access === "write");
}

export const visible = (m: Model, w: Who, n: MNote): boolean => !n.deleted && canReadIn(m, w, n.space);
export const writable = (m: Model, w: Who, n: MNote): boolean => !n.deleted && canWriteIn(m, w, n.space);
export const visibleIds = (m: Model, w: Who): string[] => m.notes.filter((n) => visible(m, w, n)).map((n) => n.id);

/** Notes whose content must not appear in anything `w` is shown: no space they
 *  ever lived in is readable by `w` now. (A note that moved from a readable
 *  space to an unreadable one is left out: whether history shows the early part
 *  is a policy question the model does not decide.) */
export const hiddenFrom = (m: Model, w: Who): MNote[] =>
  m.notes.filter((n) => ![...n.everIn].some((s) => canReadIn(m, w, s)));

export function subtreeOf(m: Model, root: MNote): MNote[] {
  const out = [root];
  for (let i = 0; i < out.length; i++) out.push(...m.notes.filter((n) => n.parent === out[i]!.id));
  return out;
}

/** The ancestors of a note, nearest first. */
export function modelAncestorsOf(m: Model, n: MNote): MNote[] {
  const out: MNote[] = [];
  for (let p = m.notes.find((x) => x.id === n.parent); p; p = m.notes.find((x) => x.id === p!.parent)) out.push(p);
  return out;
}

/** Move a note with its subtree to another space (the owner's move, spaces.md). */
export function moveSubtree(m: Model, n: MNote, toSpace: string): void {
  for (const a of modelAncestorsOf(m, n)) a.lostChild = true;
  for (const d of subtreeOf(m, n)) { d.space = toSpace; d.everIn.add(toSpace); }
  n.parent = null;
}

/** Delete a note and its live subtree; each carries the root's id for the restore. */
export function deleteSubtree(m: Model, n: MNote): void {
  for (const d of subtreeOf(m, n).filter((x) => !x.deleted)) { d.deleted = true; d.deletedBy = n.id; }
}

/** Restore what the delete of `n` took to the trash. */
export function undeleteSubtree(m: Model, n: MNote): void {
  for (const d of m.notes.filter((x) => x.deletedBy === n.id)) { d.deleted = false; d.deletedBy = null; }
}
