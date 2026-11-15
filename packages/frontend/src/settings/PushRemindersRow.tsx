import { useEffect } from "react";
import { Button } from "../components/ui";
import { useT } from "../lib/i18n";
import { pushProblemText } from "../lib/pushProblemText";
import { disablePush, enablePush, refreshPushStatus, usePushStatus } from "../lib/webPush";
import { DataRow } from "./DataRow";

// Settings › Notifications › 鎖屏提醒: whether THIS device gets task reminders from the
// server while the screen is locked or the app is closed (lib/webPush.ts). Per device,
// not per account: another phone has its own row. Absent when the server has no push.

export default function PushRemindersRow({ online }: { online: boolean }) {
  const t = useT();
  const push = usePushStatus();
  useEffect(() => { void refreshPushStatus(); }, []);
  if (!push.available) return null;

  return (
    <DataRow
      title={t("Lock-screen reminders")}
      hint={push.subscribed
        ? t("This device gets task reminders on time, even when the screen is locked or the app is closed.")
        : t("Get task reminders on time on this device, even when the screen is locked or the app is closed.")}
      action={push.subscribed ? (
        <Button variant="secondary" disabled={push.busy} onClick={() => void disablePush()}>{t("Turn off")}</Button>
      ) : (
        <Button variant="secondary" disabled={push.busy || !online} onClick={() => void enablePush()}>{t("Turn on")}</Button>
      )}
    >
      {push.problem && <p className="settings-hint" role="status">{pushProblemText(push.problem)}</p>}
      {!push.subscribed && !online && <p className="settings-hint">{t("Connect to turn on lock-screen reminders.")}</p>}
    </DataRow>
  );
}
