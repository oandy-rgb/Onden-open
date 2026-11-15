import { useMemo } from "react";
import { useAppSelector, useOnline } from "../lib/appStore";
import type { SidebarInbox } from "./sidebarInboxTypes";
import { useInboxGovernance } from "./useInboxGovernance";
import { useStableCallback } from "./useStableCallback";

type Decision = "approve" | "reject";

/**
 * The inbox governance queues (D7), shaped as the sidebar's inbox props.
 *
 * The data layer (applied-event review queue, held approve-before-apply
 * effects, the four decision surfaces) lives in useInboxGovernance; this wires
 * it to the checked workspace and gives the memoized sidebar handlers with
 * ONE identity across renders, grouped as the sidebar's inbox group.
 */
export function useInboxSidebar(refresh: () => Promise<void>) {
  const bootstrapped = useAppSelector((s) => s.bootstrapped);
  const online = useOnline();
  const membershipGated = useAppSelector((s) => s.membershipGated);
  const workspaceId = useAppSelector((s) => s.data.workspace.id);
  // Wait for the checked workspace; editor/data updates do not invalidate it.
  // A reject is an inverse-undo of node state, so it refreshes the tree.
  const governance = useInboxGovernance({
    refresh, workspaceId,
    enabled: bootstrapped && online && !membershipGated,
  });
  const { reviewEvent, decideGroup, batchReview, decideHeldEffect } = governance;

  const onApproveEvent = useStableCallback((id: string) => void reviewEvent(id, "approve"));
  const onRejectEvent = useStableCallback((id: string) => void reviewEvent(id, "reject"));
  const onGroupDecide = useStableCallback((rootId: string, decision: Decision) => void decideGroup(rootId, decision));
  const onBatchDecide = useStableCallback((ids: string[], decision: Decision) => void batchReview(ids, decision));
  const onDecideHeldEffect = useStableCallback((id: string, decision: Decision) => void decideHeldEffect(id, decision));

  // The sidebar's inbox group: one object until a queue or the filter changes.
  const { inboxReview, inboxGroups, inboxFacets, inboxFilters, setInboxFilters, inboxApprovals, inboxBusyId, inboxLoadFailed, loadInboxReview } = governance;
  const onRetryLoad = useStableCallback(() => void loadInboxReview());
  const sidebarInbox = useMemo((): SidebarInbox => ({
    events: inboxReview,
    groups: inboxGroups,
    facets: inboxFacets ?? undefined,
    filters: inboxFilters,
    onFiltersChange: setInboxFilters,
    approvals: inboxApprovals,
    loadFailed: inboxLoadFailed,
    onRetryLoad,
    busyId: inboxBusyId,
    onApprove: onApproveEvent, onReject: onRejectEvent, onGroupDecide, onBatchDecide, onDecideHeld: onDecideHeldEffect,
  }), [inboxReview, inboxGroups, inboxFacets, inboxFilters, setInboxFilters, inboxApprovals, inboxBusyId, inboxLoadFailed, onRetryLoad,
    onApproveEvent, onRejectEvent, onGroupDecide, onBatchDecide, onDecideHeldEffect]);

  return { loadInboxReview: governance.loadInboxReview, sidebarInbox };
}
