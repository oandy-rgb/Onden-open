import { useRef, useState } from "react";
import ShellDialog from "../../components/ShellDialog";
import { Button, Checkbox, Select } from "../../components/ui";
import { sendWrite, writeErrors } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { muteFeed } from "./rssMutes";
import RssDestinationFields from "./RssDestinationFields";
import type { RssDestination, RssDisplayMode, RssSource, RssVoice } from "./useRssUnread";
import { setFeedCountChoice, useRssCounts, type FeedCountChoice } from "./rssCounts";
import "./RssSheets.css";

// One feed's settings sheet in 閱讀 › RSS (the ⋯ beside a feed). 「存到」
// is the feed's own save default (PATCH /api/rss/sources/:id save_default):
// saving it makes it explicit; 「清除這個訂閱的預設」 clears it, so the feed
// falls back to the RSS module's default (Settings › Modules › RSS). 取消訂閱
// asks once, then POST /api/rss/sources/:id/unsubscribe: the subscription (a
// setting, not a note) is deleted with its stream; articles already saved are
// notes and stay. The sheet stays open, with the error, when the server refuses.
// 未讀數字 is this feed's own choice against 「顯示未讀數字」 (rssCounts),
// kept with the account (rssPrefs) and applied at once.

type Props = {
  source: RssSource;
  online: boolean;
  onClose: () => void;
  /** After the server accepted the unsubscribe. */
  onUnsubscribed: (source: RssSource) => void;
  /** After a setting was saved (refresh the feed list). */
  onChanged: () => void;
  /** After the feed was muted for a week (the list and counts change). */
  onMuted: (source: RssSource) => void;
  quickTagIds?: readonly string[];
};

const ORIGIN_HINT: Record<string, string> = {
  source: "This feed's own default.",
  module: "The RSS module's default (Settings › Modules › RSS).",
  none: "No default: top level, no tags.",
};

export default function RssSourceSheet({ source, online, onClose, onUnsubscribed, onChanged, onMuted, quickTagIds }: Props) {
  const t = useT();
  const initial: RssDestination = source.save_default
    ? { tagIds: source.save_default.tag_ids, parentId: source.save_default.parent_id }
    : { tagIds: [], parentId: null };
  const [dest, setDest] = useState<RssDestination>(initial);
  const [origin, setOrigin] = useState(source.save_default?.origin ?? "none");
  const [saved, setSaved] = useState<string | null>(null);
  const [alwaysFull, setAlwaysFull] = useState(!!source.always_fulltext);
  const [voice, setVoice] = useState<RssVoice>(source.voice ?? "media");
  const [display, setDisplay] = useState<RssDisplayMode>(source.display_mode ?? "text");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const counts = useRssCounts();
  const countChoice = counts.choiceFor(source.id);

  async function unsubscribe() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await sendWrite("POST", `/api/rss/sources/${source.id}/unsubscribe`, {});
      onUnsubscribed(source);
    } catch (e) {
      setError(writeErrors.message(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  /** Save the feed's default (a destination), or clear it (null). */
  async function saveDefault(next: RssDestination | null) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const body = { save_default: next && { tag_ids: next.tagIds, parent_id: next.parentId } };
      const res = await sendWrite<{ save_default?: { tag_ids: string[]; parent_id: string | null; origin: string } }>("PATCH", `/api/rss/sources/${source.id}`, body);
      if (res.save_default) {
        setDest({ tagIds: res.save_default.tag_ids, parentId: res.save_default.parent_id });
        setOrigin(res.save_default.origin as typeof origin);
      }
      setSaved(next ? t("Saved. New saves from this feed go here.") : t("Cleared. This feed uses the fallback default again."));
      onChanged();
    } catch (e) {
      setError(writeErrors.message(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  /** Save one setting of this feed at once (PATCH), showing the server's answer; the sheet stays open with the error when refused. */
  async function patchSetting<T>(body: Record<string, unknown>, applied: (res: T) => void) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      applied(await sendWrite<T>("PATCH", `/api/rss/sources/${source.id}`, body));
      onChanged();
    } catch (e) {
      setError(writeErrors.message(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const setAlwaysFulltext = (on: boolean) => patchSetting<{ always_fulltext?: boolean }>({ always_fulltext: on }, (res) => setAlwaysFull(res.always_fulltext ?? on));
  const changeVoice = (next: RssVoice) => patchSetting<{ voice?: RssVoice }>({ voice: next }, (res) => setVoice(res.voice ?? next));
  const changeDisplay = (next: RssDisplayMode) => patchSetting<{ display_mode?: RssDisplayMode }>({ display_mode: next }, (res) => setDisplay(res.display_mode ?? next));

  /** 靜音一週: this feed leaves YOUR list for a week; the source panel can end it. */
  async function mute() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await muteFeed(source.id);
      onMuted(source);
    } catch (e) {
      setError(writeErrors.message(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <ShellDialog sheet className="rss-sheet" label={t("Feed settings")} busy={busy} onClose={onClose}>
      <div className="rss-sheet-head">
        <h3 className="rss-sheet-title">{source.title}</h3>
        {source.url && <p className="rss-sheet-sub">{source.url}</p>}
      </div>

      <div className="rss-sheet-section">
        <span className="rss-sheet-label">{t("Save to (default)")}</span>
        <RssDestinationFields value={dest} onChange={setDest} quickTagIds={quickTagIds} disabled={busy} />
        <p className="rss-sheet-hint">{t(ORIGIN_HINT[origin] ?? ORIGIN_HINT.none!)}</p>
        <div className="rss-sheet-actions">
          {origin === "source" && (
            <Button type="button" variant="secondary" disabled={busy || !online} onClick={() => void saveDefault(null)}>
              {t("Clear this feed's default")}
            </Button>
          )}
          <Button type="button" variant="primary" disabled={busy || !online} onClick={() => void saveDefault(dest)}>
            {t("Save default")}
          </Button>
        </div>
        {saved && <p className="rss-sheet-hint" role="status">{saved}</p>}
      </div>

      <div className="rss-sheet-section">
        <label className="rss-sheet-check">
          <Checkbox checked={alwaysFull} disabled={busy || !online}
            onChange={(e) => void setAlwaysFulltext(e.target.checked)} />
          {t("Always load the full text")}
        </label>
        <p className="rss-sheet-hint">{t("Otherwise the full article loads by itself only when the feed sends a summary.")}</p>
      </div>

      <div className="rss-sheet-section">
        <label className="rss-sheet-label" htmlFor={`rss-count-${source.id}`}>{t("Unread number")}</label>
        <Select id={`rss-count-${source.id}`} className="rss-sheet-select" value={countChoice ?? "follow"}
          onChange={(e) => setFeedCountChoice(source.id, e.target.value === "follow" ? null : e.target.value as FeedCountChoice)}>
          <option value="follow">{counts.global ? t("As in Settings (shown)") : t("As in Settings (hidden)")}</option>
          <option value="on">{t("Show for this feed")}</option>
          <option value="off">{t("Hide for this feed")}</option>
        </Select>
      </div>

      <div className="rss-sheet-section">
        <label className="rss-sheet-label" htmlFor={`rss-voice-${source.id}`}>{t("Who writes it")}</label>
        <Select id={`rss-voice-${source.id}`} className="rss-sheet-select" value={voice} disabled={busy || !online}
          onChange={(e) => void changeVoice(e.target.value as RssVoice)}>
          <option value="person">{t("A personal writer")}</option>
          <option value="media">{t("A publication")}</option>
        </Select>
        <p className="rss-sheet-hint">{t("The “Voices” tag shows only the feeds of people.")}</p>
      </div>

      <div className="rss-sheet-section">
        <label className="rss-sheet-label" htmlFor={`rss-display-${source.id}`}>{t("How it looks")}</label>
        <Select id={`rss-display-${source.id}`} className="rss-sheet-select" value={display} disabled={busy || !online}
          onChange={(e) => void changeDisplay(e.target.value as RssDisplayMode)}>
          <option value="text">{t("Text")}</option>
          <option value="image">{t("Pictures first")}</option>
          <option value="video">{t("Video and audio")}</option>
        </Select>
        <p className="rss-sheet-hint">{t("Pictures first shows a large picture for each article, good for comics and photography. Video and audio adds a play button.")}</p>
      </div>

      <div className="rss-sheet-section">
        <Button type="button" variant="secondary" disabled={busy || !online} onClick={() => void mute()}>{t("Mute for a week")}</Button>
        <p className="rss-sheet-hint">{t("Its articles leave your list for a week. Nothing is deleted, and you can bring them back from the Sources panel.")}</p>
      </div>

      <div className="rss-sheet-section rss-sheet-danger">
        {confirming ? (
          <div role="group" aria-label={t("Unsubscribe")}>
            <p className="rss-sheet-hint">{t("Unsubscribe from “{title}”? Articles you saved stay where they are; the rest of its articles are removed.", { title: source.title })}</p>
            <div className="rss-sheet-actions">
              <Button type="button" variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>{t("Keep")}</Button>
              <Button type="button" variant="danger" disabled={busy || !online} onClick={() => void unsubscribe()}>
                {busy ? t("Unsubscribing…") : t("Unsubscribe")}
              </Button>
            </div>
          </div>
        ) : (
          <Button type="button" variant="danger" disabled={!online} onClick={() => setConfirming(true)}>{t("Unsubscribe")}</Button>
        )}
        {!online && <p className="rss-sheet-hint">{t("Connect to unsubscribe.")}</p>}
        {error && <p className="rss-sheet-error" role="alert">{error}</p>}
      </div>

      <div className="rss-sheet-actions rss-sheet-foot">
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{t("Close")}</Button>
      </div>
    </ShellDialog>
  );
}
