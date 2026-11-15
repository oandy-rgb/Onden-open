import type { InboxEvent, InboxFacets, InboxGroup, PendingApproval } from "../lib/api";
import type { InboxFilters } from "../lib/inboxFilters";

// The inbox list's props and the sidebar's slice of them. Here (not in components/) because the hooks that
// build them (useInboxSidebar, DecisionsContext) may not import from components/.

export type InboxReviewProps = {
  events: InboxEvent[];
  groups?: InboxGroup[];
  facets?: InboxFacets;
  filters?: InboxFilters;
  onFiltersChange?: (f: InboxFilters) => void;
  approvals?: PendingApproval[];
  busyId: string | null;
  online: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onGroupDecide?: (rootEventId: string, decision: "approve" | "reject") => void;
  /** Bulk-decide the listed (filtered) single events in one call. */
  onBatchDecide?: (ids: string[], decision: "approve" | "reject") => void;
  onDecideHeld?: (id: string, decision: "approve" | "reject") => void;
  onOpenNode?: (id: string) => void;
  /** The one-line pointer to Settings › System status; off where the list is about one note. */
  showFailedJobs?: boolean;
};

export type SidebarInbox = Omit<InboxReviewProps, "online" | "onOpenNode"> & {
  /** The last read of the queue failed: the inbox page says so (with `onRetryLoad`) rather than show nothing waiting. */
  loadFailed?: boolean;
  onRetryLoad?: () => void;
};
