// The one way a device takes the server's answer about a note's place back
// after its own optimistic change was refused, or was answered differently
// than it was drawn (a move to a note's own descendant, a delete of a note the
// server already deleted, a parent the server read as "top level").
//
// Why a read and not "put back what I remember": the device drew the change
// before the server answered, the sync cursor has moved on, and no later delta
// repairs a row whose server value did not change. The server's current row
// (or its absence) is the only value that is right whatever happened meanwhile.
// Callers: the note writer when a write is refused (noteWriter.ts) and the
// queue when a replayed write is refused or answered differently (writeQueue.ts).

import { READ_HEAD_HEADER, READ_SERVER_HEADER } from "@onden/markdown/contract";
import { api, ApiError, readWithDeadline, type Bootstrap, type ContentNode } from "../api";
import { forgetBody, forgetCopyWatermark, persistRemoteNode, removeNode, type AnswerRefusal } from "../localDb";
import { addToast, getNode } from "../appStore";
import { dictionariesReady, t } from "../i18n";
import { askedNow, forgetWatermark, holdWrites, takeAnswer, type AnswerOutcome } from "./writePositions";
import type { AdoptBody } from "./syncEngine";
import { later, readAgain } from "./serverTruthLoad";
import { ASK_AGAIN_AT_MOST } from "../answerPositions";
import { getLocalCopyState } from "../localCopyState";
import { dropNode, patchNode, serverCopyOver } from "./storeOps";

type SetData = (update: (state: Bootstrap) => Bootstrap) => void;

/** True when the server's row (or the note's absence) is now what the screen
 *  and the local copy show; false when the server could not be asked (offline,
 *  a server error), so the caller keeps whatever it has. */
export async function settleNodeToServer(id: string, setData: SetData): Promise<boolean> {
  let outcome: AnswerOutcome;
  try {
    outcome = await readServerNode(id, (taken) => {
      // Where the note is (not its text).
      setData((state) => patchNode(state, id, { parent_id: taken.parent_id ?? null, order_key: taken.order_key, order_stamp: taken.order_stamp, ...(taken.hidden === undefined ? {} : { hidden: taken.hidden }) }));
    });
  } catch (error) {
    // The server answered that the note is not there for this person (gone, or not readable).
    if (error instanceof ApiError && [403, 404, 410].includes(error.status)) {
      setData((state) => dropNode(state, id));
      await removeNode(id).catch(() => null);
      return true;
    }
    return false;
  }
  // A read taken before a write this device was told about is asked again (readServerNode); still refused, sync() reads
  // the note again later (syncEngine readAgain).
  return outcome === "taken";
}

/** The one way a single note read from the server (GET /api/nodes/:id) reaches the local copy and the store: judged by
 *  where it was read (READ_HEAD_HEADER, lib/data/writePositions.ts takeAnswer). The local copy stores it (the worker
 *  projects text a person still has queued onto it); `toStore` puts it on the screen. Errors are the request's
 *  (ApiError for an answer that refuses). A read taken before an acknowledged write is asked again while new writes wait
 *  (holdWrites), ASK_AGAIN_AT_MOST times at most; still refused, or an ask again that did not come back, a sync a little
 *  later reads the note again (syncEngine readAgain). Read below what this device knew when it was asked for ("lost":
 *  the server went back), the sync is asked for at once: it judges by its own answer and rebuilds. */
async function readServerNode(id: string, toStore: (row: ContentNode) => void): Promise<AnswerOutcome> {
  let release: (() => void) | undefined;
  try {
    for (let attempt = 1; ; attempt++) {
      let head: string | undefined;
      const asked = askedNow();
      let serverId: string | undefined;
      const read = (signal?: AbortSignal) => api<ContentNode>(`/api/nodes/${id}`, { ...(signal ? { signal } : {}), onHeaders: (headers) => {
        head = headers.get(READ_HEAD_HEADER) ?? undefined;
        serverId = headers.get(READ_SERVER_HEADER) ?? undefined;
      } });
      // An ask again holds every new write (holdWrites below): it has the read deadline, so a stuck GET cannot hold them.
      const value = attempt === 1 ? await read() : await readWithDeadline(read);
      const outcome = await takeAnswer({
        head, serverId, asked,
        toCopy: async () => {
          const stored: ContentNode & AnswerRefusal = await persistRemoteNode(value, head, serverId).catch(() => value);
          return { value: stored, stale: stored.answer_stale === true, copy: stored };
        },
        toStore: (stored) => toStore(stored),
      });
      // The proof is kept (the rebuild owed, the person told, a pass asked for: serverLostItsWrites): by the time a later
      // sync runs the head may be past every position this device knows, and nothing would find it again.
      if (outcome === "lost") { await serverLostItsWrites(); readAgain.add(id); return outcome; }
      // Another identity: no word to the person; the pass asked for now rebuilds first (the copy counts in the old log).
      if (outcome === "changed") { readAgain.add(id); later.again(); return outcome; }
      if (outcome !== "stale") { refusedRounds.delete(id); return outcome; }
      if (attempt >= ASK_AGAIN_AT_MOST) {
        // Read again in a sync a little later (this device's own write sends no change tick that would start one), later
        // each round, and not after READ_AGAIN_ROUNDS: then the note waits for its next change or for being opened again.
        const round = (refusedRounds.get(id) ?? 0) + 1;
        refusedRounds.set(id, round);
        if (round <= READ_AGAIN_ROUNDS) {
          readAgain.add(id);
          const timer = setTimeout(() => { askLater.delete(timer); later.sync(); }, 2_000 * 2 ** (round - 1));
          askLater.add(timer);
        }
        return outcome;
      }
      release ??= holdWrites();
    }
  } catch (error) {
    // The server's answer that the note is not there for this person ends its rounds; an ask again that did not come
    // back (the read deadline, the network) leaves the note for a later sync.
    if (error instanceof ApiError && [403, 404, 410].includes(error.status)) refusedRounds.delete(id);
    else if (release) readAgain.add(id);
    throw error;
  } finally { release?.(); }
}

/** How many times in a row a note's reads were all refused (readServerNode), and how many such rounds are asked again. */
const refusedRounds = new Map<string, number>();
const READ_AGAIN_ROUNDS = 4;
/** The syncs those rounds asked for and that have not run yet. */
const askLater = new Set<ReturnType<typeof setTimeout>>();
later.forgetRounds = () => {
  refusedRounds.clear();
  for (const timer of askLater) clearTimeout(timer);
  askLater.clear();
};

/** syncEngine.hydrateNode's read of the server's row, after it showed the body this device stored (`stored`, or null).
 *  Only a row nothing else changed since this read began is replaced (its text is still `before`, or the stored body):
 *  a save made meanwhile is newer than a response that may have been read before it. */
export async function readNoteFromServer(id: string, before: string | undefined, stored: string | null, adoptBody: AdoptBody): Promise<void> {
  try {
    await readServerNode(id, (full) => {
      // Nor a field with an edit still waiting for its answer (storeOps.serverCopyOver): kept, and the note read again
      // once that edit has its answer (syncEngine.readAgainWhenAnswered, the same as a delta's or a bootstrap's row).
      const copy = serverCopyOver(full, getNode(id));
      if (copy.held) later.readWhenAnswered(id);
      adoptBody(id, (row) => row.markdown === before || (stored !== null && row.markdown === stored), copy.row);
    });
  } catch (error) {
    // A refusal (no access, gone) is the server's answer: take back a local copy shown from this device, in memory and
    // in the offline mirror, rather than keep displaying a note the server no longer serves. A 401 is the session, not
    // the note: the sign-in gate handles it and the copy stays. Offline / unreachable: the stored body (or slim row) stays.
    if (stored !== null && error instanceof ApiError && [403, 404, 410].includes(error.status)) {
      adoptBody(id, (row) => row.markdown === stored, { markdown: "" }, (stored.length || 1));
      void forgetBody(id).catch(() => null);
    }
  }
}

/** The one path after the server went back (lib/data/writePositions.ts serverWentBack; syncEngine's sync loop and
 *  takeBootstrap, which then rebuild from a whole bootstrap): the copy's watermark starts over and the copy owes a
 *  rebuild until a whole bootstrap is stored, so a reload or a failed bootstrap still owes it (each sync pass starts
 *  with it). A failure throws (the pass fails; the next finds the same evidence), and the page keeps its own watermark:
 *  a page that started over while the copy did not would have every bootstrap refused. Then the page's starts over,
 *  and the person is told that something saved recently may be
 *  missing on the server, once per going back: the copy says whether it owed one already (with no copy, every pass is a
 *  whole bootstrap, so each going back is found once). */
export async function serverLostItsWrites(askForPass = true): Promise<void> {
  const told = getLocalCopyState() !== "none" && (await forgetCopyWatermark()).alreadyOwed;
  forgetWatermark();
  // The rebuild and the membership check behind the gate start now, not at whatever sync comes next (a bootstrap or a
  // single read found it outside the loop, or a pass already past its start). The sync loop rebuilds there and then.
  if (askForPass) later.again();
  if (told) return;
  await dictionariesReady().catch(() => {});
  addToast(t("The server's copy is older than this device's last save: check your recent notes."), "warning");
}
