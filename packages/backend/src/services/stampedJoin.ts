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

import { applyStampedPage, beginJoin, cancelJoin, joinRefused, markJoinDone, readJoinProgress, type JoinInput } from "../spine/stampedImport.js";
import type { StampedPage, TableDigest } from "../spine/snapshotSql.js";

export type { StampedPage, JoinInput };
export { joinRefused };

export const startJoin = (input: JoinInput): Promise<void> => beginJoin(input);
export const applyJoinPage = (page: StampedPage): Promise<{ applied: boolean }> => applyStampedPage(page);
export const abandonJoin = (workspaceId: string): Promise<void> => cancelJoin(workspaceId);
export const joinProgress = readJoinProgress;

/** Every page is in and the database holds what the source said it sent: the comparison and "done" are ONE transaction in the entry
 *  (spine/stampedImport.ts markJoinDone), so this service reads nothing of its own. */
export const finishJoin = (input: { workspaceId: string; pages: number; digest: TableDigest[]; localLogin: string | null }): Promise<void> =>
  markJoinDone(input.workspaceId, { pages: input.pages, digest: input.digest }, input.localLogin);
