import { t } from "../lib/i18n";
import type { NoteSearchOutcome } from "../lib/data";

/** One quiet line above search results that came from this device's copy
 *  (the sidebar and the command palette share it). Nothing when online. */
export function SearchOfflineNotice({ outcome, className }: { outcome: Pick<NoteSearchOutcome, "offline" | "fieldFilterSkipped"> | null; className?: string }) {
  if (!outcome?.offline) return null;
  return (
    <p className={className ?? "search-offline-notice"} role="status">
      {t("Offline results")}
      {outcome.fieldFilterSkipped && ` · ${t("Fields can't be filtered offline")}`}
    </p>
  );
}
