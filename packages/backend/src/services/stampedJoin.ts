// Filling an empty database from a stamped snapshot (services/stampedSnapshot.ts is the other half): the one place that calls the
// protected import entry (spine/stampedImport.ts) and the only thing a route calls.
//
//   const join = await startJoin({ workspaceId, sourceNode, cutSeq, personActorId, shellPersonId });
//   for each page, in the order the source made them: await applyJoinPage(page)   // a page again with the same content is a no-op
//   await finishJoin({ workspaceId, pages, digest, localLogin})    // every page in, digests equal → the workspace is the database's
//   (or) await abandonJoin(workspaceId)                  // nothing of the snapshot stays; the empty database, with the same person, is usable at once
//
// A BROWSER SHELL as the receiver (browser/prepareSnapshot.ts's database, the test in stampedSnapshot.integration.test.ts): the join is
// refused with `join_not_empty` while ANY note of the person's own is there, in the trash too, and a first open makes sample notes
// (browser/sampleNotes.ts). So the layer that offers "add this device" has to do, before startJoin: skip making the samples when the
// database is not used yet, or purge them for good (the trash is not enough). Its one local sign-in (the auth account's id) is passed as
// `localLogin` to finishJoin and opens the snapshot's person afterwards. No UI is built here.
//
// A finish whose digests differ throws and leaves the join open: the caller abandons it (a half-filled workspace is never used).

import { db } from "../dbKysely.js";
import { withTransaction } from "../db.js";
import { applyStampedPage, beginJoin, resumeChangeBundles, cancelJoin, decideJoin, joinRefused, markJoinDone, readJoinProgress, readJoinRemoval, type JoinInput, type JoinRemoval } from "../spine/stampedImport.js";
import type { StampedPage, TableDigest } from "../spine/snapshotSql.js";

export type { StampedPage, JoinInput, JoinRemoval };
export { joinRefused };

/** The sign-in this person uses on this device (the snapshot names the person's row, never a login: it cannot make anyone else's). Without one
 *  nobody could open the workspace after a join, so a join is refused before anything is read. */
export const JOIN_NO_LOGIN = { code: "join_no_login", message: "this person has no sign-in on this device, so nobody could open the workspace afterwards" } as const;
export async function joinLoginOf(actorId: string): Promise<string | null> {
  return (await db.selectFrom("actors").select("external_id").where("id", "=", actorId).executeTakeFirst())?.external_id ?? null;
}

/** What `GET /api/snapshot/readiness` answers: whether a join would be accepted now, with the refusal a join would give (`code`, and for a not-empty
 *  database `kind`, a stable code from spine/stampedImport.ts and never text for a person), and what this database's workspace holds of a person's own,
 *  all of which an accepted join deletes (counts only; a refused join deletes nothing). Nothing is changed. While a join RUNS the database has no
 *  owner to ask, so that one answer carries nothing else: `{ ready: false, code: "join_in_progress" }`. Two refusals depend on the file and are given
 *  when it is read: a file made on this very device (`join_from_self`) and a data shape of another version (`join_data_shape`). */
export type JoinReadiness =
  | { ready: true; holds: JoinRemoval }
  | { ready: false; code: "join_in_progress" }
  | { ready: false; code: string; kind: string | null; holds: JoinRemoval };

/** The database's own answer, whoever asks: what the join would decide and what it would delete (services/stampedSnapshotStream.ts adds who may ask). */
export async function databaseJoinReadiness(): Promise<JoinReadiness> {
  return withTransaction(async () => {
    const decision = await decideJoin(null);
    if (decision.ready) return { ready: true, holds: await readJoinRemoval() };
    if (decision.code === "join_in_progress") return { ready: false, code: decision.code };
    return { ready: false, code: decision.code, kind: decision.kind, holds: await readJoinRemoval() };
  });
}

export const startJoin = (input: JoinInput): Promise<void> => beginJoin(input);
export const applyJoinPage = (page: StampedPage): Promise<{ applied: boolean }> => applyStampedPage(page);
export const abandonJoin = (workspaceId: string): Promise<void> => cancelJoin(workspaceId);
export const joinProgress = readJoinProgress;

/** Every page is in and the database holds what the source said it sent: the comparison and "done" are ONE transaction in the entry
 *  (spine/stampedImport.ts markJoinDone), so this service reads nothing of its own. */
export const finishJoin = (input: { workspaceId: string; pages: number; digest: TableDigest[]; localLogin: string | null }): Promise<void> =>
  markJoinDone(input.workspaceId, { pages: input.pages, digest: input.digest }, input.localLogin);

/** A change bundle a previous process was taking in segments goes on from the node-local inbox by itself, never waiting for its sender (spine/stampedImport.ts
 *  resumeChangeBundles; migration 228). The node's start-up and a timer call it (server.ts): the operator is this node, going on with a bundle it already checked and
 *  planned, as the inbox's system job. An empty inbox costs one SELECT. */
export const resumeReceivedChangeBundles = (): ReturnType<typeof resumeChangeBundles> => resumeChangeBundles();
