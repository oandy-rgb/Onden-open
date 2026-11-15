// Due-soon reminders — the foreground half of "remind me when it is due".
//
// While the app is OPEN this polls the existing agenda endpoint and fires a
// one-shot OS notification for each newly-due / newly-overdue task, and at a
// task's reminder moment. While it is CLOSED or the phone is locked (a frozen
// tab cannot run this), the server sends a Web Push for the same moment
// (backend modules/tasks/pushReminders.ts; the browser half is lib/webPush.ts,
// turned on together with the notification permission below) and public/sw.js
// shows it.
//
// One moment, one notification: the moment's rule is the one both sides share
// (@onden/markdown taskReminder), and a push uses the in-app notice's `tag`
// (`remind:<task>:<moment>`), so when this hook already showed it the push
// replaces it on screen instead of adding a second. Which half shows first is
// not decided: the same tag makes the second one an update of the first.
//
// Decision logic is the pure dueSoonNotify module; this hook owns only the
// browser side: permission, polling, de-dupe persistence, and dispatching to the
// service-worker registration (so notificationclick → open task works on PWAs)
// with a desktop `new Notification` fallback.

import { serviceWorkerContainer } from "../lib/storagePersist";
import { useCallback, useEffect, useRef, useState } from "react";

import { register } from "../lib/liveInvalidation";
import {
  pendingDueNotices,
  pendingRemindNotices,
  type Agenda,
  type DueNotice,
} from "../lib/dueSoonNotify";
import { nowDateTimeId, workspaceDayStartHour } from "../lib/localDate";
import { reads } from "../lib/data";
import { PREFS, getPrefJson, setPrefJson } from "../lib/prefs";
import { enablePush, getPushStatus, refreshPushStatus, subscribePushStatus } from "../lib/webPush";

const POLL_MS = 5 * 60 * 1000; // every 5 minutes while the tab is open
// A reminder at a time is judged against the agenda already held, this often:
// the nudge lands within this long of the minute, without asking the server.
const REMIND_CHECK_MS = 15 * 1000;
const ICON = "/favicon.svg";

export type NotifyPermission = "default" | "granted" | "denied" | "unsupported";

function supported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

// The already-fired notice keys name this account's tasks, so they are kept
// per account. Private mode / quota: de-dupe degrades to per-session.
function readFired(): Set<string> {
  const arr = getPrefJson(PREFS.dueSoonFired);
  return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === "string")) : new Set();
}

function writeFired(keys: Set<string>): void {
  setPrefJson(PREFS.dueSoonFired, [...keys]);
}

/** Show one notice. Prefers the SW registration (clickable on PWA/mobile);
 *  falls back to a plain Notification on desktop browsers without an active SW. */
async function show(notice: DueNotice): Promise<void> {
  const options: NotificationOptions & { renotify?: boolean } = {
    body: notice.body,
    icon: ICON,
    badge: ICON,
    tag: notice.key, // collapse duplicate OS notifications for the same task
    requireInteraction: notice.urgent,
    data: { nodeId: notice.nodeId, taskId: notice.taskId, url: notice.nodeId ? `/?view=notes&node=${notice.nodeId}` : "/?view=tasks" },
  };
  try {
    const reg = await serviceWorkerContainer()?.ready;
    if (reg) {
      await reg.showNotification(notice.title, options);
      return;
    }
  } catch {
    /* fall through to the plain Notification path */
  }
  try {
    new Notification(notice.title, options);
  } catch {
    /* notification blocked at the OS level — nothing we can do, stay silent */
  }
}

export function useDueSoonNotifications(online: boolean) {
  const [permission, setPermission] = useState<NotifyPermission>(
    supported() ? Notification.permission : "unsupported",
  );
  const firedRef = useRef<Set<string>>(readFired());
  const agendaRef = useRef<Agenda | null>(null);
  const tickRef = useRef<() => void>(() => {});

  const requestPermission = useCallback(async () => {
    if (!supported()) return;
    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      // Same click, same permission: also get the reminders when the app is closed (a no-op where the server has no push).
      if (result === "granted") void enablePush();
    } catch {
      setPermission(Notification.permission);
    }
  }, []);

  // Reminders at a time (and what passed while the app was away): from the
  // agenda in hand. The fired set is written before the notice is shown, so a
  // second check, or another tab, cannot show the same moment twice.
  const remind = useCallback(async () => {
    if (!supported() || Notification.permission !== "granted" || !agendaRef.current) return;
    const { notices, firedKeys } = pendingRemindNotices(agendaRef.current, { ms: Date.now(), wall: nowDateTimeId(), dayStartHour: workspaceDayStartHour() }, firedRef.current);
    // Also when nothing is shown: keys of reminders that left the agenda (task finished, moved)
    // are dropped here, so the persisted set cannot grow with every task ever reminded.
    if (notices.length > 0 || firedKeys.size !== firedRef.current.size) {
      firedRef.current = firedKeys;
      writeFired(firedKeys);
    }
    for (const notice of notices) await show(notice);
  }, []);

  // One poll cycle: fetch the agenda, decide what to fire, fire, persist.
  const tick = useCallback(async () => {
    if (!supported() || Notification.permission !== "granted" || !online) return;
    let agenda: Agenda;
    try {
      agenda = await reads.workspace.taskAgenda();
    } catch {
      return; // offline / not permitted — try again next interval
    }
    agendaRef.current = agenda;
    const { notices, firedKeys } = pendingDueNotices(agenda, firedRef.current);
    firedRef.current = firedKeys;
    writeFired(firedKeys);
    for (const notice of notices) await show(notice);
    await remind();
  }, [online, remind]);

  // Keep a stable ref so the interval callback always sees the latest tick
  // without re-arming the timer on every render.
  useEffect(() => { tickRef.current = tick; }, [tick]);
  const remindRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => { remindRef.current = remind; }, [remind]);

  // Lock-screen reminders can be turned on from Settings too: pick up the permission it asked for.
  useEffect(() => subscribePushStatus(() => {
    if (supported() && getPushStatus().subscribed) setPermission(Notification.permission);
  }), []);

  useEffect(() => {
    if (permission !== "granted") return;
    void refreshPushStatus();
    void tickRef.current();
    const id = window.setInterval(() => void tickRef.current(), POLL_MS);
    const remindId = window.setInterval(() => void remindRef.current(), REMIND_CHECK_MS);
    // Re-check when the tab regains focus (laptop wakes, you come back from
    // an errand) — that's exactly when a busy parent wants the nudge.
    const unregisterVisible = register("visible", () => tickRef.current());
    return () => {
      window.clearInterval(id);
      window.clearInterval(remindId);
      unregisterVisible();
    };
  }, [permission]);

  return { permission, requestPermission, refresh: tick };
}
