// The wire form of a stamped snapshot: lines of JSON (NDJSON), one message each, so neither side holds more than a page.
//
//   {"kind":"hello","workspaceId":…,"source":…,"cut":…,"person":…}     first
//   {"kind":"page","page":{…}}  × N                                    pages of services/stampedSnapshot.ts
//   {"kind":"manifest","pages":N,"digest":[…]}                         last: what the pages must add up to
//   {"kind":"error","code":…}                                          instead of the manifest, when the source gave up half way
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

import { db } from "../dbKysely.js";
import { log } from "../logger.js";
import { CodedStatusError } from "../statusError.js";
import { AuthorityError, isWorkspaceOwner, requirePerson } from "../spine/authority.js";
import type { ActorCtx } from "../types.js";
import type { StampedPage, TableDigest } from "../spine/snapshotSql.js";
import { readStampedPages } from "./stampedSnapshot.js";
import { abandonJoin, applyJoinPage, finishJoin, joinProgress, joinRefused, startJoin } from "./stampedJoin.js";

/** One line may not be longer than this: a page is about 4 MiB plus one row; more is not a page. */
const MAX_SNAPSHOT_LINE_BYTES = 64 * 1024 * 1024;

type Message =
  | { kind: "hello"; workspaceId: string; source: string; cut: number; person: string }
  | { kind: "page"; page: StampedPage }
  | { kind: "manifest"; pages: number; digest: TableDigest[] }
  | { kind: "error"; code: string };

const encoder = new TextEncoder();
const line = (message: Message) => encoder.encode(`${JSON.stringify(message)}\n`);

async function requireOwner(actor: ActorCtx): Promise<void> {
  requirePerson(actor, "snapshot");
  if (!(await isWorkspaceOwner(actor))) throw new AuthorityError("snapshot", "only the owner of the workspace can copy it to another device");
}

/** The snapshot of `workspaceId` as the owner reads it, as a stream of lines. A refusal before the first page (not the owner, a
 *  database with another node's stamps …) is thrown here, so the route answers it with its status; one after it ends the stream
 *  with an `error` line instead of a manifest, which an importer takes as "not complete". */
export async function exportSnapshotStream(actor: ActorCtx, workspaceId: string): Promise<ReadableStream<Uint8Array>> {
  await requireOwner(actor);
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
      await writer.write(line({ kind: "hello", workspaceId, source: page.source, cut: page.cut, person: actor.id }));
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
  await requireOwner(actor);
  if (!body) throw joinRefused("join_no_body", "the upload has no body", 400);
  // The sign-in this person uses here: the snapshot names the person's row, never a login (it cannot make anyone else's).
  const login = (await db.selectFrom("actors").select("external_id").where("id", "=", actor.id).executeTakeFirst())?.external_id ?? null;
  // Without a sign-in of its own there is nobody who could open the workspace after the import: refused, not silently filled.
  if (login === null) throw joinRefused("join_no_login", "this person has no sign-in on this device, so nobody could open the workspace afterwards", 409);
  let join: { workspaceId: string } | null = null;
  let done = false;
  let pages = 0;
  try {
    for await (const text of linesOf(body)) {
      let message: Message;
      try { message = JSON.parse(text) as Message; } catch { throw joinRefused("join_bad_line", "a line of the upload is not a message"); }
      if (message.kind === "hello") {
        if (join) throw joinRefused("join_bad_line", "a second hello");
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
