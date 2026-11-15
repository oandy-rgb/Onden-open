import { Rss } from "lucide-react";
import { useRssUnread } from "./useRssUnread";
import { useRssCounts } from "./rssCounts";
import { useT, tn } from "../../lib/i18n";
import { Pressable } from "../../components/ui";

// The RSS module's HomeStart line — same quiet posture as the review line:
// renders nothing when nothing is unseen, plain words otherwise. A number
// only with 「顯示未讀數字」 on (rssCounts); otherwise it just says there is
// something new.

export default function RssHomeSection({ onOpenReader }: { onOpenReader: () => void }) {
  const t = useT();
  const { sources, hasNew } = useRssUnread();
  const total = useRssCounts().total(sources);
  if (total === null ? !hasNew : total === 0) return null;
  return (
    <div className="home-start-section home-start-rss">
      <span className="home-start-label"><Rss size={11} /> {t("Reading")}</span>
      <ul className="home-start-list">
        <li>
          <Pressable onClick={onOpenReader}>
            {total === null ? t("New articles to skim")
              : tn("1 new article to skim", "{n} new articles to skim", total)}
          </Pressable>
        </li>
      </ul>
    </div>
  );
}
