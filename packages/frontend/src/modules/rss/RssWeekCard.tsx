import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { addToast, useAllNodes } from "../../lib/appStore";
import { reads, writeErrors } from "../../lib/data";
import { nodeNeedsBody } from "../../lib/api";
import { useT, tn } from "../../lib/i18n";
import { dateIdAt } from "../../lib/localDate";
import { getPref, setPref, PREFS } from "../../lib/prefs";
import { displayTitle } from "../../lib/noteLabel";
import { Button } from "../../components/ui";
import { ellipsize } from "@onden/markdown";
import { excerptEmbed, startWeekDraft } from "./rssQuote";
import { excerptsThisWeek, notesOfThisWeek, weekStartId } from "./weekReading";
import type { RssDestination } from "./useRssUnread";

// A quiet card above the list: what you took from your feeds this week, and a
// way to turn it into a draft. Only when there is something; closing it hides
// it until next week. Not a goal and not a count to beat.

type Props = {
  today: string;
  destination: RssDestination;
  /** The draft is made: open it. */
  onOpenDraft: (nodeId: string) => void;
};

const SHOWN = 3;
/** The most slim notes read at once for the card. */
const MAX_FETCHED = 12;

export default function RssWeekCard({ today, destination, onOpenDraft }: Props) {
  const t = useT();
  const nodes = useAllNodes();
  const week = weekStartId(today);
  const [closed, setClosed] = useState(() => getPref(PREFS.rssWeekCardClosed) === week);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const dayOf = (iso: string) => dateIdAt(new Date(iso));
  const weekNotes = useMemo(() => notesOfThisWeek(nodes, today, (iso) => dateIdAt(new Date(iso))).map((w) => w.note), [nodes, today]);
  // A note the store holds without its text (a long one) is read once, a few at a time, so its excerpts count too.
  const [fetched, setFetched] = useState<ReadonlyMap<string, string>>(new Map());
  const wanted = weekNotes.filter((n) => nodeNeedsBody(n) && !fetched.has(n.id)).map((n) => n.id).filter((_, i) => i < MAX_FETCHED);
  const wantedKey = wanted.join(",");
  useEffect(() => {
    if (!wantedKey) return;
    let live = true;
    void Promise.all(wantedKey.split(",").map(async (id) => [id, (await reads.notes.full(id)).markdown ?? ""] as const))
      .then((rows) => { if (live) setFetched((prev) => new Map([...prev, ...rows])); })
      .catch(() => { /* offline: the notes held with their text still count */ });
    return () => { live = false; };
  }, [wantedKey]);
  const found = useMemo(
    () => excerptsThisWeek(weekNotes, today, dayOf, (n) => (nodeNeedsBody(n as never) ? fetched.get(n.id) : n.markdown)),
    [weekNotes, today, fetched]);
  if (closed || found.length === 0) return null;

  async function makeDraft() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const { nodeId, status } = await startWeekDraft({
        embeds: found.map((f) => excerptEmbed(displayTitle(f.noteTitle), f.excerpt.exact)),
        destination,
      });
      if (status === "queued") addToast(writeErrors.queuedMessage(), "info");
      onOpenDraft(nodeId);
    } catch (e) {
      writeErrors.report(e, addToast);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="rss-week" aria-label={t("Read this week")}>
      <div className="rss-week-head">
        <h4 className="rss-week-title">{t("Read this week")}</h4>
        <Button variant="ghost" size="sm" className="rss-week-hide" title={t("Hide until next week")} aria-label={t("Hide until next week")}
          onClick={() => { setPref(PREFS.rssWeekCardClosed, week); setClosed(true); }}><X size={14} aria-hidden="true" /></Button>
      </div>
      <ul className="rss-week-list">
        {found.filter((_, i) => i < SHOWN).map((f) => (
          <li key={`${f.noteId}-${f.excerpt.id}`}>“{ellipsize(f.excerpt.exact, 70)}” <span className="rss-week-from">{f.excerpt.feed}</span></li>
        ))}
      </ul>
      {found.length > SHOWN && <p className="rss-week-more">{tn("And 1 more.", "And {n} more.", found.length - SHOWN)}</p>}
      <Button type="button" variant="secondary" disabled={busy} onClick={() => void makeDraft()}>{t("Write about it")}</Button>
    </section>
  );
}
