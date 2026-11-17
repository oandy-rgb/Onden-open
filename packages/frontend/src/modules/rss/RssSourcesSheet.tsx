import { useRef, useState } from "react";
import { MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import ShellDialog from "../../components/ShellDialog";
import { Button, Pressable, Select, TextField } from "../../components/ui";
import { ApiError } from "../../lib/api";
import { rssWriter, sendOrQueue, writeErrors } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { displayTitle } from "../../lib/noteLabel";
import { dateLabel } from "../../lib/timeLabels";
import { isEnterKey } from "../../lib/keys";
import type { Tag } from "../../lib/api";
import RssDestinationFields from "./RssDestinationFields";
import { groupSources } from "./groupSources";
import type { RssDestination, RssSource, RssVoice } from "./useRssUnread";
import { unmute, useRssMutes } from "./rssMutes";
import "./RssSheets.css";

// 「來源」面板: everything about WHICH feeds you follow, kept off the reading
// path. The reader's first screen is articles; the chip row (RssSourceBar)
// only picks what to look at. Adding a feed (offline-capturable, idempotent on
// the URL), fetching one now, and opening one feed's settings (⋯, which holds
// 編輯 / 取消訂閱) all live here, the same on phone and desktop.

type Props = {
  sources: readonly RssSource[];
  tags: readonly Pick<Tag, "id" | "name" | "parent_id">[];
  online: boolean;
  quickTagIds?: readonly string[];
  onClose: () => void;
  /** One feed's ⋯: its settings sheet. */
  onEdit: (source: RssSource) => void;
  /** A line for the reader to say (the result of a subscribe or a refresh). */
  onNotice: (message: string) => void;
  /** A feed was added or fetched: the reader reloads its counts and list. */
  onChangedFeeds: () => void;
};


export default function RssSourcesSheet({ sources, tags, online, quickTagIds, onClose, onEdit, onNotice, onChangedFeeds }: Props) {
  const t = useT();
  const [url, setUrl] = useState("");
  // The new feed's own save default, when the person sets one while subscribing.
  const [dest, setDest] = useState<RssDestination | null>(null);
  // 「聲音」: left on auto, the server guesses from the feed; the person can say which.
  const [voice, setVoice] = useState<"auto" | RssVoice>("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const { mutes, reload: reloadMutes } = useRssMutes();
  const groups = groupSources(sources, tags);
  const showGroupHeads = groups.some((g) => g.tagId !== null);

  async function subscribe() {
    const feedUrl = url.trim();
    if (!feedUrl || running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      // sendOrQueue queues the subscribe when offline (or on a transient 5xx) and
      // the reconnect drain replays it; a 4xx (already subscribed / unreachable
      // feed) is rethrown and the input is kept.
      const body = { url: feedUrl, ...(dest ? { save_default: { tag_ids: dest.tagIds, parent_id: dest.parentId } } : {}), ...(voice === "auto" ? {} : { voice }) };
      const res = await sendOrQueue("POST", "/api/rss/subscribe", JSON.stringify(body));
      setUrl("");
      setDest(null);
      setVoice("auto");
      // Not writeErrors.queuedMessage(): a subscription is not a saved change, the server has to fetch the feed first.
      onNotice(res === undefined
        ? t("Saved on this device — we'll subscribe when the server is reachable.")
        : t("Subscribed — fetching the feed now."));
      if (res !== undefined) onChangedFeeds();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError && e.code === "feed_too_large"
        ? t("This feed is too large to subscribe to (over 25 MB). Try the site's summary feed instead.")
        : writeErrors.requestMessage(e, t("Subscribe failed")));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function refresh(id: string) {
    try {
      await rssWriter.refreshSource(id);
      onNotice(t("Refreshing…"));
      onChangedFeeds();
    } catch (e) {
      setError(writeErrors.requestMessage(e, t("Refresh failed")));
    }
  }

  async function bringBack(id: string) {
    try {
      await unmute(id);
      await reloadMutes();
      onChangedFeeds();
    } catch (e) {
      setError(writeErrors.requestMessage(e, t("Could not bring it back")));
    }
  }

  return (
    <ShellDialog sheet className="rss-sheet rss-sources-sheet" label={t("Sources")} busy={busy} onClose={onClose}>
      <div className="rss-sheet-head">
        <h3 className="rss-sheet-title">{t("Sources")}</h3>
      </div>

      <div className="rss-sheet-section rss-subscribe-row">
        <TextField
          className="rss-subscribe-input"
          placeholder={t("Feed URL — https://…/feed.xml")}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (isEnterKey(e)) void subscribe(); }}
          aria-label={t("Feed URL — https://…/feed.xml")}
        />
        <Pressable className="rss-subscribe-btn" disabled={busy || !url.trim()} onClick={() => void subscribe()}>
          <Plus size={12} /> {t("Subscribe")}
        </Pressable>
        <Pressable type="button" className="rss-subscribe-dest-toggle" aria-expanded={dest !== null}
          onClick={() => setDest((d) => (d ? null : { tagIds: [], parentId: null }))}>
          {dest ? t("No save default") : t("Save to…")}
        </Pressable>
        {dest && (
          <div className="rss-subscribe-dest">
            <RssDestinationFields value={dest} onChange={setDest} quickTagIds={quickTagIds} />
          </div>
        )}
        <label className="rss-subscribe-voice">
          <span className="rss-sheet-label">{t("Who writes it")}</span>
          <Select className="rss-sheet-select" value={voice} onChange={(e) => setVoice(e.target.value as "auto" | RssVoice)}>
            <option value="auto">{t("Work it out for me")}</option>
            <option value="person">{t("A personal writer")}</option>
            <option value="media">{t("A publication")}</option>
          </Select>
        </label>
        {error && <p className="rss-sheet-error" role="alert">{error}</p>}
      </div>

      <div className="rss-sheet-section rss-source-list">
        {sources.length === 0 && <p className="rss-sheet-hint">{t("No subscriptions yet — paste a feed URL above.")}</p>}
        {groups.map((group) => (
          <div key={group.tagId ?? "_loose"} className="rss-source-group" role="group"
            aria-label={group.tagId ? `#${group.label}` : t("Other feeds")}>
            {showGroupHeads && <div className="rss-source-group-head">{group.tagId ? `#${group.label}` : t("Other feeds")}</div>}
            {group.sources.map((s) => (
              <div key={s.id} className="rss-source-row" data-source-id={s.id}>
                <span className="rss-source-name" title={s.last_error ? t("The last fetch failed. Try Fetch now again later.") : s.url ?? undefined}>
                  {s.last_error ? "⚠ " : ""}{s.title}
                </span>
                <Pressable className="rss-source-refresh" disabled={!online} title={t("Fetch now")} aria-label={t("Fetch now")}
                  onClick={() => void refresh(s.id)}>
                  <RefreshCw size={13} />
                </Pressable>
                <Pressable className="rss-source-more" title={t("Feed settings")} aria-label={t("Feed settings for {title}", { title: s.title })}
                  onClick={() => onEdit(s)}>
                  <MoreHorizontal size={15} />
                </Pressable>
              </div>
            ))}
          </div>
        ))}
      </div>

      {mutes && mutes.length > 0 && (
        <div className="rss-sheet-section rss-mutes">
          <span className="rss-sheet-label">{t("Muted for now")}</span>
          {mutes.map((m) => (
            <div key={m.id} className="rss-source-row" data-mute-id={m.id}>
              <span className="rss-source-name">
                {m.keyword !== null ? t("Titles with “{word}”", { word: m.keyword }) : t("{title} (all articles)", { title: displayTitle(m.source_title) })}
                <span className="rss-mute-until"> · {t("until {date}", { date: dateLabel(m.expires_at, "short") })}</span>
              </span>
              <Button type="button" variant="ghost" size="sm" onClick={() => void bringBack(m.id)}>{t("Show again")}</Button>
            </div>
          ))}
        </div>
      )}

      <div className="rss-sheet-actions rss-sheet-foot">
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{t("Close")}</Button>
      </div>
    </ShellDialog>
  );
}
