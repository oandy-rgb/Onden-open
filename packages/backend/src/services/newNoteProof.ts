// "This note is being made in this write": what lets a write carry 「不發布」 onto a note for anyone (services/attributeChange.ts
// assertActorMayWriteAttributeKey: a note made under a 「不發布」 note, a copy of one, an imported file that says so). A boolean any caller could
// set said it before; one call site set it on an EXISTING note (PR #1856 review round 6). Now the writer must hand over a proof for that very note,
// and a proof is minted only where a note is inserted: createNote (services/noteCreate.ts), a copy (services/noteDuplicate.ts) and a template's
// slot (services/templateExpander.ts) — attributeWriters.test.ts pins those three — each right after its INSERT, for the id it inserted.
//   const proof = newNoteProof(id);                    // right after the insert of the note with that id
//   await applyParentSiteDefault(ws, parentId, id, actor, eventId, proof);
//   createNote({ …, afterDerived: async ({ nodeId, newNote }) => setNodeAttribute({ …, nodeId, attribute: KEPT_OFF_SITE, newNote }) });

/** The proofs this module minted: a proof is one of these objects, so no code can make one for another id (round 7: a symbol brand could be
 *  read off a proof with Object.getOwnPropertySymbols and copied). */
const minted = new WeakSet<object>();
declare const brand: unique symbol;

/** A note inserted in the current write (its id). Only `newNoteProof` makes one. */
export type NewNoteProof = { readonly nodeId: string; readonly [brand]: true };

/** Mint the proof for the note this code just inserted. Call only right after the INSERT, with the id inserted (the callers are pinned). */
export function newNoteProof(nodeId: string): NewNoteProof {
  const proof = Object.freeze({ nodeId }) as unknown as NewNoteProof;
  minted.add(proof);
  return proof;
}

/** Is `proof` one this module minted, for `nodeId`? A look-alike object, or a proof for another note, is not. */
export function provesNewNote(proof: NewNoteProof | undefined, nodeId: string): boolean {
  return !!proof && minted.has(proof) && proof.nodeId === nodeId;
}
