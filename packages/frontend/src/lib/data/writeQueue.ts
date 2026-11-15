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
import { classifyWriteFailure, sendFailureReason, WriteStorageError, writeFailureMessage, reportWriteFailure, isHandledNoteExists } from "./writeErrors";
import { onProtocolBlockChange } from "../protocolGate";
import { patchedBody, wholeBody, isPatchBaseUnknown } from "./patchedBody";
import { rememberUnconfirmedWrite, confirmRecoveredWrite, preserveRejectedWrite, preserveDirectRejection, hasUserText, getRecoveryWrites, removeRecoveryWrite, adoptable } from "./writeRecovery";
import { PREFS, prefsAvailable } from "../prefs";
import { onAppResume } from "../appResume";
import { settleNodeToServer } from "./serverTruth";
import { markInFlight, clearInFlight, takeInterrupted } from "./inFlightWrite";

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
    return sendOnce<T>(path, { ...whole, keepalive: false });
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

/** The write the previous page load had on the wire when it went away (a
 *  reload, a navigation) is queued under its own key before anything newer is
 *  sent: its request may still reach the server, and sent after the newer
 *  write it would overwrite it; queued first it goes out ahead of it and the
 *  server's replay of the key makes a late arrival harmless. */
async function adoptInterruptedWrite(): Promise<void> {
  const lost = takeInterrupted();
  if (!lost) return;
  const queued = await getPendingWrites().catch(() => []);
  if (queued.some((write) => write.idem_key === lost.idemKey)) return;
  try { await enqueue(lost); } catch { /* enqueue has handed it to recovery */ }
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
    // Recovery keeps the SAME key: the worker's in-memory entry may still be
    // persisted by a background retry after its first durable save failed.
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

/** Resolves only after a server acknowledgement OR a durable queue commit.
 * No caller needs to mint retry keys or classify network/HTTP failures. */
export function submitWrite<T = unknown>(original: WriteRequest): Promise<WriteResult<T>> {
  const idemKey = original.idemKey ?? randomUUID();
  noteWriteStarted();
  // pagehide cannot await a worker or a Web Lock. Preserve the request now;
  // if the page dies before acknowledgement, recovery offers the same key.
  if (original.init?.keepalive) rememberUnconfirmedWrite({ ...original, idemKey });
  const request = withoutOversizedKeepalive(original);
  return serialized(async (): Promise<WriteResult<T>> => {
    // Consult the queue itself, not the UI's asynchronously refreshed counter.
    // If storage cannot be read, try a durable enqueue rather than risk sending
    // this edit ahead of unknown older work.
    // Other tabs and the installed app queue into their own copy: take theirs
    // in first, or this write would go out ahead of their older edit.
    if (request.online !== false) await absorbOtherTabs();
    await adoptInterruptedWrite();
    await adoptUnconfirmedWrites();
    let retryOnOwn = false;
    const backlog = request.online === false || await getPendingWrites().then((writes) => writes.length > 0, () => true);
    if (!backlog) {
      try {
        const suppliedHeaders = new Headers(request.init?.headers);
        suppliedHeaders.delete("Idempotency-Key");
        const headers = { ...Object.fromEntries(suppliedHeaders.entries()), "Idempotency-Key": idemKey };
        // This tab's write comes back as a "changed" tick it needn't sync for
        // (lib/liveInvalidation.ts): open the echo window before sending — the
        // tick can beat the response — and extend it once the write lands.
        noteLocalWrite();
        markInFlight({ ...request, idemKey });
        const value = await sendWithDeadline<T>(request.path, {
          ...request.init, method: request.method, body: request.body ?? undefined, headers,
        });
        noteLocalWrite();
        clearInFlight(idemKey);
        return { status: "synced", value };
      } catch (error) {
        if (classifyWriteFailure(error) === "rejected") {
          clearInFlight(idemKey);
          if (isHandledNoteExists(request, error)) throw error;
          try { await preserveDirectRejection({ ...request, idemKey }, writeFailureMessage(error), error); }
          catch (storageError) { reportWriteFailure(storageError, addToast); }
          throw error;
        }
        // A replay after re-authentication uses the same key as the first attempt.
        retryOnOwn = classifyWriteFailure(error) === "retryable" && isBrowserOnline();
      }
    }
    try { await enqueue({ ...request, idemKey }); } finally { clearInFlight(idemKey); }
    if (retryOnOwn) scheduleRetry();
    // The caller judged "offline" (or saw a backlog) before the drain ahead of this write in the lane finished, and that
    // drain read the queue before this row existed: with the app online again nothing else would send it.
    // The store's flag is the one judgment: wentOffline() clears it on the browser's own `offline`, and a server that
    // does not answer clears it too (syncEngine), so the browser's flag adds nothing here.
    else if (getAppState().online) void flushPendingWrites();
    return { status: "queued" };
  }).then((result) => { confirmRecoveredWrite(idemKey); return result; });
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
    await adoptInterruptedWrite();
    await adoptUnconfirmedWrites();
    const writes = await getPendingWrites();
    for (const write of writes) {
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
            await clearPendingWrite(write.id);
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
          const attempts = await bumpPendingWriteAttempt(write.id);
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
      await clearPendingWrite(write.id);
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
    await settleNodeToServer(id, setData).catch(() => false);
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
