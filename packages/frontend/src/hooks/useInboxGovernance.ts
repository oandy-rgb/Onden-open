// Inbox governance data layer — the D7 review queue behind the Inbox pane,
// extracted from BuilderApp so the host component keeps only wiring.
//
// Two queues load together:
//   • already-APPLIED agent events (apply-then-review posture: approve = keep,
//     reject = inverse-undo), plus server-side batch groups (events sharing a
//     triggered_by root — e.g. one RSS fetch's articles) and facet counts for
//     the filter chips. Filters round-trip to GET /api/inbox as
//     actor_id / event_type query params.
//   • HELD outbound effects (approve-BEFORE-apply: e.g. an agent's publish
//     request) that run only once approved — GET /api/inbox/approvals.
//
// The four decision surfaces (single event / triggered_by group / filtered
// bulk / held effect) used to be four copies of the same lifecycle; they now
// share one parameterized runner (`runDecision`).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readWithDeadline, type InboxEvent, type InboxFacets, type InboxGroup, type PendingApproval } from "../lib/api";
import { addToast } from "../lib/appStore";
import { t } from "../lib/i18n";
import type { InboxFilters } from "../lib/inboxFilters";
import { inboxWriter, reads, writeErrors } from "../lib/data";

type Decision = "approve" | "reject";
type Queues = {
  inboxReview: InboxEvent[];
  inboxGroups: InboxGroup[];
  inboxFacets: InboxFacets | null;
  inboxApprovals: PendingApproval[];
};
const EMPTY_QUEUES: Queues = {
  inboxReview: [], inboxGroups: [], inboxFacets: null, inboxApprovals: [],
};

export function useInboxGovernance(opts: {
  /** useAppData's refresh — pulls the authoritative node tree after a reject,
   *  because the inverse-undo just mutated server-side node state. */
  refresh: () => Promise<void>;
  /** Read only after the online workspace has passed its membership check.
   *  Disabling immediately hides queues and retires pending reads. */
  enabled: boolean;
  /** Identity of the checked workspace; a change retires the previous queues. */
  workspaceId: string;
}) {
  const { refresh, enabled, workspaceId } = opts;
  const [inboxFilters, setInboxFilters] = useState<InboxFilters>({ actorId: null, eventType: null });
  const { actorId, eventType } = inboxFilters;
  const scope = useMemo(() => ({ enabled, workspaceId }), [enabled, workspaceId]);
  // A → B → A owns three distinct reads. Returning to a workspace or filter
  // must not revive its first, possibly revoked, response or cached rows.
  const selection = useMemo(() => {
    const qs = new URLSearchParams();
    if (actorId) qs.set("actor_id", actorId);
    if (eventType) qs.set("event_type", eventType);
    return { scope, query: qs.toString() };
  }, [scope, actorId, eventType]);
  const [snapshot, setSnapshot] = useState<(Queues & { selection: typeof selection }) | null>(null);
  // The selection whose last read failed. A failed read must not look like an empty queue.
  const [failedSelection, setFailedSelection] = useState<typeof selection | null>(null);
  const [busy, setBusy] = useState<{ scope: typeof scope; id: string } | null>(null);
  const readerRef = useRef<{ selection: typeof selection; reload: () => Promise<void> } | null>(null);

  // SSE and explicit decisions request a read started after their invalidation.
  // Retained callbacks from a retired query cannot refresh the current queue.
  const loadInboxReview = useCallback(() => {
    const reader = readerRef.current;
    return reader?.selection === selection ? reader.reload() : Promise.resolve();
  }, [selection]);

  useEffect(() => {
    if (!selection.scope.enabled || !selection.scope.workspaceId) return;
    const controller = new AbortController();
    let disposed = false;
    let reading = false;
    let pending: Array<() => void> = [];
    let active: Array<() => void> = [];

    const run = async () => {
      if (disposed || reading) return;
      reading = true;
      // Ticks during a read share one follow-up, rather than racing requests
      // whose older result can overwrite a post-decision queue.
      while (!disposed && pending.length > 0) {
        active = pending;
        pending = [];
        try {
          const { query } = selection;
          const r = await readWithDeadline(signal => reads.events.inbox(query, signal), controller.signal);
          if (disposed) break;
          const a = await readWithDeadline(signal => reads.events.approvals(signal), controller.signal);
          if (!disposed) {
            setSnapshot({
              selection, inboxReview: r.events ?? [], inboxGroups: r.groups ?? [],
              inboxFacets: r.facets ?? null, inboxApprovals: a.approvals ?? [],
            });
            setFailedSelection(null);
          }
        } catch (e) {
          // A same-query failure keeps the last complete read until an SSE
          // tick or explicit retry. Abort/stale failures belong to retired UI.
          if (!disposed) {
            console.error("inbox review queue load failed; keeping current queue", e);
            setFailedSelection(selection);
          }
        }
        for (const resolve of active) resolve();
        active = [];
      }
      reading = false;
    };
    const reader = {
      selection,
      reload: () => disposed ? Promise.resolve() : new Promise<void>(resolve => {
        pending.push(resolve);
        void run();
      }),
    };
    readerRef.current = reader;
    void reader.reload();
    return () => {
      disposed = true;
      controller.abort();
      for (const resolve of [...active, ...pending]) resolve();
      if (readerRef.current === reader) readerRef.current = null;
    };
  }, [selection]);

  // Shared decision lifecycle: latch the row busy, POST the decision, pull the
  // node tree if a reject inverse-undid something, surface any success toast,
  // then reload the queue — on failure too (e.g. a 409 already-reviewed must
  // still drop the stale card) — and finally release the busy latch.
  const runDecision = useCallback(async (
    busyKey: string,
    action: {
      /** Runs the POST; returns a success toast to show, or null for none. */
      perform: () => Promise<string | null>;
      /** True when a reject's inverse-undo changed node state server-side. */
      refreshAfter?: boolean;
      /** Toast fallback when the thrown error carries no message. */
      errorFallback: string;
    },
  ) => {
    if (readerRef.current?.selection !== selection) return;
    const decision = { scope, id: busyKey };
    setBusy(decision);
    // A filter change may happen while a decision is committing. Refresh the
    // new filter in that same workspace, but never another workspace/session.
    const currentReader = () => readerRef.current?.selection.scope === scope ? readerRef.current : null;
    try {
      const successToast = await action.perform();
      if (!currentReader()) return;
      if (action.refreshAfter) await refresh();
      if (!currentReader()) return;
      if (successToast) addToast(successToast);
      await currentReader()?.reload();
    } catch (e) {
      if (!currentReader()) return;
      addToast(writeErrors.requestMessage(e, action.errorFallback), "error");
      await currentReader()?.reload(); // e.g. 409 already-reviewed → drop it from the queue
    } finally {
      if (currentReader()) setBusy(current => current === decision ? null : current);
    }
  }, [refresh, selection, scope]);

  // Single applied event — POST /api/inbox/:id/(approve|reject).
  const reviewEvent = useCallback(async (id: string, action: Decision) => {
    await runDecision(id, {
      perform: async () => {
        await inboxWriter.decide(id, action);
        return null;
      },
      refreshAfter: action === "reject",
      errorFallback: t("Review failed"),
    });
  }, [runDecision]);

  // Batch review: decide a whole triggered_by chain (e.g. one feed fetch's
  // articles) in a single call — POST /api/inbox/groups/:root/(approve|reject).
  const decideGroup = useCallback(async (rootEventId: string, decision: Decision) => {
    await runDecision(rootEventId, {
      perform: async () => {
        await inboxWriter.decideGroup(rootEventId, decision);
        return null;
      },
      refreshAfter: decision === "reject",
      errorFallback: t("Batch review failed"),
    });
  }, [runDecision]);

  // Bulk review: decide MANY independent (filtered) events at once —
  // POST /api/inbox/batch. The ids are exactly what the user's filters showed.
  const batchReview = useCallback(async (ids: string[], decision: Decision) => {
    await runDecision("batch", {
      perform: async () => {
        const r = await inboxWriter.decideMany(ids, decision);
        if (r.skipped.length === 0) return null;
        return t(
          decision === "approve" ? "{n} approved, {m} skipped" : "{n} rejected, {m} skipped",
          { n: r.decided, m: r.skipped.length },
        );
      },
      refreshAfter: decision === "reject",
      errorFallback: t("Batch review failed"),
    });
  }, [runDecision]);

  // Held outbound effect (approve-BEFORE-apply) — POST /api/inbox/approvals/:id.
  // No refresh: deciding a held effect doesn't touch node state directly (the
  // approved effect runs asynchronously and announces itself via SSE).
  const decideHeldEffect = useCallback(async (id: string, decision: Decision) => {
    await runDecision(id, {
      perform: async () => {
        await inboxWriter.decideHeld(id, decision);
        return decision === "approve" ? t("Approved — running now") : t("Rejected — it won't run");
      },
      errorFallback: t("Decision failed"),
    });
  }, [runDecision]);

  // Effects run after render: hide retired rows before their cleanup runs.
  const queues = snapshot?.selection === selection ? snapshot : EMPTY_QUEUES;
  return {
    inboxReview: queues.inboxReview,
    inboxGroups: queues.inboxGroups,
    inboxFacets: queues.inboxFacets,
    inboxApprovals: queues.inboxApprovals,
    inboxLoadFailed: failedSelection === selection,
    inboxFilters,
    setInboxFilters,
    inboxBusyId: busy?.scope === scope ? busy.id : null,
    loadInboxReview,
    reviewEvent,
    decideGroup,
    batchReview,
    decideHeldEffect,
  };
}
