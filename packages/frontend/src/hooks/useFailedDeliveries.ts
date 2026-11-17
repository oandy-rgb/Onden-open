import { useCallback, useEffect, useState } from "react";
import { addToast } from "../lib/appStore";
import { useIsOwner } from "../lib/capabilities";
import { t } from "../lib/i18n";
import { useLiveRefetch } from "../lib/liveInvalidation";
import { inboxWriter, reads, writeErrors } from "../lib/data";

/** An outbox delivery that ran out of retries (about a day of attempts,
 *  backend migration 101): GET /api/inbox/failed-effects, owner only. */
export type FailedDelivery = { id: string; effect_kind: string; attempts: number; last_error: string | null; failed_at: string };

/** The failed deliveries of one kind: how many, the newest error, and when
 *  the first and the last of them failed. */
export type FailedDeliveryGroup = { effect_kind: string; count: number; last_error: string | null; oldest_at: string; newest_at: string };

/**
 * The owner's failed background jobs (Settings › System status, and the
 * one-line notice that points there). Nobody else reads them: the server
 * lists nothing to a non-owner, and this does not ask. Kept current by the
 * "effects" tick. Every action reloads the list afterwards, failed or not.
 */
export function useFailedDeliveries(online: boolean) {
  const isOwner = useIsOwner();
  const [failed, setFailed] = useState<FailedDelivery[]>([]);
  const [groups, setGroups] = useState<FailedDeliveryGroup[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!isOwner) return;
    try {
      const r = await reads.events.failedEffects<FailedDelivery, FailedDeliveryGroup>();
      setFailed(r.failed ?? []);
      setGroups(r.groups ?? []);
      setTotal(r.total ?? (r.failed ?? []).length);
    } catch { /* offline / not ready — keep the last list */ }
  }, [isOwner]);
  useEffect(() => {
    if (online && isOwner) void load();
    if (!isOwner) { setFailed([]); setGroups([]); setTotal(0); }
  }, [online, isOwner, load]);
  useLiveRefetch("effects", load);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try { await action(); }
    catch (error) { writeErrors.report(error, addToast); }
    finally { setBusy(null); await load(); }
  };

  /** Requeue one failed delivery with a fresh day of retries. */
  const retry = (id: string) => run(id, async () => {
    const r = await inboxWriter.retryDelivery(id);
    addToast(r.status === "superseded" ? t("A newer copy was already sent or queued — this one is cleared") : t("Retrying now"), "info");
  });

  /** 「全部重試」: requeue every failed delivery of a kind. */
  const retryKind = (kind: string) => run(`kind:${kind}`, async () => {
    const r = await inboxWriter.retryDeliveriesOfKind(kind);
    addToast(t("Retrying {n} now", { n: r.requeued + r.merged }), "info");
  });

  /** 「全部清除」: set every failed delivery of a kind aside; they are not
   *  retried any more. Pending work of the kind is not touched. */
  const dismissKind = (kind: string) => run(`kind:${kind}`, async () => {
    const r = await inboxWriter.dismissDeliveriesOfKind(kind);
    addToast(t("Cleared {n}", { n: r.dismissed }), "info");
  });

  return { isOwner, failed, groups, total, busy, retry, retryKind, dismissKind };
}
