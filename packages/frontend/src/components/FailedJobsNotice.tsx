import { useFailedDeliveries } from "../hooks/useFailedDeliveries";
import { useT } from "../lib/i18n";
import { openSettings } from "../lib/settingsRequest";
import { Pressable } from "./ui";

/** One line for the owner when background jobs stopped retrying, pointing
 *  to Settings › System status where they are listed. Never a card per job,
 *  and nothing for anyone else or when every job went through. */
export default function FailedJobsNotice({ online }: { online: boolean }) {
  const t = useT();
  const { isOwner, total } = useFailedDeliveries(online);
  if (!isOwner || total === 0) return null;
  return (
    <Pressable type="button" className="failed-jobs-notice" onClick={() => openSettings("about")}>
      {t("⚠ {n} background jobs failed → View", { n: total })}
    </Pressable>
  );
}
