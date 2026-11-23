// The wire form of a stamped snapshot: lines of JSON (NDJSON), one message each, so neither side holds more than a page.
//
//   {"kind":"hello","dataShape":<SYNC_DATA_SHAPE_VERSION>,"workspaceId":…,"source":…,"former":{…},"brought":{…},"cut":…,"person":…}     first (`former`, `brought`: StampedPage's)
//   {"kind":"page","page":{…}}  × N                                    the rows: pages of services/stampedSnapshot.ts readStampedPages
//   {"kind":"rows-done","pages":N,"digest":[…]}                        what the rows must add up to: the receiver's notes are complete and in use from here
//   {"kind":"page","page":{…}}  × H                                    the history part (layers `blobs`, `history`): readHistoryPages, numbered from 1
//   {"kind":"manifest","pages":N,"digest":[…],"history":{"pages":H,"digests":{…},"inkBytes":…},"bytes":{"rows":…,"history":…}}   last: the rows' numbers again, what the
//                                                                      history part adds up to, and how many bytes of the file each part is (`bytes`: for the receiving
//                                                                      screen's room estimate only, BringNotes.tsx; nothing is checked against it)
//   {"kind":"error","code":…}                                          instead of the rest, when the source gave up half way
//
// THE EARLIER VERSIONS AFTER THE NOTES (history-replication proposal §3.1, data shape 9): the receiver finishes the join at `rows-done` (the notes are usable at once)
// and takes the history part after it. A stream that stops in the history part leaves the notes in and the history part as far as it came (sync_join.history_through);
// the SAME FILE uploaded again goes on from there: its rows pages are checked against the ones held and not written again, the history pages held are no-ops
// (a content page again writes back what the cleanup took meanwhile). Once the notes are in, a refusal of the history part does not undo them and is no error
// of the upload: the answer is 200 and says the notes are in and why the earlier versions are not (`historyRefused`, a code); the person can give the same file
// again, make a new one, or stop waiting (POST /api/snapshot/history/stop, giveUpHistory).
//
// A DEVICE WITHOUT THE EARLIER VERSIONS (joined before migration 229, or the person stopped waiting: history_state `missing` / `given_up`) takes a file of the SAME
// source as a refill: its rows are read past and never written or compared (the notes stay as they are; the file may be newer than them), and at `rows-done` the
// history part starts again from page 1 under that file's header (spine/stampedImport.ts beginHistoryRefill). Such a device is no snapshot source until it is done.
//
// EVERY LINE STARTS WITH `"kind":` (`line()` builds it first, stampedSnapshotTwoProcess.integration.test.ts fails when one does not): a reader may
// look at the first bytes of a line to tell its kind apart without parsing a page. The `dataShape` of the hello is the version of what the
// pages mean (spine/syncDataShape.ts); a file that names none, or another one, is refused at its first line (`join_data_shape`).
//
// exportSnapshotStream is the source side (owner only), importSnapshotStream the receiver's (owner of the empty workspace only):
// it starts a join on the hello, applies each page, and finishes on the manifest; a refusal or a stream that ends early abandons
// the join, so what it leaves is the empty database (and the empty workspace is made again at once). Both are what the two owner-only
// routes call; they add nothing else.
//
// WHO BECOMES WHO: the one who uploads is the owner of this (empty) database, and after the import their sign-in opens the workspace as the
// person the hello names, with that person's role in the snapshot. The hello is request content, so it could name any human of the
// snapshot; that is accepted because only the owner of an empty database can import, and the owner can already do anything on this
// machine. The person must be a human of the snapshot (checked at the end); no other person gets a sign-in. A person without a sign-in
// here (an administrator with no login) is refused, because nobody could open the workspace afterwards.

import { isUuid } from "@onden/markdown";
import { log } from "../logger.js";
import { CodedStatusError } from "../statusError.js";
import { AuthorityError, isWorkspaceOwner, requirePerson } from "../spine/authority.js";
import { requireActor } from "../spine/mutate.js";
import { SYNC_DATA_SHAPE_VERSION } from "../spine/syncDataShape.js";
import type { ActorCtx } from "../types.js";
import type { StampedPage, TableDigest } from "../spine/snapshotSql.js";
import type { HistoryDigests, HistoryPage } from "../spine/historyLayer.js";
import { consumeFreshProof } from "./freshProof.js";
import { readHistoryPages, readStampedPages, snapshotSourceNode } from "./stampedSnapshot.js";
import {
  abandonJoin, applyJoinPage, databaseJoinReadiness, finishHistory, finishJoin, JOIN_NO_LOGIN, joinLoginOf, joinProgress, joinRefused, rowsPageHeld, startHistoryRefill, startJoin,
  stopWaitingForHistory, type JoinReadiness,
} from "./stampedJoin.js";

/** One line may not be longer than this: a page is about 4 MiB plus one row; more is not a page. */
const MAX_SNAPSHOT_LINE_BYTES = 64 * 1024 * 1024;

type Message =
  | { kind: "hello"; dataShape: number; workspaceId: string; source: string; former?: Record<string, number>; brought?: Record<string, Record<string, number>>; cut: number; person: string }
  | { kind: "page"; page: StampedPage | HistoryPage }
  | { kind: "rows-done"; pages: number; digest: TableDigest[] }
  | { kind: "manifest"; pages: number; digest: TableDigest[]; history: { pages: number; digests: HistoryDigests; inkBytes: number }; bytes?: { rows: number; history: number } }
  | { kind: "error"; code: string };

async function requireSnapshotOwner(actor: ActorCtx): Promise<void> {
  requirePerson(actor, "snapshot");
  if (!(await isWorkspaceOwner(actor))) throw new AuthorityError("snapshot", "only the owner of the workspace can copy it to another device");
}

/** Whether this database would accept a snapshot now, and what that would delete; changes nothing (GET /api/snapshot/readiness). While a join runs the
 *  answer is `join_in_progress` for anyone (there is no owner to ask, and a page must know to hold the app back); otherwise owner only, like the join
 *  itself. A person with no sign-in here is answered with the refusal the import gives before it reads a line. Two refusals depend on the file and come
 *  when it is read: a file made on this very device (`join_from_self`) and another data shape (`join_data_shape`). */
export async function snapshotReadiness(actor: ActorCtx | null): Promise<JoinReadiness> {
  const answer = await databaseJoinReadiness();
  if (!answer.ready && answer.code === "join_in_progress") return answer;
  const person = requireActor(actor);
  await requireSnapshotOwner(person);
  return (await joinLoginOf(person.id)) === null && "holds" in answer ? { ready: false, code: JOIN_NO_LOGIN.code, kind: null, holds: answer.holds } : answer;
}

const encoder = new TextEncoder();
// `kind` is written first by construction: the object is made with it in front, and a later key cannot move it.
const line = ({ kind, ...rest }: Message) => encoder.encode(`${JSON.stringify({ kind, ...rest })}\n`);

/** The snapshot of `workspaceId` as the owner reads it, as a stream of lines. A refusal before the first page (not the owner, a
 *  database with another node's stamps …) is thrown here, so the route answers it with its status; one after it ends the stream
 *  with an `error` line instead of a manifest, which an importer takes as "not complete". */
export async function exportSnapshotStream(actor: ActorCtx, workspaceId: string, freshProofTicket: string | null | undefined): Promise<ReadableStream<Uint8Array>> {
  await requireSnapshotOwner(actor);
  // A ticket is spent only when the data is about to leave: whatever can be refused before that (a database that holds another device's stamps) is
  // refused first, so it does not use up the password the person just typed. The same check opens the read itself (services/stampedSnapshot.ts).
  await snapshotSourceNode(workspaceId);
  // The owner's own session is not enough for the whole workspace: it must carry a ticket from a fresh confirmation (services/freshProof.ts), spent here,
  // after the owner check (a non-owner burns nobody's ticket) and before anything is read.
  // A ticket spent here is NOT given back if the stream then fails: the person confirms again. That is deliberate (a refund would make a failing
  // request a way to keep a ticket alive); do not change it to refund on failure.
  await consumeFreshProof(actor, "snapshot_export", freshProofTicket);
  // The whole workspace in plain text leaves here: the server's log says who and when (a backup download leaves no event either, so this is the record).
  log.info("snapshot", "the owner read a snapshot of the workspace", { workspaceId, actorId: actor.id });
  // A few lines may wait in the stream before the consumer reads (a readable side of size 0 would not let the first line out before a reader came).
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>(undefined, undefined, new CountQueuingStrategy({ highWaterMark: 4 }));
  const sink = writable.getWriter();
  // the bytes of each part of the file, for the manifest (`bytes`): the hello, rows pages and rows-done are the rows part, the pages after it the history part
  const bytes = { rows: 0, history: 0 };
  let part: keyof typeof bytes = "rows";
  const writer = { write: (chunk: Uint8Array) => { bytes[part] += chunk.byteLength; return sink.write(chunk); }, close: () => sink.close() };
  let first!: () => void;
  const ready = new Promise<void>((resolve) => { first = resolve; });
  let sentHello = false;
  const rows = readStampedPages(actor, workspaceId, { since: null, layer: "rows" }, async (page) => {
    if (!sentHello) {
      sentHello = true;
      await writer.write(line({ kind: "hello", dataShape: SYNC_DATA_SHAPE_VERSION, workspaceId, source: page.source, former: page.former, brought: page.brought, cut: page.cut, person: actor.id }));
    }
    await writer.write(line({ kind: "page", page }));
    first();
  });
  const fail = async (error: unknown) => {
    await writer.write(line({ kind: "error", code: error instanceof CodedStatusError ? error.code : "snapshot_failed" }));
    await writer.close();
  };
  const run = (async () => {
    let summary: Awaited<typeof rows>;
    try { summary = await rows; } catch (error) {
      if (!sentHello) throw error;
      return fail(error);
    }
    try {
      await writer.write(line({ kind: "rows-done", pages: summary.pages, digest: summary.digest }));
      first();
      part = "history";
      const history = await readHistoryPages(actor, workspaceId, { cut: summary.cut }, async (page) => { await writer.write(line({ kind: "page", page })); });
      await writer.write(line({ kind: "manifest", pages: summary.pages, digest: summary.digest, history, bytes: { ...bytes } }));
      await writer.close();
    } catch (error) {
      await fail(error);
    }
  })();
  const settled = run.then(() => undefined); // rejects when the source refuses before its first page
  settled.catch(() => undefined); // (the race below delivers it when it matters; after a page, the stream carries the error)
  await Promise.race([ready, settled]);
  return readable;
}

async function* linesOf(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let pending = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) pending += decoder.decode(value, { stream: true });
    for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) {
      const text = pending.slice(0, at);
      pending = pending.slice(at + 1);
      if (text.trim()) yield text;
    }
    if (pending.length > MAX_SNAPSHOT_LINE_BYTES) throw joinRefused("join_line_too_long", "a snapshot line is longer than a page can be", 413);
    if (done) break;
  }
  if (pending.trim()) yield pending;
}

/** What taking a file did. `pages`, `rows`: the notes (always all of them when the answer is not an error; `pages` 0 when the notes were already here). `history`:
 *  where their earlier versions are (`done`; `arriving`: not all in yet: the same file again goes on; `missing`: this device has none of them, and this file did not
 *  start bringing them in: `historyRefused` says why); `historyScope`: `body` when this device keeps only the text history (the browser version over the
 *  drawings' threshold); `historyRefused`: the code of the refusal that stopped the history part, when one did (the notes stay in); `historyLeftOut`: versions the
 *  source holds without their content, so not sent. */
type SnapshotTaken = {
  pages: number; rows: number; historyPages: number; historyDone: boolean; history: "done" | "arriving" | "missing"; historyScope: "all" | "body"; historyLeftOut: number; historyRefused: string | null;
};

/** Fill this database's empty workspace from a snapshot stream (see the top), or bring in the rest of the history part of the same file. */
export async function importSnapshotStream(actor: ActorCtx, body: ReadableStream<Uint8Array> | null): Promise<SnapshotTaken> {
  await requireSnapshotOwner(actor);
  if (!body) throw joinRefused("join_no_body", "the upload has no body", 400);
  const login = await joinLoginOf(actor.id);
  if (login === null) throw joinRefused(JOIN_NO_LOGIN.code, JOIN_NO_LOGIN.message, 409);
  let join: { workspaceId: string } | null = null;
  let rowsDone = false;
  let historyDone = false;
  let historyRefused: string | null = null;
  /** What is done with the file's rows: written (a join), checked against what is held and never written again (the same file again, its history part stopped half
   *  way), or read past (a refill: a newer file of the same source; and the same refill file again). `notesHere`: the notes were here before this upload. */
  let rows: "apply" | "check" | "skip" = "apply";
  let notesHere = false;
  /** A refill to start at the file's `rows-done` (the header of its history part). */
  let refill: { source: string; cut: number; former?: Record<string, number>; brought?: Record<string, Record<string, number>> } | null = null;
  let pages = 0;
  let historyPages = 0;
  try {
   // Once the notes are on this device (they came with this file, or were here before it), whatever goes wrong with the rest is said, never thrown: the answer
   // is 200 with `historyRefused` and the state the database is really in, so no screen can say "nothing was kept" about notes that are here (review of
   // PR #1988, round 2, point 1). A line that is not a message there is a file cut short: a byte-level cut lands inside a line almost always.
   try {
    for await (const text of linesOf(body)) {
      let message: Message;
      try { message = JSON.parse(text) as Message; } catch {
        if (rowsDone || notesHere) throw joinRefused("join_history_file_cut", "the file ends in the middle of a line: it was cut short", 409);
        throw joinRefused("join_bad_line", "a line of the upload is not a message");
      }
      if (message.kind === "hello") {
        if (join) throw joinRefused("join_bad_line", "a second hello");
        // read first (a read only), so a refusal of this line on a device whose notes are here is answered as such
        const held = typeof message.workspaceId === "string" && isUuid(message.workspaceId) ? await joinProgress(message.workspaceId) : null;
        // this device's notes came from a file already: a refusal from here on leaves them as they are, and is answered as such (above)
        // (a device whose history is complete takes no file at all: join_already_done, as before)
        if (held?.state === "done" && held.historyState !== "done") { notesHere = true; join = { workspaceId: message.workspaceId }; }
        // The first line says which data shape the pages have; nothing is written before it is the one this node speaks.
        if (message.dataShape !== SYNC_DATA_SHAPE_VERSION) {
          throw joinRefused("join_data_shape", message.dataShape === undefined
            ? "the file does not say which data shape it has, so it was not made by a version that can be read here"
            : `the file has data shape ${String(message.dataShape)}, this node has ${SYNC_DATA_SHAPE_VERSION}: make the file again on a device with the same version`, 409);
        }
        if (held?.state === "done" && held.historyState === "arriving") {
          // another file than the one the history part comes from (a different source or cut) cannot finish it: it would be another copy
          if (held.sourceNode !== message.source || held.historyCut !== message.cut) throw joinRefused("join_history_other_file", "this is not the file this device took its notes from", 409);
          rows = held.historyRefill ? "skip" : "check";
          notesHere = true;
          rowsDone = true;
        } else if (held?.state === "done" && (held.historyState === "missing" || held.historyState === "given_up")) {
          if (held.sourceNode !== message.source) throw joinRefused("join_history_other_source", "this file was made on another device than the one this device took its notes from", 409);
          rows = "skip";
          notesHere = true;
          refill = { source: message.source, cut: message.cut, former: message.former, brought: message.brought };
        } else {
          // a device without its earlier versions given a file of another workspace: not a join (it holds notes), and not its source's file
          const now = await databaseJoinReadiness();
          if (!now.ready && now.code === "join_history_missing") throw joinRefused("join_history_other_source", "this file was made on another device than the one this device took its notes from", 409);
          await startJoin({ workspaceId: message.workspaceId, sourceNode: message.source, cutSeq: message.cut, personActorId: message.person, shellPersonId: actor.id, former: message.former, brought: message.brought });
        }
        join = { workspaceId: message.workspaceId };
      } else if (message.kind === "page") {
        if (!join) throw joinRefused("join_bad_line", "a page before the hello");
        const page = message.page;
        if (page?.layer === "rows") {
          if (rows === "skip") continue;
          if (rows === "check") {
            if (!(await rowsPageHeld(page))) throw joinRefused("join_page_changed", "this page number was already applied with other content", 409);
            continue;
          }
          if (rowsDone) throw joinRefused("join_bad_line", "a page of the notes after they were done");
          await applyJoinPage(page);
          pages += 1;
          continue;
        }
        if (!rowsDone) throw joinRefused("join_bad_line", "a page of the earlier versions before the notes were done");
        const refused = await historyStep(() => applyJoinPage(page));
        if (refused) { historyRefused = refused; break; }
        historyPages += 1;
      } else if (message.kind === "rows-done") {
        if (!join || (rowsDone && !notesHere)) throw joinRefused("join_bad_line", "the end of the notes out of place");
        if (refill) {
          const { workspaceId } = join, from = refill;
          refill = null;
          const refused = await historyStep(() => startHistoryRefill(workspaceId, from));
          if (refused) { historyRefused = refused; rowsDone = true; break; }
        } else if (!notesHere) await finishJoin({ workspaceId: join.workspaceId, pages: message.pages, digest: message.digest, localLogin: login });
        rowsDone = true;
      } else if (message.kind === "manifest") {
        if (!join || !rowsDone || historyDone || !message.history) throw joinRefused("join_bad_line", "a manifest out of place");
        const { workspaceId } = join;
        const refused = await historyStep(() => finishHistory({ workspaceId, pages: message.history.pages, digests: message.history.digests }));
        if (refused) { historyRefused = refused; break; }
        historyDone = true;
      } else if (rowsDone) {
        historyRefused = "join_history_source_failed";
        break; // the source gave up in the history part: the notes are in; the history part stays as far as it came
      } else {
        throw joinRefused("join_source_failed", "the source stopped before the end of the snapshot");
      }
    }
   } catch (error) {
    if (!(error instanceof CodedStatusError) || !join || !(rowsDone || notesHere)) throw error;
    historyRefused = error.code;
   }
    if (!rowsDone && !notesHere) throw joinRefused("join_incomplete", "the upload ended before the end of the snapshot");
    // the notes were here already and the file ended before its history part: nothing changed, and that is said, not thrown (the notes are not in question)
    // the file ended before its end (a cut at a line boundary): said, so the screen can say why the earlier versions are not all here
    if (!historyDone && !historyRefused && !(await joinProgress(join!.workspaceId).then((p) => p?.historyState === "done"))) historyRefused = "join_history_file_cut";
    const progress = await joinProgress(join!.workspaceId);
    const history = progress?.historyState === "done" ? "done" : progress?.historyState === "arriving" ? "arriving" : "missing";
    log.info("snapshot", notesHere ? `a snapshot brought in earlier versions (${history})` : history === "arriving" ? "a snapshot filled this database's workspace; its earlier versions are not all in yet" : "a snapshot filled this database's workspace",
      { workspaceId: join!.workspaceId, actorId: actor.id, pages, historyPages, historyRefused });
    return {
      pages, rows: progress?.rowsApplied ?? 0, historyPages, historyDone: history === "done", history,
      historyScope: progress?.historyScope ?? "all", historyLeftOut: progress?.historyLeftOut ?? 0, historyRefused,
    };
  } catch (error) {
    if (join && !rowsDone && !notesHere) await abandonJoin(join.workspaceId).catch(() => undefined);
    throw error;
  }
}

/** One step of the history part: its refusal (a code) does not undo the notes, so it is returned, not thrown; anything else is thrown as it is. */
async function historyStep(step: () => Promise<unknown>): Promise<string | null> {
  try { await step(); return null; } catch (error) {
    if (error instanceof CodedStatusError) return error.code;
    throw error;
  }
}

/** The owner stops waiting for the earlier versions of the notes this device took from a file (POST /api/snapshot/history/stop): what had arrived of them is
 *  removed and the notes stay. The device has no earlier versions then: it makes no file until a file of its source brings them in (a refill, above). Refused when
 *  nothing is arriving (`join_history_not_arriving`). */
export async function stopWaitingForSnapshotHistory(actor: ActorCtx, workspaceId: string): Promise<{ removed: number }> {
  await requireSnapshotOwner(actor);
  const result = await stopWaitingForHistory(actor, workspaceId);
  log.info("snapshot", "the owner stopped waiting for the earlier versions of a snapshot", { workspaceId, actorId: actor.id, removed: result.removed });
  return result;
}
