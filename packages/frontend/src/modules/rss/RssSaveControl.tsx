import { BookmarkCheck, BookmarkPlus, ChevronDown } from "lucide-react";
import { useT } from "../../lib/i18n";
import { Button } from "../../components/ui";

// 存成筆記 — keep the whole article as a note — as a quiet outline control at
// the end of the article, beside 「寫點什麼」 on the same row (quote and write
// first; keeping a whole piece is the second choice, not the reflex). Its
// root is `display: contents`: the buttons and the destination caption are
// items of the row that holds it (.rss-end-actions). Tap saves at the
// feed's default — shown in the tooltip and as a small caption; ▾ opens the
// 「存到」 sheet. Once saved (or queued offline) it reads 已存 · 開啟筆記.

type Props = {
  /** The note the article became, once saved (a client-minted id while queued). */
  savedNodeId: string | null;
  busy: boolean;
  /** Where a tap saves: the feed's default, in one short line. */
  destination: string;
  onSave: () => void;
  onChoose: () => void;
  onOpen: () => void;
};

export default function RssSaveControl({ savedNodeId, busy, destination, onSave, onChoose, onOpen }: Props) {
  const t = useT();
  const cls = "rss-save-ctl";
  if (savedNodeId) {
    return (
      <div className={cls}>
        <Button type="button" variant="secondary" size="sm" className="rss-end-btn rss-act-open" onClick={onOpen} title={t("Open as a note")}>
          <BookmarkCheck size={16} aria-hidden />
          <span className="rss-save-verb">{t("Saved · open note")}</span>
        </Button>
      </div>
    );
  }
  return (
    <div className={cls}>
      <span className="rss-save-split">
        <Button type="button" variant="secondary" size="sm" className="rss-end-btn rss-act-save" disabled={busy} onClick={onSave}
          title={t("Save to notes → {destination}", { destination })}>
          <BookmarkPlus size={16} aria-hidden />
          <span className="rss-save-verb">{t("Save to notes")}</span>
        </Button>
        <Button type="button" variant="secondary" size="sm" className="rss-end-btn rss-act-save-more" disabled={busy} onClick={onChoose}
          aria-label={t("Choose where to save")} title={t("Choose where to save")}>
          <ChevronDown size={14} aria-hidden />
        </Button>
      </span>
      <span className="rss-save-dest">→ {destination}</span>
    </div>
  );
}
