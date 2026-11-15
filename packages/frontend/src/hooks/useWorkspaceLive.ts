import { serviceWorkerContainer } from "../lib/storagePersist";
import { useEffect } from "react";
import { useOnline } from "../lib/appStore";
import { onSuggestionsChanged } from "../lib/aiSuggestionsBus";
import { useLiveRefetch } from "../lib/liveInvalidation";
import { dataSync } from "../lib/data";
import { useDueSoonNotifications } from "./useDueSoonNotifications";
import { useNotificationToasts } from "./useNotificationToasts";
import { useBodyConflictNotice } from "./useBodyConflictNotice";

type Options = {
  sync: () => Promise<unknown>;
  loadInboxReview: () => Promise<unknown>;
  openNote: (id: string) => void;
};

/**
 * What reaches the open workspace from outside: realtime ticks, notification
 * toasts and due-soon reminders.
 *
 * Realtime (lib/liveInvalidation.ts owns the signals and collapses the echo of
 * this tab's own writes). Ticks carry NOTHING — every refresh goes back
 * through the read-policy-filtered endpoints.
 *
 * Returns the due-soon state the Tasks lens shows its toggle from.
 */
export function useWorkspaceLive({ sync, loadInboxReview, openNote }: Options) {
  const online = useOnline();

  // "changed" → pull /api/sync deltas into the store (sidebar / editor / agenda
  // / today lens all derive from it) and reload the inbox (some governance
  // events produce no sync delta). The echo of this tab's own save is folded
  // into one trailing sync. Coming back to the foreground / online catches up
// at once, and a poll covers a stream that is down. A reopened stream is the "reconnect" handshake
  // below, so this doesn't also run then.
  useLiveRefetch("changed", async () => { await Promise.all([sync(), loadInboxReview()]); }, { onReconnect: false, collapseEcho: true, onVisible: true, onOnline: true, pollMs: 60_000 });
  // "effects" → reload held-approval cards.
  useLiveRefetch("effects", () => loadInboxReview());
  // Places of an AI's suggestion decided here: the card that listed it clears at once, not on the next live tick.
  useEffect(() => onSuggestionsChanged(() => { void loadInboxReview(); }), [loadInboxReview]);
  // A permission change committed → RAISE the fail-closed gate IMMEDIATELY
  // (dirty-latch — don't wait for sync to notice the epoch), then sync() runs
  // the membership reconcile which deletes revoked and LOWERS the gate on
  // success. A burst of ticks is one lock and one reconcile (membershipChanged).
  useLiveRefetch("membership", () => { dataSync.membershipChanged(); });
  // Stream reopened: ticks emitted while it was DOWN are lost, so re-handshake
  // with a sync: its epoch check locks and reconciles only when permissions
  // changed meanwhile; a plain reconnect does not lock.
  useLiveRefetch("reconnect", () => { dataSync.liveStreamReconnected(); });

  useNotificationToasts();
  useBodyConflictNotice();

  // Due-soon reminders (busy-parent #2): poll the agenda and fire OS
  // notifications for newly-due/overdue tasks. The toggle lives in TasksMode;
  // this owns the lifecycle so reminders keep working from any view.
  const dueSoon = useDueSoonNotifications(online);

  // A clicked due-soon notification (handled in sw.js) postMessages the SPA to
  // open the task's node — focus the tab and route to it in place.
  useEffect(() => {
    const worker = serviceWorkerContainer();
    if (!worker) return;
    const onMessage = (e: MessageEvent) => {
      const msg = e.data as { type?: string; nodeId?: string } | undefined;
      if (msg?.type === "open-task" && msg.nodeId) {
        openNote(msg.nodeId);
      }
    };
    worker.addEventListener("message", onMessage);
    return () => worker.removeEventListener("message", onMessage);
  }, [openNote]);

  return dueSoon;
}
