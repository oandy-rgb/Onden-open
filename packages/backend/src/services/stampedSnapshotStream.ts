// The wire form of a stamped snapshot: lines of JSON (NDJSON), one message each, so neither side holds more than a page.
//
//   {"kind":"hello","dataShape":<SYNC_DATA_SHAPE_VERSION>,"workspaceId":…,"source":…,"cut":…,"person":…}     first
//   {"kind":"page","page":{…}}  × N                                    pages of services/stampedSnapshot.ts
//   {"kind":"manifest","pages":N,"digest":[…]}                         last: what the pages must add up to
//   {"kind":"error","code":…}                                          instead of the manifest, when the source gave up half way
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

import { log } from "../logger.js";
import { CodedStatusError } from "../statusError.js";
import { AuthorityError, isWorkspaceOwner, requirePerson } from "../spine/authority.js";
import { requireActor } from "../spine/mutate.js";
import { SYNC_DATA_SHAPE_VERSION } from "../spine/syncDataShape.js";
import type { ActorCtx } from "../types.js";
import type { StampedPage, TableDigest } from "../spine/snapshotSql.js";
import { consumeFreshProof } from "./freshProof.js";
import { readStampedPages, snapshotSourceNode } from "./stampedSnapshot.js";
import { abandonJoin, applyJoinPage, databaseJoinReadiness, finishJoin, JOIN_NO_LOGIN, joinLoginOf, joinProgress, joinRefused, startJoin, type JoinReadiness } from "./stampedJoin.js";

/** One line may not be longer than this: a page is about 4 MiB plus one row; more is not a page. */
const MAX_SNAPSHOT_LINE_BYTES = 64 * 1024 * 1024;

type Message =
  | { kind: "hello"; dataShape: number; workspaceId: string; source: string; cut: number; person: string }
  | { kind: "page"; page: StampedPage }
  | { kind: "manifest"; pages: number; digest: TableDigest[] }
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
  const writer = writable.getWriter();
  let first!: () => void;
  const ready = new Promise<void>((resolve) => { first = resolve; });
  let sentHello = false;
  const run = readStampedPages(actor, workspaceId, { since: null, layer: "rows" }, async (page) => {
    if (!sentHello) {
      sentHello = true;
      await writer.write(line({ kind: "hello", dataShape: SYNC_DATA_SHAPE_VERSION, workspaceId, source: page.source, cut: page.cut, person: actor.id }));
    }
    await writer.write(line({ kind: "page", page }));
    first();
  }).then(
    async (summary) => { await writer.write(line({ kind: "manifest", pages: summary.pages, digest: summary.digest })); await writer.close(); first(); },
    async (error) => {
      if (!sentHello) throw error;
      await writer.write(line({ kind: "error", code: error instanceof CodedStatusError ? error.code : "snapshot_failed" }));
      await writer.close();
    },
  );
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

/** Fill this database's empty workspace from a snapshot stream (see the top). Returns how many pages and rows were applied. */
export async function importSnapshotStream(actor: ActorCtx, body: ReadableStream<Uint8Array> | null): Promise<{ pages: number; rows: number }> {
  await requireSnapshotOwner(actor);
  if (!body) throw joinRefused("join_no_body", "the upload has no body", 400);
  const login = await joinLoginOf(actor.id);
  if (login === null) throw joinRefused(JOIN_NO_LOGIN.code, JOIN_NO_LOGIN.message, 409);
  let join: { workspaceId: string } | null = null;
  let done = false;
  let pages = 0;
  try {
    for await (const text of linesOf(body)) {
      let message: Message;
      try { message = JSON.parse(text) as Message; } catch { throw joinRefused("join_bad_line", "a line of the upload is not a message"); }
      if (message.kind === "hello") {
        if (join) throw joinRefused("join_bad_line", "a second hello");
        // The first line says which data shape the pages have; nothing is read or written before it is the one this node speaks.
        if (message.dataShape !== SYNC_DATA_SHAPE_VERSION) {
          throw joinRefused("join_data_shape", message.dataShape === undefined
            ? "the file does not say which data shape it has, so it was not made by a version that can be read here"
            : `the file has data shape ${String(message.dataShape)}, this node has ${SYNC_DATA_SHAPE_VERSION}: make the file again on a device with the same version`, 409);
        }
        await startJoin({ workspaceId: message.workspaceId, sourceNode: message.source, cutSeq: message.cut, personActorId: message.person, shellPersonId: actor.id });
        join = { workspaceId: message.workspaceId };
      } else if (message.kind === "page") {
        if (!join) throw joinRefused("join_bad_line", "a page before the hello");
        await applyJoinPage(message.page);
        pages += 1;
      } else if (message.kind === "manifest") {
        if (!join || done) throw joinRefused("join_bad_line", "a manifest out of place");
        await finishJoin({ workspaceId: join.workspaceId, pages: message.pages, digest: message.digest, localLogin: login });
        done = true;
      } else {
        throw joinRefused("join_source_failed", "the source stopped before the end of the snapshot");
      }
    }
    if (!done) throw joinRefused("join_incomplete", "the upload ended before the end of the snapshot");
    log.info("snapshot", "a snapshot filled this database's workspace", { workspaceId: join!.workspaceId, actorId: actor.id, pages });
    return { pages, rows: (await joinProgress(join!.workspaceId))?.rowsApplied ?? 0 };
  } catch (error) {
    if (join && !done) await abandonJoin(join.workspaceId).catch(() => undefined);
    throw error;
  }
}
