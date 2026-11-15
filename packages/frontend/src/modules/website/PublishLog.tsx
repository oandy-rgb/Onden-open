import PublishedSnapshots from "./PublishedSnapshots";
import { useT } from "../../lib/i18n";

// 發布紀錄 on the website page: the published snapshots and 「發布…」, moved
// here from the workspace changes view (the same PublishedSnapshots the
// website module still offers there until that view drops it).
export default function PublishLog({ online, onRefresh }: { online: boolean; onRefresh: () => void }) {
  const t = useT();
  return (
    <section className="publish-log" aria-label={t("Publish log")}>
      <h3 className="hs-section__title publish-log__title">{t("Publish log")}</h3>
      <PublishedSnapshots online={online} onRefresh={onRefresh} />
    </section>
  );
}
