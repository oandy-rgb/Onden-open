import { api } from "../api";
import { noteLocalWrite } from "../liveInvalidation";
import { addPendingWrite, catchUpWithOtherTabs, getPendingWrites, clearPendingWrite, bumpPendingWriteAttempt, type PendingWrite } from "../localDb";
import { writeTargets, targetIds, type WriteTarget } from "../pendingWriteTargets";
import { addToast, getAppState, setData } from "../appStore";
import { t } from "../i18n";
import { randomUUID } from "../uuid";
import { withTabLock } from "../webLock";
import { isBrowserOnline } from "../browserNetwork";
import { bumpPending, refreshPendingCount, STUCK_AFTER_ATTEMPTS, type SendFailureReason } from "./syncStatus";
import { isSendingHere, sendingElsewhere, startSendingHere, stopSendingHere, whenSentElsewhere } from "./sendingHere";
import { classifyWriteFailure, sendFailureReason, WriteStorageError, writeFailureMessage, reportWriteFailure, isHandledNoteExists } from "./writeErrors";
import { onProtocolBlockChange } from "../protocolGate";
import { patchedBody, wholeBody, wholeFitsRequest, isPatchBaseUnknown } from "./patchedBody";
import { rememberUnconfirmedWrite, confirmRecoveredWrite, preserveRejectedWrite, preserveDirectRejection, hasUserText, getRecoveryWrites, removeRecoveryWrite, adoptable } from "./writeRecovery";
import { PREFS, prefsAvailable } from "../prefs";
import { onAppResume } from "../appResume";
import { serverTruth } from "./serverTruthLoad";
import { accountStorageKey } from "../accountStorage";
import { readSession, removeSession, SESSION_KEYS } from "../sessionPrefs";

export type WriteMethod = "POST" | "PUT" | "PATCH" | "DELETE";
export type WriteResult<T> = { status: "synced"; value: T } | { status: "queued" };
export type WriteRequest = {
  method: WriteMethod;
  path: string;
  body: string | null;
  online?: boolean;
  init?: RequestInit;
  idemKey?: string | null;
  /** A create whose caller opens the existing note when the server answers 409
   *  `note_exists` (a day note or 任務 note: its id is derived, so another
   *  device or the server may have made it first). That one refusal is not a
   *  failure: nothing goes to recovery and no error is shown. Any other
   *  refusal of the same write is reported as usual. */
  existingNoteIsFine?: true;
};
export const OFFLINE_QUEUE_FAILED_EVENT = "onden-offline-queue-failed";
export type OfflineQueueFailedDetail = Pick<WriteRequest, "method" | "path" | "body" | "idemKey">;

/** One attempt to send a write. A connection that neither answers nor fails
 *  (Wi-Fi without internet, a switch of network) must not hold the lane, so
 *  the attempt is abandoned: the caller treats it as retryable and queues the
 *  write under the SAME idempotency key, which the server deduplicates even
 *  when the abandoned attempt did arrive. */
export const WRITE_ATTEMPT_DEADLINE_MS = 25_000;

async function sendWithDeadline<T>(path: string, init: RequestInit): Promise<T> {
  // A write that carries a value and the value it was made from goes out as a
  // patch (patchedBody.ts). If the server cannot give that base back it says
  // so, and the whole request follows once, under the same idempotency key.
  const whole = { ...init, body: wholeBody(init.method, path, init.body) };
  const patched = patchedBody(init.method, path, init.body);
  if (patched === null) return sendOnce<T>(path, whole);
  try { return await sendOnce<T>(path, { ...init, body: patched }); }
  catch (error) {
    if (!isPatchBaseUnknown(error)) throw error;
    // Too big to carry its base: merge into what the server stores here, instead of losing the base (patchedBody.ts).
    const rebased = wholeFitsRequest(init.method, path, init.body) ? null : await import("./rebasedPatch").then((m) => m.rebasedOnStored(init.method, path, init.body));
    return sendOnce<T>(path, rebased === null ? { ...whole, keepalive: false } : { ...init, body: rebased, keepalive: false });
  }
}

async function sendOnce<T>(path: string, init: RequestInit): Promise<T> {
  await settleAbandonedAttempts();
  const controller = new AbortController();
  let giveUp!: (reason: unknown) => void;
  const abandoned = new Promise<never>((_, reject) => { giveUp = reject; });
  const timer = setTimeout(() => {
    const reason = new DOMException("Write attempt timed out", "TimeoutError");
    controller.abort(reason);
    giveUp(reason);
  }, WRITE_ATTEMPT_DEADLINE_MS);
  const attempt = api<T>(path, { ...init, signal: controller.signal });
  try { return await Promise.race([attempt, abandoned]); }
  catch (error) {
    if (controller.signal.aborted) abandonAttempt(attempt);
    throw error;
  }
  finally { clearTimeout(timer); }
}

/** Attempts given up on at the deadline whose request has not reported an end
 *  yet. An abort ends a browser request at once, so this is normally empty.
 *  While one is open the server may still receive it, so no later write is
 *  sent: it could arrive first and the older value would then overwrite it.
 *  A transport that never reports an end (a native HTTP layer that ignores
 *  the abort) is waited for only ABANDONED_ATTEMPT_GRACE_MS. */
export const ABANDONED_ATTEMPT_GRACE_MS = 10_000;
const abandonedAttempts = new Set<Promise<void>>();

function abandonAttempt(attempt: Promise<unknown>): void {
  let end!: () => void;
  const over = new Promise<void>((resolve) => { end = resolve; });
  const grace = setTimeout(end, ABANDONED_ATTEMPT_GRACE_MS);
  attempt.then(end, end);
  abandonedAttempts.add(over);
  void over.then(() => { clearTimeout(grace); abandonedAttempts.delete(over); });
}

async function settleAbandonedAttempts(): Promise<void> {
  while (abandonedAttempts.size) await Promise.all([...abandonedAttempts]);
}

/** For tests that leave a request unanswered for good. */
export function forgetAbandonedAttempts(): void { abandonedAttempts.clear(); }

/** Browsers refuse a keepalive request over 64 KiB; stay under with room. */
const KEEPALIVE_BODY_LIMIT = 60_000;
function exceedsKeepalive(body: string | null): boolean {
  if (!body || body.length * 3 <= KEEPALIVE_BODY_LIMIT) return false;
  return body.length >= KEEPALIVE_BODY_LIMIT || new TextEncoder().encode(body).length > KEEPALIVE_BODY_LIMIT;
}

/** The request as it can be sent: a body too big for keepalive goes without
 *  it (it would throw, and the page would die with the write only queued
 *  asynchronously). The synchronous recovery copy (rememberUnconfirmedWrite,
 *  made by the caller before this) is what protects it across page exit. */
export function withoutOversizedKeepalive<R extends { body: string | null; init?: RequestInit; method?: string; path?: string }>(request: R): R {
  // A body that goes out as a patch is judged by the patch (sendWithDeadline).
  const sent = (request.path && patchedBody(request.method, request.path, request.body)) || request.body;
  return request.init?.keepalive && exceedsKeepalive(sent) ? { ...request, init: { ...request.init, keepalive: false } } : request;
}

let writeTail: Promise<unknown> = Promise.resolve();

// Submission and replay share a lane. A newly recovered connection must not
// send a newer edit ahead of an older queued edit and then replay the old value.
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeTail.then(() => withTabLock("onden-pending-drain", operation));
  writeTail = result.catch(() => {});
  return result;
}

/** Writes an EARLIER page life left without an answer (pagehide kept them in
 *  recovery, synchronously, because a reload or a closed tab cannot await the
 *  worker or the queue) are queued again under their own keys, in the order
 *  they were made, before anything this page life writes. The key makes a
 *  second arrival harmless (the server replays its answer), so "the response
 *  was lost" and "it never arrived" take the same road and the person does not
 *  have to press anything. A refusal later puts the text back in recovery
 *  (preserveRejectedWrite); storage that cannot take the queue row leaves the
 *  entry where it is (enqueue hands it back, newer than this page life).
 *  Only entries made on the way out of a page are adopted (`adoptable`): one made by this page load, or kept while its
 *  page was alive (a crash, another open tab's write), is in flight or the person's to retry, and sending it here could
 *  put it on the wire from two tabs. The clock cannot tell which is which (pagehide of the old page runs after the new
 *  page's time origin), so each entry names the page load that made it and whether it was leaving. */
async function adoptUnconfirmedWrites(): Promise<void> {
  await adoptLegacyInFlight();
  if (!prefsAvailable(PREFS.lostWrites)) return;
  const left = getRecoveryWrites().filter((write) => !write.rejection && !write.unpersisted && write.idemKey && adoptable(write));
  const queued = left.length ? await getPendingWrites().catch(() => null) : [];
  if (!queued) return;
  for (const write of left) {
    const key = write.idemKey!;
    if (!queued.some((row) => row.idem_key === key)) {
      try { await enqueue({ method: write.method, path: write.path, body: write.body, idemKey: key }); }
      catch { return; /* enqueue has put it back in recovery for this page life */ }
    }
    await removeRecoveryWrite(write.id);
  }
}

/** The write a tab of the previous build had on the wire when it was reloaded into this one (its sessionStorage
 *  slot: that build sent saves without a queue row). Queued under its key, like a write left in recovery, and the slot
 *  removed; the server answers a second arrival from its record. Gone with the last tab of that build. */
async function adoptLegacyInFlight(): Promise<void> {
  let left: (WriteRequest & { idemKey: string }) | null = null;
  try {
    const key = accountStorageKey(SESSION_KEYS.legacyWriteInFlight);
    const raw = readSession(key);
    if (!raw) return;
    removeSession(key);
    const parsed = JSON.parse(raw) as { method?: WriteMethod; path?: string; body?: string | null; idemKey?: string };
    if (parsed.idemKey && parsed.method && parsed.path) left = { method: parsed.method, path: parsed.path, body: parsed.body ?? null, idemKey: parsed.idemKey };
  } catch { return; /* no account bound yet, or nothing readable: nothing to take in */ }
  if (left) await enqueue(left).catch(() => { /* enqueue has put it in recovery */ });
}

/** One adoption at a time: recordWrite runs it outside the lane (before its own row), the lane runs it too. */
let adopting: Promise<void> = Promise.resolve();
function adoptLeftWrites(): Promise<void> {
  adopting = adopting.catch(() => {}).then(adoptUnconfirmedWrites);
  return adopting;
}

/** Best effort: if the other copies cannot be read, this tab judges by its own. */
async function absorbOtherTabs(): Promise<void> {
  try { await catchUpWithOtherTabs(); } catch { /* own view */ }
}

async function enqueue(request: WriteRequest & { idemKey: string }): Promise<void> {
  bumpPending(1);
  try {
    await addPendingWrite(request.method, request.path, request.body, request.idemKey);
  } catch (cause) {
    bumpPending(-1);
    rememberUnconfirmedWrite(request);
    // Recovery keeps the SAME key: should the server have it already (a write sent before it was queued), the
    // resend is answered from the server's record. The worker took its row back out (addPendingWrite).
    if (typeof window !== "undefined") {
      const { method, path, body, idemKey } = request;
      window.dispatchEvent(new CustomEvent<OfflineQueueFailedDetail>(OFFLINE_QUEUE_FAILED_EVENT, {
        detail: { method, path, body, idemKey },
      }));
    }
    throw new WriteStorageError(cause);
  }
}

let writeEpoch = 0;
/** Counts writes this device started (sent or queued). An online operation
 *  reuses a failed attempt's key only while nothing else was written since:
 *  after another decision, the same request is a new intent. */
export function getWriteEpoch(): number { return writeEpoch; }
export function noteWriteStarted(): void { writeEpoch += 1; }

/** A write's durable record: its queue row, committed (one journal record)
 *  before anything else of the write happens: before the local copy shows it
 *  and before its request leaves. From then on a page killed at any instant
 *  leaves it where it WILL be sent from (the queue), under its own key, and the
 *  local copy never holds text the queue does not (docs/architecture/note-writes.md
 *  "送出前先記下"). While this page lives the row is its own to send (sendingHere.ts,
 *  a Web Lock per write): no drain, of this tab or another live
 *  one, sends it first, and it does not count as waiting. Once this page has
 *  given it to the queue (or died), any tab's drain sends it, under its key.
 *  Resolves false when storage cannot take the row: the write then goes as it
 *  did without one (sent, or queued with recovery as the fallback). */
export function recordWrite(request: WriteRequest & { idemKey: string }): Promise<boolean> {
  const held = startSendingHere(request.idemKey);
  // Rows are written in the order recordWrite is CALLED (that is the queue's order, made_at): each waits for the one
  // before it. Waiting only for its own lock would not do: the spec orders the grants of one lock name, not of
  // different names, so a later save's lock can come first and its row land ahead of an earlier save's.
  const recorded = recording.catch(() => {}).then(async () => {
    // Its own lock, from the moment its row exists, if it can be had at once (it can, unless another live tab holds
    // this key). A lock another tab holds is not waited out here: that tab is sending this same write (one key, one
    // write; the server answers a second arrival from its record), and this chain would hold up every save after it,
    // or wait on a tab that waits on this one's lane. Every other step has an end (worker calls time out).
    await heldOrMoment(held);
    // What an earlier page life left in recovery goes into the queue first: it is older than this write.
    await adoptLeftWrites().catch(() => {});
    await addPendingWrite(request.method, request.path, request.body, request.idemKey);
    return true;
  }).catch(() => false);
  recording = recorded;
  return recorded;
}
let recording: Promise<unknown> = Promise.resolve();

/** How long a save's row waits for its own write lock: a lock nobody else holds is granted at once. */
const RECORD_LOCK_WAIT_MS = 1_000;
function heldOrMoment(held: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const moment = new Promise<void>((resolve) => { timer = setTimeout(resolve, RECORD_LOCK_WAIT_MS); });
  return Promise.race([held, moment]).finally(() => clearTimeout(timer));
}

/** Resolves only after a server acknowledgement OR a durable queue commit.
 * No caller needs to mint retry keys or classify network/HTTP failures.
 * `recorded` is the write's recordWrite, when the caller made it first (the
 * write lifecycle does, before its local copy changes); otherwise it is made here. */
export function submitWrite<T = unknown>(original: WriteRequest, options: { recorded?: Promise<boolean> } = {}): Promise<WriteResult<T>> {
  const idemKey = original.idemKey ?? randomUUID();
  noteWriteStarted();
  // pagehide cannot await a worker or a Web Lock. Preserve the request now;
  // if the page dies before acknowledgement, recovery offers the same key.
  if (original.init?.keepalive) rememberUnconfirmedWrite({ ...original, idemKey });
  const request = withoutOversizedKeepalive(original);
  const recorded = options.recorded ?? recordWrite({ ...request, idemKey });
  // This save's share of its write lock goes back exactly once: when its turn in the lane ends, or, should the lane
  // never run it (the lane's own lock refused), when it settles. A share left held would keep its row "this page's to
  // send" with nothing left to send it.
  let given = false;
  const giveBack = () => { if (!given) { given = true; stopSendingHere(idemKey); } };
  return serialized(async (): Promise<WriteResult<T>> => {
    try { return await sendRecorded<T>(request, idemKey, await recorded); }
    finally { giveBack(); }
  }).finally(giveBack).then((result) => { confirmRecoveredWrite(idemKey); return result; });
}

/** Queued rows that are waiting for a drain: not those a live page is sending itself (this one: a save on its way,
 *  waiting for its turn in its lane; or another tab, by its write lock). Those are not work in the queue: their page
 *  sends them, and nothing else waits for them (as before saves on their way had rows). */
async function waitingIn(queue: PendingWrite[]): Promise<PendingWrite[]> {
  const elsewhere = await sendingElsewhere();
  return queue.filter((write) => !isSendingHere(write.idem_key) && !(write.idem_key && elsewhere.has(write.idem_key)));
}

async function sendRecorded<T>(request: WriteRequest, idemKey: string, durable: boolean): Promise<WriteResult<T>> {
  // Other tabs and the installed app queue into their own copy: take theirs
  // in first, or this write would go out ahead of their older edit.
  if (request.online !== false) await absorbOtherTabs();
  await adoptLeftWrites();
  // Consult the queue itself, not the UI's asynchronously refreshed counter.
  // If storage cannot be read, do not risk sending this edit ahead of unknown older work.
  const queue = await getPendingWrites().catch(() => null);
  // Recorded and not in the queue (no other live tab takes it: storage lost it): it goes as if unrecorded, under its key.
  const own = durable ? queue?.find((write) => write.idem_key === idemKey) : undefined;
  // In queue order (when each was made), not by id: another tab's older row can carry a higher id here. Only rows
  // waiting in the queue count: a save of another note still on its way (its row is its page's own) is not ahead.
  const before = queue === null ? null : own ? queue.slice(0, queue.indexOf(own)) : queue;
  const ahead = before === null || (await waitingIn(before)).length > 0;
  let retryOnOwn = false;
  if (request.online !== false && !ahead) {
    try {
      const suppliedHeaders = new Headers(request.init?.headers);
      suppliedHeaders.delete("Idempotency-Key");
      const headers = { ...Object.fromEntries(suppliedHeaders.entries()), "Idempotency-Key": idemKey };
      // This tab's write comes back as a "changed" tick it needn't sync for
      // (lib/liveInvalidation.ts): open the echo window before sending — the
      // tick can beat the response — and extend it once the write lands.
      noteLocalWrite();
      const value = await sendWithDeadline<T>(request.path, {
        ...request.init, method: request.method, body: request.body ?? undefined, headers,
      });
      noteLocalWrite();
      // Sent: a row left behind (this removal failed) only sends the key again, and the server answers it again.
      if (own) await clearPendingWrite(own.id, own.idem_key).catch(() => {});
      await flushIfWaiting(idemKey);
      return { status: "synced", value };
    } catch (error) {
      if (classifyWriteFailure(error) === "rejected") {
        if (!isHandledNoteExists(request, error)) {
          // The refused text goes to recovery (the row itself, when it holds text). Its row never stays queued: a
          // refusal is not sent again (if recovery's storage failed, its marked in-memory copy is what is left).
          try { await preserveDirectRejection({ ...request, idemKey }, writeFailureMessage(error), error); }
          catch (storageError) { reportWriteFailure(storageError, addToast); }
        }
        if (own) await clearPendingWrite(own.id, own.idem_key).catch(() => {});
        // What waited behind it is next, as after a send.
        await flushIfWaiting(idemKey, { absorb: true });
        throw error;
      }
      // A replay after re-authentication uses the same key as the first attempt.
      retryOnOwn = classifyWriteFailure(error) === "retryable" && isBrowserOnline();
    }
  }
  if (own) bumpPending(1);
  else await enqueue({ ...request, idemKey });
  if (retryOnOwn) scheduleRetry();
  // The caller judged "offline" (or saw a backlog) before the drain ahead of this write in the lane finished, and that
  // drain read the queue before this row existed: with the app online again nothing else would send it.
  // The store's flag is the one judgment: wentOffline() clears it on the browser's own `offline`, and a server that
  // does not answer clears it too (syncEngine), so the browser's flag adds nothing here.
  else if (getAppState().online) void flushPendingWrites();
  return { status: "queued" };
}

/** One wait per key for another tab's lock, however many drains pass its row meanwhile. */
const awaitingElsewhere = new Set<string>();
function drainWhenSentElsewhere(idemKey: string): void {
  if (awaitingElsewhere.has(idemKey)) return;
  awaitingElsewhere.add(idemKey);
  void whenSentElsewhere(idemKey).then(() => { awaitingElsewhere.delete(idemKey); void flushPendingWrites(); });
}

/** After this save's turn: rows waiting in the queue (another tab's, one taken in from a closed one) go next. The
 *  queue is read again: it can have changed while this save's request was out. `absorb`: take in other tabs' rows
 *  first (after a refusal: no answer of this save's will bring the drain otherwise). */
async function flushIfWaiting(idemKey: string, { absorb = false } = {}): Promise<void> {
  if (absorb) await absorbOtherTabs();
  const queue = await getPendingWrites().catch(() => []);
  if ((await waitingIn(queue.filter((write) => write.idem_key !== idemKey))).length) void flushPendingWrites();
}

/** Compatibility for callers which handle durable-queue failure via recovery. */
export async function queueWrite(method: WriteMethod, path: string, body: string | null, idemKey?: string | null): Promise<boolean> {
  noteWriteStarted();
  try {
    await serialized(() => enqueue({ method, path, body, idemKey: idemKey ?? randomUUID() }));
    return true;
  } catch { return false; }
}

/** Compatibility with existing response-or-undefined consumers. A queued
 * result still means it is durable; failed persistence rejects the promise. */
export async function sendOrQueue<T = unknown>(method: WriteMethod, path: string, body: string | null, init?: RequestInit, idemKey?: string | null): Promise<T | undefined> {
  const result = await submitWrite<T>({ method, path, body, init, idemKey });
  return result.status === "synced" ? result.value : undefined;
}

let drainInFlight: Promise<void> | null = null;
const WARN_AFTER_ATTEMPTS = 6;
let replayRejectionRevision = 0;

/** Changes after a replay refusal has been preserved durably. This process-local
 * signal invalidates optimistic membership checks; it is not a permission epoch
 * or a count of recovery entries (dismissing recovery does not change it).
 * Every new page performs its own initial membership check. */
export function getReplayRejectionRevision(): number { return replayRejectionRevision; }

/** Waits before the queue sends itself again while the browser is online and
 *  the last send failed for a passing reason (a 5xx, a timeout, a dropped
 *  connection). Without it a queued write sat until the person edited again,
 *  came back to the tab or the connection flipped. The last wait repeats. */
export const WRITE_RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000, 60_000];
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryStep = 0;
let stopWaitingForVisible: (() => void) | null = null;

/** One retry pending at a time. A background tab does not wake on a timer: it
 *  waits until the tab is shown (that also covers a phone that was locked). */
function scheduleRetry(): void {
  if (retryTimer || stopWaitingForVisible) return;
  const delay = WRITE_RETRY_DELAYS_MS[Math.min(retryStep, WRITE_RETRY_DELAYS_MS.length - 1)]!;
  retryStep += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (typeof document === "undefined" || document.visibilityState !== "hidden") { void flushPendingWrites(); return; }
    // appResume is the one listener for "the person is back in the tab".
    const stopListening = onAppResume(() => { stopWaitingForVisible?.(); void flushPendingWrites(); }, ["visible"]);
    stopWaitingForVisible = () => { stopListening(); stopWaitingForVisible = null; };
  }, delay);
}

/** The queue is not failing any more (sent, empty, refused for good, or the
 *  device is offline): forget the wait so the next failure starts at the first. */
function stopRetry(): void {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  stopWaitingForVisible?.();
  retryStep = 0;
}

/** For tests that leave a retry pending. */
export function stopWriteRetry(): void { stopRetry(); }

/** A replayed write that moved or deleted a note drew its result when it was made. When the server refused it, or
 *  answered with a different place (a parent it reads as "top level"), the screen and the local copy are put
 *  where the server says the note is (serverTruth.ts). */
function sentParent(write: PendingWrite): { parent: string | null } | null {
  if (write.method !== "PATCH" || !write.body) return null;
  try {
    const sent = JSON.parse(write.body) as { parent_id?: string | null };
    return "parent_id" in sent ? { parent: sent.parent_id ?? null } : null;
  } catch { return null; }
}
/** Refused: a delete or a move left its drawn result behind. */
const refusedPlace = (write: PendingWrite): boolean => write.method === "DELETE" || sentParent(write) !== null;
/** Accepted, but the row the server answered has another parent than the one sent. */
const answeredElsewhere = (write: PendingWrite, answer: unknown): boolean => {
  const sent = sentParent(write);
  return sent !== null && ((answer as { parent_id?: string | null } | null)?.parent_id ?? null) !== sent.parent;
};

async function drain(): Promise<void> {
  let retryable = false;
  // Why this pass could not send (the sync status says it); null when it did, or the device is offline.
  let failure: SendFailureReason | null = null;
  const settleAfter = new Set<string>();
  try {
    await absorbOtherTabs();
    await adoptLeftWrites();
    const writes = await getPendingWrites();
    const elsewhere = await sendingElsewhere();
    for (const write of writes) {
      // A page that is alive is sending it itself (this one: a save on its way, waiting for its turn in its lane; or
      // another tab): not work waiting here, and the rows after it do not wait for it (waitingIn). Another tab's:
      // drain again once its lock is free (sent, queued there, or that tab died).
      if (isSendingHere(write.idem_key)) continue;
      if (write.idem_key && elsewhere.has(write.idem_key)) { drainWhenSentElsewhere(write.idem_key); continue; }
      try {
        noteLocalWrite();
        const answer = await sendWithDeadline(write.path, {
          method: write.method, body: write.body ?? undefined,
          headers: write.idem_key ? { "Idempotency-Key": write.idem_key } : undefined,
        });
        noteLocalWrite();
        if (answeredElsewhere(write, answer)) for (const id of targetIds(write, "node")) settleAfter.add(id);
      } catch (error) {
        const kind = classifyWriteFailure(error);
        if (kind === "rejected") {
          // Preserve the exact input durably outside replay. Never delete it
          // just because the server has refused permission or validation.
          if (refusedPlace(write)) for (const id of targetIds(write, "node")) settleAfter.add(id);
          if (hasUserText(write.body)) {
            await preserveRejectedWrite(write, writeFailureMessage(error));
            replayRejectionRevision++;
            addToast(t("A queued change was rejected. Its input is available in recovery."), "error");
          } else {
            // Nothing the user typed (duplicate, move, delete…): there is no
            // input to recover, so the refusal is one plain message.
            await clearPendingWrite(write.id, write.idem_key);
            replayRejectionRevision++;
            addToast(writeFailureMessage(error), "error");
          }
          continue;
        }
        if (kind === "authentication") { failure = "signin"; addToast(writeFailureMessage(error), "error"); }
        // A server error, a timeout or a dropped connection: count it, so a
        // head that never gets through is eventually shown as stuck (the sync
        // status). A device that knows it is offline is not failing the write.
        if (kind === "retryable" && isBrowserOnline()) {
          retryable = true;
          failure = sendFailureReason(error);
          const attempts = await bumpPendingWriteAttempt(write.id, write.idem_key);
          if (attempts === WARN_AFTER_ATTEMPTS) {
            addToast(t("Sync keeps failing. Your changes remain queued; retry when the server is available."), "error");
          }
        }
        // Preserve dependency order AND the write, even after repeated 5xxs.
        // Sending a dependent edge before its queued node exists can lose data.
        break;
      }
      // Storage failure is not a server rejection. Keep the same replay key
      // rather than misclassifying a failed local acknowledgement as HTTP.
      await clearPendingWrite(write.id, write.idem_key);
    }
    await settleReplayedPlaces(settleAfter);
  } catch (error) {
    console.error("Local write queue could not be read or acknowledged", error);
    addToast(t("Could not read or update the local sync queue. Keep this page open and retry syncing."), "error");
  } finally {
    if (retryable) scheduleRetry(); else stopRetry();
    await refreshPendingCount(failure);
  }
}

/** Notes with a write still queued keep what they show: that write will settle them when it is answered. */
async function settleReplayedPlaces(ids: Set<string>): Promise<void> {
  if (!ids.size) return;
  const queued = await getPendingWrites().catch(() => []);
  for (const id of ids) {
    if (queued.some((write) => targetIds(write, "node").includes(id))) continue;
    await serverTruth().then(({ settleNodeToServer }) => settleNodeToServer(id, setData)).catch(() => false);
  }
}

// An updated server has answered: what waited for it goes out now (lib/protocolGate.ts).
onProtocolBlockChange((block) => { if (block === null) void flushPendingWrites(); });

/** One drain per tab, serialized across tabs where Web Locks is available. */
export function flushPendingWrites(): Promise<void> {
  if (drainInFlight) return drainInFlight;
  const run = serialized(drain);
  drainInFlight = run.finally(() => { drainInFlight = null; });
  return drainInFlight;
}

const targetKey = (target: WriteTarget) => `${target.kind}:${target.id}`;

/** The stuck head of the queue and the later writes to the same things, moved
 *  to the recovery panel in their order (nothing is deleted). Writes to other
 *  things behind it are not dependent and go out on the next flush. Returns
 *  how many moved; 0 when the head is not stuck any more. */
export function moveStuckWritesToRecovery(): Promise<number> {
  return serialized(async () => {
    const writes = await getPendingWrites();
    const head = writes[0];
    if (!head || head.attempts < STUCK_AFTER_ATTEMPTS) return 0;
    const stuckTargets = new Set(writeTargets(head).map(targetKey));
    const moving = writes.filter((write, index) => index === 0 || writeTargets(write).some((target) => stuckTargets.has(targetKey(target))));
    try {
      for (const write of moving) await preserveRejectedWrite(write, t("This change could not be sent for a long time. It was moved to recovery."));
    } finally { await refreshPendingCount(); }
    return moving.length;
  });
}

/** Whether a durable queued write matches. Callers judge a write by what it
 *  acts on (writeTargets in lib/pendingWriteTargets), never by parsing its path. */
export async function hasPendingWrite(matches: (write: PendingWrite) => boolean): Promise<boolean> {
  return (await getPendingWrites()).some(matches);
}
