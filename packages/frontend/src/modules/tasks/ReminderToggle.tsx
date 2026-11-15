import { Bell, BellOff, BellRing } from "lucide-react";
import { Pressable } from "../../components/ui";
import { useT } from "../../lib/i18n";
import { addToast } from "../../lib/appStore";
import type { PhoneTopbarAction } from "../../lib/phoneTopbarActions";
import type { NotifyPermission } from "../../hooks/useDueSoonNotifications";
import { usePushStatus } from "../../lib/webPush";
import { pushProblemText } from "../../lib/pushProblemText";

/** Whether the browser may show task reminders; a button when it still can be asked. */
export default function ReminderToggle({ permission, onEnable }: { permission: NotifyPermission; onEnable: () => void }) {
  const t = useT();
  const push = usePushStatus();
  if (permission === "unsupported") return null;
  if (permission === "granted") {
    return (
      <>
        {push.problem && <span className="tasks-reminder-problem" role="status">{pushProblemText(push.problem)}</span>}
        <span className="tasks-reminder tasks-reminder--on" title={t("Due-soon reminders are on. You'll get a notification when a task is due or overdue.")}>
          <BellRing size={14} /> {t("Reminders on")}
        </span>
      </>
    );
  }
  if (permission === "denied") {
    return (
      <span className="tasks-reminder tasks-reminder--off" title={t("Reminders are blocked in your browser settings. Re-enable notifications for this site to get due-soon nudges.")}>
        <BellOff size={14} /> {t("Reminders blocked")}
      </span>
    );
  }
  return (
    <Pressable type="button" className="tasks-reminder tasks-reminder--cta" onClick={onEnable} title={t("Get a notification when a task is due or overdue, even if this tab is in the background.")}>
      <Bell size={14} /> {t("Remind me when due")}
    </Pressable>
  );
}

/** The phone's top-bar form of the toggle: a quiet bell, only while reminders
 *  are off. Blocked in the browser, a tap says why (the app cannot reopen that
 *  choice, so the words point at the site settings); otherwise it asks. */
export function reminderAction(permission: NotifyPermission, onEnable: () => void, t: (key: string) => string): PhoneTopbarAction | null {
  if (permission === "denied") {
    return {
      id: "reminders", label: t("Reminders blocked"), Icon: BellOff,
      onSelect: () => addToast(t("Reminders are blocked in your browser settings. Re-enable notifications for this site to get due-soon nudges."), "info"),
    };
  }
  if (permission === "default") return { id: "reminders", label: t("Remind me when due"), Icon: Bell, onSelect: onEnable };
  return null;
}
