import { useT } from "../lib/i18n";
import { useEffect, useState } from "react";
import { refreshPushStatus, usePushStatus } from "../lib/webPush";
import type { SettingContext } from "../lib/settingsTypes";
import PushRemindersRow from "./PushRemindersRow";

// Settings › Notifications: the reminder kinds this device can get. Today that is task reminders
// on the lock screen; a server without push has none, and the page says so instead of staying blank.
export default function PushRemindersSetting({ ctx }: { ctx: SettingContext }) {
  const t = useT();
  const push = usePushStatus();
  // The server's answer arrives after the page opens: say nothing until it has.
  const [asked, setAsked] = useState(false);
  useEffect(() => { void refreshPushStatus().finally(() => setAsked(true)); }, []);
  return (
    <>
      <PushRemindersRow online={ctx.online} />
      {asked && !push.available && <p className="settings-hint">{t("This server can't send reminders to your devices.")}</p>}
    </>
  );
}
