import { useEffect } from "react";
import { useUnseenChanges } from "../hooks/useUnseenChanges";
import { getLocale, useT } from "../lib/i18n";
import { dateLabel } from "../lib/timeLabels";
import { CHANGES, changeText } from "../lib/whatsNew";
import "./WhatsNewSetting.css";

/** Every change, newest first, grouped by day. Opening the page counts as having read them. */
export default function WhatsNewSetting() {
  const t = useT();
  const locale = getLocale();
  const { markAllSeen } = useUnseenChanges();
  useEffect(() => { markAllSeen(); }, [markAllSeen]);
  if (CHANGES.length === 0) return <p className="settings-hint">{t("Nothing to show yet.")}</p>;
  const days = [...new Set(CHANGES.map((change) => change.date))];
  return <div className="settings-whatsnew">
    {days.map((day) => <section key={day}>
      <h3>{/* The change's own calendar day, not a moment: noon UTC read in UTC cannot shift to a neighbouring day. */}
      {dateLabel(`${day}T12:00:00Z`, "medium", "UTC")}</h3>
      <ul>
        {CHANGES.filter((change) => change.date === day).map((change) => <li key={change.id}>{changeText(change, locale)}</li>)}
      </ul>
    </section>)}
  </div>;
}
