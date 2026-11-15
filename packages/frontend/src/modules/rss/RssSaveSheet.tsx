import { useRef, useState } from "react";
import ShellDialog from "../../components/ShellDialog";
import { Button, Pressable } from "../../components/ui";
import { useT } from "../../lib/i18n";
import RssDestinationFields from "./RssDestinationFields";
import type { RssDestination } from "./useRssUnread";
import "./RssSheets.css";

// 存下來 → 「存到」: where this article goes, pre-filled with its feed's
// default (the source's own, else the RSS module's, else top level). One tap
// on 存 keeps the defaults; changing a field saves there instead, for this
// article only (the feed's default is changed in its settings). The sheet
// waits for the save: it closes when the save is accepted or queued, and
// keeps the choice when it fails.

type Props = {
  title: string;
  defaultDestination: RssDestination;
  quickTagIds?: readonly string[];
  /** Save at `destination`, or at the feed's default when it is undefined
   *  (nothing changed). Resolves when accepted or queued; throws to keep the
   *  sheet open (the caller reports why). */
  onSave: (destination: RssDestination | undefined) => Promise<void>;
  onClose: () => void;
};

const same = (a: RssDestination, b: RssDestination) =>
  a.parentId === b.parentId && a.tagIds.length === b.tagIds.length && a.tagIds.every((id, i) => id === b.tagIds[i]);

export default function RssSaveSheet({ title, defaultDestination, quickTagIds, onSave, onClose }: Props) {
  const t = useT();
  const [dest, setDest] = useState<RssDestination>(defaultDestination);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const changed = !same(dest, defaultDestination);

  async function save() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await onSave(changed ? dest : undefined);
    } catch {
      // The caller reported it; keep the choice for a retry.
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <ShellDialog sheet className="rss-sheet rss-save-sheet" label={t("Save to")} busy={busy} onClose={onClose}>
      <div className="rss-sheet-head">
        <h3 className="rss-sheet-title">{t("Save to")}</h3>
        <p className="rss-sheet-sub">{title}</p>
      </div>
      <div className="rss-sheet-section">
        <RssDestinationFields value={dest} onChange={setDest} quickTagIds={quickTagIds} disabled={busy} />
        {changed && (
          <p className="rss-sheet-hint">
            {t("Only this article goes here. ")}
            <Pressable type="button" className="rss-dest-link" disabled={busy} onClick={() => setDest(defaultDestination)}>{t("Back to the default")}</Pressable>
          </p>
        )}
      </div>
      <div className="rss-sheet-actions rss-sheet-foot">
        <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>{t("Cancel")}</Button>
        <Button type="button" variant="primary" className="rss-save-confirm" disabled={busy} onClick={() => void save()}>
          {busy ? t("Saving…") : t("Save it")}
        </Button>
      </div>
    </ShellDialog>
  );
}
