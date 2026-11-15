import { api } from "../api";
import { noteLocalWrite } from "../liveInvalidation";
import { getPendingWrites } from "../localDb";
import { randomUUID } from "../uuid";
import { t } from "../i18n";
import { inWriteOrder } from "./writeLifecycle";
import { classifyWriteFailure, reportWriteFailure, WriteActionError } from "./writeErrors";
import { getWriteEpoch, noteWriteStarted } from "./writeQueue";
import type { DataCtx } from "./types";

export type OnlineAcknowledgement<T> = T | { deduped: true };
type OnlineMethod = "POST" | "PUT" | "PATCH" | "DELETE";
export type OnlineSubmit = <T>(path: string, body?: string, method?: OnlineMethod) => Promise<OnlineAcknowledgement<T>>;

/** The one online write path: a decision the server must accept before this
 * device shows it (configuration, structure, history), never queued.
 *  • Preconditions, checked once here: online, and no queued writes waiting
 *    (they must land first, in order).
 *  • A resource keeps at most one unfinished attempt: its submits (method,
 *    path, body) in order, each with one Idempotency-Key, so a retry after a
 *    lost response applies once (the server answers a replay {deduped:true}).
 *    The attempt is dropped when the operation succeeds or is refused, when a
 *    run on the resource submits something different, and when any other write
 *    started since — then the same request is a new decision with a new key.
 *    Trade-off, chosen for safety: any other write (an autosave in another
 *    note) also retires the key, so a later retry may apply twice where main
 *    would have deduped it (version restore, collections) — never a deduped
 *    reply for a decision the server did not apply.
 *  • Once a submit is acknowledged, a retry of the same operation does not
 *    send it again — only the steps after it (a result read) re-run.
 *  • A failure is reported here, once, then rethrown; callers show their own
 *    inline state but don't report it again.
 * The operation holds its resource lane through result reconciliation. */
/** The write was acknowledged; a step after it (reading the result back)
 * failed. Not reported: the change stands, and a retry of the operation
 * repeats only the steps after the acknowledged write. */
export class AfterAcknowledgementError extends Error {
  constructor(cause: unknown) {
    super("the change was saved, but its result could not be read", { cause });
    this.name = "AfterAcknowledgementError";
  }
}

export function makeOnlineOperation(ctx: DataCtx) {
  type Step = { fingerprint: string; key: string; acknowledged?: { value: unknown } };
  const attempts = new Map<string, { epoch: number; steps: Step[] }>();
  /** `online`: the caller's own view of the connection, when it has one.
   *  `unreported`: a refusal the caller turns into its own question (which notes
   *  could not be edited, and go on or not) instead of a failure notice; it is
   *  still rethrown. */
  return <T>(
    resource: string, offlineMessage: string, operation: (submit: OnlineSubmit) => Promise<T>, online?: boolean,
    unreported?: (error: unknown) => boolean,
  ): Promise<T> =>
    inWriteOrder(resource, async () => {
      const previous = attempts.get(resource);
      const attempt = { epoch: getWriteEpoch(), steps: previous?.epoch === getWriteEpoch() ? previous.steps : [] };
      attempts.set(resource, attempt);
      let index = 0;
      try {
        if (!(online ?? ctx.online)) throw new WriteActionError(offlineMessage);
        if ((await getPendingWrites()).length) throw new WriteActionError(t("Sync pending changes before continuing."));
        const result = await operation(async <Result>(path: string, body?: string, method: OnlineMethod = "POST") => {
          const fingerprint = `${method} ${path}:${body ?? ""}`;
          let step = attempt.steps[index];
          if (step?.fingerprint !== fingerprint) {
            // A different submit: the earlier attempt's later steps are not this decision.
            step = { fingerprint, key: randomUUID() };
            attempt.steps.splice(index, Infinity, step);
          }
          index += 1;
          if (step.acknowledged) return step.acknowledged.value as OnlineAcknowledgement<Result>;
          noteWriteStarted();
          attempt.epoch = getWriteEpoch();
          try {
            const value = await api<OnlineAcknowledgement<Result>>(path, { method, body, headers: { "Idempotency-Key": step.key } });
            step.acknowledged = { value };
            return value;
          } catch (error) {
            if (classifyWriteFailure(error) === "rejected") attempts.delete(resource);
            throw error;
          }
        });
        attempts.delete(resource);
        return result;
      } catch (error) {
        if (!(error instanceof AfterAcknowledgementError) && !unreported?.(error)) reportWriteFailure(error, ctx.addToast);
        throw error;
      }
    });
}

/** Compatibility for publishing's existing response contract. History uses
 * makeOnlineOperation so acknowledgement and result loading stay distinct. */
export function makeOnlineWrite(ctx: DataCtx) {
  const operation = makeOnlineOperation(ctx);
  return <T>(resource: string, path: string, body: string | undefined, offlineMessage: string): Promise<T> =>
    operation(resource, offlineMessage, async (submit) => await submit<T>(path, body) as T);
}

/** One online write with an Idempotency-Key, so a retried request (a lost
 *  response, a double click) applies once; the server answers a replay with
 *  {deduped:true}. Pass the same key to retry the same attempt. Writes that
 *  should survive going offline use submitWrite/sendOrQueue instead. */
export function sendWrite<T = unknown>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  idemKey: string = randomUUID(),
): Promise<T> {
  // The echo of this write is collapsed (lib/liveInvalidation.ts).
  noteLocalWrite();
  noteWriteStarted();
  return api<T>(path, {
    method,
    headers: { "Idempotency-Key": idemKey },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  }).then((value) => { noteLocalWrite(); return value; });
}
