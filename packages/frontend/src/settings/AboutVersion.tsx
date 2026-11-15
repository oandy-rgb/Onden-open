import { useT } from "../lib/i18n";
import { dateLabel } from "../lib/timeLabels";
import { CHANGES } from "../lib/whatsNew";
import { DataRow } from "./DataRow";

// Settings › About: which version this is, named by the day of its newest
// update (the build's own id is for developers, not shown).
export default function AboutVersion() {
  const t = useT();
  const newest = CHANGES[0];
  return (
    <DataRow title={t("Version")}
      hint={newest ? t("Updated {date}", { date: dateLabel(`${newest.date}T12:00:00Z`, "medium", "UTC") }) : t("Nothing to show yet.")} />
  );
}
