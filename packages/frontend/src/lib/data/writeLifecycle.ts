import { t } from "../i18n";
import { randomUUID } from "../uuid";
import { recordWrite, submitWrite, type WriteRequest, type WriteResult } from "./writeQueue";
import { classifyWriteFailure, isHandledNoteExists, reportWriteFailure } from "./writeErrors";
import { rememberUnconfirmedWrite, protectPendingWriteOnExit } from "./writeRecovery";
import type { ToastFn } from "./types";

type Context = { online: boolean; addToast: ToastFn; scheduleUserFolderSync?: () => void };
type Effects<T> = {
  /** Refresh the mirror from CURRENT domain state, never a captured whole row. */
  mirror?: () => Promise<unknown>;
  accepted?: (result: WriteResult<T>) => void | Promise<void>;
  rejected?: () => void | Promise<void>;
  /** Deletions keep the local cascade intact until submission is accepted. */
  destructive?: boolean;
  /** Retain an unconfirmed intent for recovery, releasing its in-memory journal. */
  unconfirmed?: () => void;
};

const pending = new Map<string, Promise<unknown>>();

/** Internal domain infrastructure. UI code uses task/tag/canvas intent APIs.
 * One resource lane also covers local mirror updates and rollback, so domains
 * sharing a node cannot race SQLite snapshots before queue persistence. */
export function inWriteOrder<T>(resource: string, operation: () => Promise<T>): Promise<T> {
  const previous = pending.get(resource);
  const result = previous ? previous.catch(() => {}).then(operation) : operation();
  pending.set(resource, result);
  void result.finally(() => { if (pending.get(resource) === result) pending.delete(resource); }).catch(() => {});
  return result;
}

export function makeWriteLifecycle(ctx: Context) {
  return function commit<T>(resource: string, request: WriteRequest, effects: Effects<T> = {}): Promise<WriteResult<T>> {
    const prepared = { ...request, idemKey: request.idemKey ?? randomUUID() };
    if (prepared.init?.keepalive) rememberUnconfirmedWrite(prepared);
    const releaseExitProtection = protectPendingWriteOnExit(prepared);
    // The queue row first, now, in the order writes are made; the local copy only after it is durable: a page killed
    // at any instant leaves no text in the local copy that the queue does not hold (writeQueue.recordWrite).
    const recorded = recordWrite(prepared);
    return inWriteOrder(resource, async () => {
      let mirrorFailed = false;
      const mirror = async () => {
        try { await effects.mirror?.(); mirrorFailed = false; }
        catch { mirrorFailed = true; }
      };
      await recorded;
      if (!effects.destructive) await mirror();
      let result: WriteResult<T>;
      try {
        result = await submitWrite<T>({ ...prepared, online: ctx.online }, { recorded });
      } catch (error) {
        if (classifyWriteFailure(error) === "rejected") {
          try { await effects.rejected?.(); }
          catch { mirrorFailed = true; }
          if (!effects.destructive) await mirror();
        } else effects.unconfirmed?.();
        if (!isHandledNoteExists(prepared, error)) reportWriteFailure(error, ctx.addToast);
        if (mirrorFailed) ctx.addToast(t("The local copy could not be updated. Keep your changes and retry."), "error");
        throw error;
      }
      // After acknowledgement, reconciliation/cache errors cannot turn a
      // successful server write into a failed write or trigger rollback.
      releaseExitProtection();
      let reconcileFailed = false;
      try { await effects.accepted?.(result); }
      catch { reconcileFailed = true; }
      await mirror();
      if (mirrorFailed || reconcileFailed) ctx.addToast(t("The change is saved, but its local copy could not be updated."), "error");
      try { ctx.scheduleUserFolderSync?.(); }
      catch { ctx.addToast(t("The change is saved, but its local copy could not be updated."), "error"); }
      return result;
    }).finally(releaseExitProtection);
  };
}

/** Replace only fields which still match this operation's optimistic value. */
export function reconcileFields<T extends object>(current: T, expected: Partial<T>, replacement: Partial<T>): T {
  const next = { ...current };
  for (const key of Object.keys(replacement) as (keyof T)[]) {
    if (current[key] === expected[key]) next[key] = replacement[key] as T[keyof T];
  }
  return next;
}
