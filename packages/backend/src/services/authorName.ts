// Who a reader says wrote something, when the author was a temporary session.
//
// The EVIDENCE that an author id was a session's is this node's own `actors` row of type 'session'. That row is kept for as long as anything names the
// id: a session is ended, never removed (the database refuses deleting it or changing its type: migration 217; services/actors.ts removeActor refuses it too; the invariant is
// named in guards/neverLeaves.guard.test.ts and tested in sessionActorKept.integration.test.ts). So a reader joins `actors` as it always did and asks
// the joined row's type; nothing is guessed from the shape of an id.
//
// What is NOT evidence: an id with no `actors` row. That is a removed person or AI (removeActor deletes the row; migration 071's domain_events_actor_ref
// checks only at INSERT, so their old events keep the id), and every reader shows it as it did before sessions existed: no name, the kind the event
// itself recorded ("Someone", "AI" on the screen). A session's write that came from ANOTHER node cannot be told apart from that on this node: the
// session's `actors` row never leaves the node it was opened on (spine/snapshotTables.json `neverLeaves`), and today such a write's EVENT is not taken
// in at all (unknownAuthor.integration.test.ts pins the refusal), only its stamps, whose author no reader names. It is shown like a removed member.
//
// The reader sends a KIND ('session') and no name; the screen words it in the reader's language (docs/decisions/ui-no-technical-details.md). The
// session's `actors.name` is not sent to these readers, and a backup writes no name for it (backupHistory.ts): a label is not a person's name.
//
// Used by: a note's versions (history/noteVersions.ts), a drawing's versions and edits (nodeReads.ts, history/inkChanges.ts), the day's activity
// (history/activity.ts), a day's rewinds (history/rewind.ts) and the history a backup writes (backupHistory.ts).

import { isSessionActorType } from "../spine/authority.js";

/** `actors.type` of the joined row (null: this node holds no row for the author). */
type AuthorRowType = string | null | undefined;

/** The author was a temporary session of this node (see the header for the evidence). */
const authorWasSession = (rowType: AuthorRowType): boolean => isSessionActorType(rowType);

/** The name a reader sends: the joined name, or null for a session (the screen words it from the kind) and for an author this node holds no row for. */
export function shownAuthorName(rowType: AuthorRowType, name: string | null | undefined): string | null {
  return authorWasSession(rowType) ? null : name ?? null;
}

/** A saved version's author: a version carried in from a backup (`imported`: tx_meta.history_import) names its source's author or no one (a removed
 *  member, a temporary session), never the joined row, which is the person who carried it in. `rowName`/`rowType` are the joined `actors` row. */
export function versionAuthor(row: { imported: boolean; import_name: string | null; row_name: string | null; row_type: string | null }): { name: string | null; rowType: string | null } {
  return row.imported ? { name: row.import_name, rowType: null } : { name: row.row_name, rowType: row.row_type };
}

/** The kind a reader sends: 'session' for a session's write, otherwise the kind the reader already worked out (from the event's own actor_type). */
export function shownAuthorKind<K extends string>(rowType: AuthorRowType, kind: K): K | "session" {
  return authorWasSession(rowType) ? "session" : kind;
}
