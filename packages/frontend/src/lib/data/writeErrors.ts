import { ApiError } from "../api";
import { t } from "../i18n";
import { isKnownServerCode } from "../serverErrors";
import type { ToastFn } from "./types";
import type { SendFailureReason } from "./syncStatus";

const reported = new WeakSet<object>();
// Refusals whose whole outcome is already on screen in a recovery entry.
const recovered = new WeakSet<object>();

/** A recovery entry now shows this refusal (fixed sentence + reason). The entry
 * IS the notification, so reportWriteFailure must not toast it as well. */
export function markRecoveryEntryShown(error: unknown): void {
  if (typeof error === "object" && error !== null) recovered.add(error);
}

/** A domain reports once; an outer UI boundary may reuse this helper without
 * showing the same error twice. Each transport attempt normally has a new Error. */
export function reportWriteFailure(error: unknown, notify: ToastFn): void {
  if (typeof error === "object" && error !== null) {
    if (reported.has(error)) return;
    reported.add(error);
    if (recovered.has(error)) return;
  }
  notify(writeFailureMessage(error), "error");
}

export function wasWriteFailureReported(error: unknown): boolean {
  return typeof error === "object" && error !== null && reported.has(error);
}

/** Neither server nor durable queue acknowledgement was received. A lost
 * response may still have committed, so recovery must reuse the original key. */
export class WriteStorageError extends Error {
  constructor(cause: unknown) {
    super("The change could not be saved on this device.", { cause });
    this.name = "WriteStorageError";
  }
}

/** A domain precondition with a user-actionable explanation, not a network failure. */
export class WriteActionError extends Error {}

/** "waitForUpdate": the page or the server is too old for the other (426, lib/protocolGate.ts). Nothing is wrong with
 *  the change itself: it stays where it is (the queue, the open draft), is not retried on a timer, and goes out once
 *  the page is reloaded or the server updated. Never a rejection. */
export type WriteFailureKind = "storage" | "authentication" | "rejected" | "retryable" | "waitForUpdate";

/** The gateway's answers while the backend is down or restarting (a deploy:
 *  nginx answers 502/503 for a backend container that is not up yet). */
const GATEWAY_DOWN = new Set([502, 503, 504]);

/** The server could not be reached: the fetch itself failed (a TypeError —
 *  no network, DNS, connection refused), the read hit its deadline
 *  (readWithDeadline / AbortSignal.timeout reject with a "TimeoutError"), or
 *  only the gateway answered (502/503/504 without the backend's JSON error
 *  code — a backend JSON error came from a reachable server). One rule for
 *  boot, sync and reconnect, and tag resolution.
 *
 *  Not the same question as classifyWriteFailure's "retryable": a write
 *  retries on any 5xx and on 408/425/429 because the server may accept it
 *  later, but a 500 or a 429 came from a server that IS reachable — so it is
 *  retryable without being unreachable. A caller cancelling its own request
 *  (an "AbortError") is neither. */
export function isServerUnreachable(error: unknown): boolean {
  if (error instanceof ApiError) return GATEWAY_DOWN.has(error.status) && !error.code;
  if (error instanceof TypeError) return true;
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "TimeoutError";
}

/** The one refusal a create may say its caller handles (WriteRequest.existingNoteIsFine). */
export function isHandledNoteExists(request: { existingNoteIsFine?: true }, error: unknown): boolean {
  return request.existingNoteIsFine === true && error instanceof ApiError && error.status === 409 && error.code === "note_exists";
}

/** Shared by initial submission and replay. A lost response is ambiguous, so
 * transport failures retry with the original key; a 401 can recover after login. */
export function classifyWriteFailure(error: unknown): WriteFailureKind {
  if (error instanceof WriteActionError) return "rejected";
  if (error instanceof WriteStorageError) return "storage";
  if (!(error instanceof ApiError)) return "retryable";
  if (error.status === 401) return "authentication";
  if (error.status === 426) return "waitForUpdate";
  if (error.status >= 500 || [408, 425, 429].includes(error.status)) return "retryable";
  return "rejected";
}

/** Which reason the sync status gives for a failed send: signed out (401), the
 *  server answered with an error, or the connection itself failed. Not a new
 *  classification of the failure: classifyWriteFailure still decides what to do. */
export function sendFailureReason(error: unknown): SendFailureReason {
  if (error instanceof ApiError) return error.status === 401 ? "signin" : "server";
  return "connection";
}

/** The one sentence for a change that is saved on this device and waits for the
 *  server (the write queue accepted it; the server has not). Every screen that
 *  tells the person so says exactly this: a queued save is never "saved". */
export function queuedWriteMessage(): string {
  return t("Saved on this device — it will sync when the server is reachable.");
}

/** What a failed request that is not a write (a read, a run, a token action)
 *  tells the user: the server's refusal in the words of lib/serverErrors.ts,
 *  the connection sentence when it could not be reached, otherwise `fallback`.
 *  Never an Error's own message: that is a JS or network string. */
export function requestFailureMessage(error: unknown, fallback: string): string {
  if (isServerUnreachable(error)) return t("Could not reach the server. Try again when the connection is available.");
  return error instanceof ApiError && error.message ? error.message : fallback;
}

/** What a failed write tells the user. The words for a server refusal are
 *  ApiError.message — the one code → message table in lib/serverErrors.ts, the
 *  same text a read shows; this function only adds the device-side cases
 *  (local storage, no connection) and the generic sign-in prompt. */
export function writeFailureMessage(error: unknown): string {
  switch (classifyWriteFailure(error)) {
    case "storage": return t("Could not save on this device. Keep this page open and use the recovery panel.");
    // account_changed / membership_removed have their own advice; a plain
    // expired session gets the retry hint.
    case "authentication": return error instanceof ApiError && error.code && error.code !== "unauthorized" && isKnownServerCode(error.code)
      ? error.message : t("Sign in again, then retry syncing or saving.");
    case "rejected":
      return (error instanceof ApiError || error instanceof WriteActionError) && error.message
        ? error.message : t("The server rejected this change.");
    case "waitForUpdate": return error instanceof ApiError && error.message ? error.message : t("This screen is an old version. Reload it before you edit; what you just typed is still here.");
    // A server that answered "try again" with a code we have words for (workspace_busy,
    // rate_limited) is reachable: say that, not "could not reach".
    default: return error instanceof ApiError && error.code && error.code !== "internal" && isKnownServerCode(error.code)
      ? error.message : t("Could not reach the server. Try again when the connection is available.");
  }
}
