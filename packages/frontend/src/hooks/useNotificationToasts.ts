import { useEffect, useRef } from "react";
import { useLiveEventLog } from "./useLiveEventLog";
import { addToast } from "../lib/appStore";
import { t } from "../lib/i18n";

/** Toasts for NOTIFICATION events (the dispatcher's `notify` handler). */
export function useNotificationToasts(): void {
  // Subscribe to NOTIFICATION events — the dispatcher's `notify` handler emits
  // these. Tick-driven via the shared SSE stream (10 s poll as the SSE-down
  // fallback); per-event one-shot toast via a high-water-mark.
  const { events: notificationEvents } = useLiveEventLog({
    query: { event_type: "NOTIFICATION", limit: "20" },
    intervalMs: 10_000,
    maxEvents: 50,
  });
  const lastToastIdRef = useRef<number>(0);
  useEffect(() => {
    // Initialise the high-water-mark on the first batch so the user doesn't
    // get spammed with toasts for historical events on every page load.
    if (lastToastIdRef.current === 0 && notificationEvents.length > 0) {
      lastToastIdRef.current = notificationEvents[0].id;
      return;
    }
    // Walk oldest→newest so multiple new notifications stack in chronological
    // order in the toast list.
    const fresh = notificationEvents
      .filter((e) => e.id > lastToastIdRef.current)
      .sort((a, b) => a.id - b.id);
    for (const e of fresh) {
      const level = (e.payload?.level as string) ?? "info";
      const message = (e.payload?.message as string) ?? t("Notification");
      const via = e.payload?.via_tag_name as string | undefined;
      // Toast infra only has success/error/info — warning maps to error tint.
      const kind: "success" | "error" | "info" =
        level === "success" ? "success" :
        level === "warning" ? "error" : "info";
      addToast(via ? t("{message} (via #{tag})", { message, tag: via }) : message, kind);
      lastToastIdRef.current = e.id;
    }
  }, [notificationEvents]);
}
