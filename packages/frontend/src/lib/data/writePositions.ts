// The page's half of lib/answerPositions.ts. One function, takeAnswer, is the only way an answer that carries rows
// (a sync delta, a membership page, a bootstrap of any kind) reaches the local copy and the store:
//   1. the page compares the answer's head with its own copy of the watermark — raised the moment a write's response
//      headers arrive (noteWriteResponse, before the writer reads the body), so it covers the window in which the local
//      copy is still busy and has not taken the acknowledgement in yet;
//   2. the local copy compares it with its own watermark (localDbWorker judgeAnswer: the same isCurrentAnswer) and
//      applies it or not;
//   3. the page compares again before the store takes it (an acknowledgement may have arrived while the copy worked);
//      if the copy took it and the page does not, the copy's cursor goes back so the next request carries everything.
// An answer that is not taken is asked for again. Liveness: after STALE_ANSWERS_BEFORE_WRITES_WAIT refusals in a row,
// the next write waits until an answer is taken or the sync pass ends (writes are in the local queue already: nothing is
// lost, nobody sees the wait).
// The server went back (serverWentBack): an answer read below what this device knew when its request LEFT, under the same
// identity. Every position known then was committed before the server read the answer (each head is the workspace's
// MAX(id), read after the request arrived), so a server that kept its log cannot answer below it: one such answer is
// proof, nothing is counted. An answer that is merely late (what was known when it left ≤ its head < the watermark now)
// is only refused. The engine rebuilds and says so (serverTruth.ts serverLostItsWrites).
// Premises (each pinned or written where it is kept):
//   - One workspace per server: the watermark is keyed by the server identity alone, domain_events.id is one sequence
//     for every workspace and a head is its workspace's MAX(id). Pinned by backend singleWorkspaceHead.guard.
//   - No answer is replayed by a cache in between: answers that carry a head are Cache-Control: no-store (backend app.ts).
//   - Every answer that carries a head names its server identity, the single note read too (READ_SERVER_HEADER): a read
//     taken just after the server changed identity is "changed", never judged against the old log's positions.

import { EVENT_POSITION_HEADER, isSyncPath } from "@onden/markdown/contract";
import { higherPosition, isCurrentAnswer, STALE_ANSWERS_BEFORE_WRITES_WAIT } from "../answerPositions";
import { setWriteGate, setWriteResponseListener } from "../api";
import { raiseWatermark, rewindCursor, type AnswerRefusal } from "../localDb";

/** The page's copy of the watermark and of the server identity it counts in. */
let watermark: string | null = null;
let server: string | null = null;
let staleInARow = 0;
/** Bumped each time the watermark starts over: a request that left before says nothing about the log answers come from now. */
let era = 0;
/** Set after too many refusals in a row: writes wait for it, until an answer is taken or the sync pass ends. */
let hold: { released: Promise<void>; release: () => void } | null = null;

/** Take in what the local copy holds (on load, and at each sync pass's start: the copy is shared with this device's
 *  other tabs, whose acknowledgements this page never sees, so what it learns is a lower bound of what the copy knew
 *  from then on — all serverWentBack needs; a refusal of the copy carries its watermark too). False, and nothing taken:
 *  the copy counts in another log than this page (another identity was seen; the copy is rebuilt first). */
export function startWatermarkFrom(stored: { position?: string | null; server?: string | null }): boolean {
  if (stored.server && server && stored.server !== server) return false;
  watermark = higherPosition(watermark, stored.position ?? null);
  server ??= stored.server ?? null;
  return true;
}

/** The server no longer holds what it acknowledged, or the identity changed: start over. */
export function forgetWatermark(nextServer: string | null = null): void {
  watermark = null;
  server = nextServer;
  staleInARow = 0;
  era++;
}

/** What this device knew when a request that asks for an answer left: the highest position (the page's watermark, which
 *  takes in the copy's, and `cursor`, a sync request's own since: it came from a taken answer). Taken before the request
 *  is sent; an earlier one is as good (it knew less). */
export type Asked = { readonly position: string | null; readonly era: number };

export function askedNow(cursor?: string | number): Asked {
  const since = cursor === undefined ? null : String(cursor);
  return { position: higherPosition(watermark, since), era };
}

/** The server went back under the same identity (a disk or VM snapshot, a pg_restore that kept the node id): an answer
 *  read at `head` below what this device knew when the request left (`asked`). Not when the watermark started over since
 *  the request left (that request was already judged), nor for an answer that says nothing about where it was read. */
export function serverWentBack(head: string | number | undefined, serverId: string | undefined, asked: Asked | undefined): boolean {
  return asked?.era === era && head !== undefined && sameServer(serverId) && !isCurrentAnswer(head, asked.position);
}

/** Only refusals inside a sync pass's request loop hold writes: that loop never waits on a write (sync() sends the
 *  queue before it starts asking), so the hold cannot wait on itself. A refusal elsewhere (a bootstrap, the ?nodes=none
 *  refresh, a single note read) is simply asked for again by its own caller. */
let inSyncLoop = false;

/** The sync pass starts asking for answers (after it sent the queued writes). */
export function syncLoopStarted(): void {
  inSyncLoop = true;
}

/** The sync pass ended (caught up, failed, or offline): held writes go, whatever the count. */
export function syncPassEnded(): void {
  inSyncLoop = false;
  releaseHold();
}

/** Hold new writes until the returned release (or the end of the sync pass): a caller re-asking for an answer that was
 *  refused, where nothing it does waits on a write (a bootstrap landing: sync() waits for the landing, so no queue is
 *  being sent meanwhile). The next answer is then read after every acknowledgement it could have missed. Writes already
 *  on their way still land. Already held: the release does nothing. */
export function holdWrites(): () => void {
  if (hold) return () => {};
  const mine = newHold();
  return () => { if (hold === mine) releaseHold(); else mine.release(); };
}

function newHold(): NonNullable<typeof hold> {
  let release!: () => void;
  return hold = { released: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
}

function releaseHold(): void {
  hold?.release();
  hold = null;
}

/** Whether `serverId` names the log this page counts in (or says nothing, or none is known yet); false: another event log. */
export function sameServer(serverId: string | undefined): boolean {
  return serverId === undefined || server === null || serverId === server;
}

export type AnswerOutcome = "taken" | "stale" | "changed" | "lost";

/** Whether the page would take an answer read at `head` now (the first of takeAnswer's checks, for a download that
 *  is not handed on when stale). */
export function pageWouldTake(head: string | number | undefined, serverId: string | undefined): boolean {
  return !sameServer(serverId) || isCurrentAnswer(head, watermark);
}

/** The one door for an answer that carries rows. `head`: where it was read; `serverId`: whose log; `asked`: what this
 *  device knew when the request left (askedNow; without it the answer is never proof that the server went back);
 *  `toCopy`: hand it to the local copy (returns whether the copy refused it, with the refusal's watermark, or saw another
 *  identity); `toStore`: put the copy's result into the store; `rewindTo`: the cursor the request started from. "lost":
 *  the server went back (serverWentBack); nothing was applied. */
export async function takeAnswer<T>(answer: {
  head: string | number | undefined; serverId: string | undefined; asked?: Asked | undefined;
  /** A whole bootstrap: from another server identity it is that server's whole state, so it is taken (the watermark
   *  starts over) instead of answered "changed". */
  wholeState?: boolean;
  toCopy: () => Promise<{ value: T; stale?: boolean; changed?: boolean; copy?: AnswerRefusal }>;
  toStore: (fromCopy: T) => void;
  rewindTo?: string | number;
}): Promise<AnswerOutcome> {
  if (!sameServer(answer.serverId)) {
    forgetWatermark(answer.serverId);
    if (!answer.wholeState) return "changed";
  }
  if (serverWentBack(answer.head, answer.serverId, answer.asked)) return "lost";
  if (!isCurrentAnswer(answer.head, watermark)) return refusal();
  const fromCopy = await answer.toCopy();
  if (fromCopy.changed && !answer.wholeState) { forgetWatermark(answer.serverId ?? null); return "changed"; }
  // Refused by the copy, whose watermark other tabs raise too: learnt, so the next request is judged against it.
  // Learnt only in the log this page counts in (startWatermarkFrom).
  if (fromCopy.stale) { startWatermarkFrom({ position: fromCopy.copy?.answer_watermark, server: fromCopy.copy?.answer_server }); return refusal(); }
  if (!isCurrentAnswer(answer.head, watermark)) {
    // The copy took it, but this page was told of a later write meanwhile: the store keeps what it has, and the copy's
    // cursor goes back so the next answer carries this one's rows again.
    if (answer.rewindTo !== undefined) await rewindCursor(String(answer.rewindTo)).catch(() => {});
    return refusal();
  }
  answer.toStore(fromCopy.value);
  if (answer.serverId !== undefined) server = answer.serverId;
  if (answer.head !== undefined) watermark = higherPosition(watermark, String(answer.head));
  staleInARow = 0;
  releaseHold();
  return "taken";
}

function refusal(): AnswerOutcome {
  staleInARow++;
  if (inSyncLoop && staleInARow >= STALE_ANSWERS_BEFORE_WRITES_WAIT && !hold) newHold();
  return "stale";
}

/** One response: a successful write (not GET/HEAD, not a sync read) with a position raises both watermarks — this
 *  page's at once, the local copy's by a message posted now (it reaches the copy before any answer that arrives later). */
function noteWriteResponse(path: string, init: RequestInit | undefined, response: Pick<Response, "ok" | "headers">): void {
  if (!isWrite(path, init) || !response.ok) return;
  const position = response.headers?.get?.(EVENT_POSITION_HEADER);
  if (!position || !/^[1-9]\d*$/.test(position)) return;
  watermark = higherPosition(watermark, position);
  raiseWatermark(position).catch(() => { /* no local copy: the page's watermark is the whole rule */ });
}

/** Before a write leaves: after too many refusals in a row it first waits until an answer is taken (or the sync pass
 *  ends), so the request asked meanwhile cannot be overtaken by its acknowledgement. A keepalive write (the page is
 *  closing) never waits. Returns the release at once when nothing is held. */
function beforeWrite(path: string, init: RequestInit | undefined): (() => void) | Promise<() => void> {
  // Waits only while writes are held: otherwise the request leaves at once, as without the gate (a read never waits).
  if (isWrite(path, init) && hold && !init?.keepalive) return hold.released.then(() => beforeWrite(path, init));
  return () => {};
}

/** A request that writes: not GET/HEAD, not a sync read (a POST /api/sync asks for an answer). */
function isWrite(path: string, init: RequestInit | undefined): boolean {
  return !/^(get|head)$/i.test(init?.method ?? "GET") && !isSyncPath(path);
}

setWriteResponseListener(noteWriteResponse);
setWriteGate(beforeWrite);
