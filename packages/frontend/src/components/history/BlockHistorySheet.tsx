import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { reads } from "../../lib/data";
import { blockHistory, describeChange, headingAbove, historyAuthor, type BlockVersion } from "../../lib/history";
import { useT } from "../../lib/i18n";
import { useAccountSession } from "../../lib/accountSession";
import { dayLabel, timeLabel } from "../../lib/timeLabels";
import ShellDialog from "../ShellDialog";
import { Button, Pressable } from "../ui";
import "./BlockHistorySheet.css";

import { ellipsize } from "@onden/markdown";
type Props = {
  nodeId: string;
  /** The note as the editor has it now, and any offset inside the paragraph. */
  markdown: string;
  offset: number;
  /** May the person change the note? Without it there is no 「用這個版本」. */
  canUse: boolean;
  /** Show an older wording in the paragraph; null shows the current one. Display only. */
  onPreview: (text: string | null) => void;
  /** Replace the paragraph with an older wording; `when` says which one for the notice. */
  onUse: (text: string, when: string) => void;
  /** Open the whole note's history at a save (the editor's host decides how). */
  onOpenNoteHistory?: (versionId: string | null) => void;
  onClose: () => void;
};

type Loaded = { status: "loading" } | { status: "failed" } | { status: "ready"; entries: BlockVersion[] };

const SHOWN = 40;
const clip = (s: string) => ellipsize(s, SHOWN);

/** 「這段的歷史」: the wordings one paragraph has had, one at a time, oldest to
 *  now. A phone shows it as a bottom sheet, a desktop as a side panel. The
 *  paragraph itself shows the wording being looked at (onPreview). */
export default function BlockHistorySheet({ nodeId, markdown, offset, canUse, onPreview, onUse, onOpenNoteHistory, onClose }: Props) {
  const t = useT();
  const selfName = useAccountSession()?.user.name ?? null;
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [index, setIndex] = useState(0);
  useEffect(() => {
    let live = true;
    reads.notes.rawVersions(nodeId).then(
      (rows) => {
        if (!live) return;
        const entries = blockHistory(rows, { markdown, offset });
        setLoaded({ status: "ready", entries });
        setIndex(Math.max(0, entries.length - 1));
      },
      () => { if (live) setLoaded({ status: "failed" }); },
    );
    return () => { live = false; };
    // The sheet looks at the note as it was when opened.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const entries = loaded.status === "ready" ? loaded.entries : [];
  const shown: BlockVersion | undefined = entries[index];
  const current = entries[entries.length - 1];
  useEffect(() => { if (shown) onPreview(shown.current ? null : shown.text); }, [shown]); // eslint-disable-line react-hooks/exhaustive-deps
  const heading = useMemo(() => headingAbove(markdown, offset), [markdown, offset]);

  const whenLabel = (v: BlockVersion) => (v.changedAt ? `${dayLabel(v.changedAt)} ${timeLabel(v.changedAt)}` : t("Now, not saved yet"));
  // The same rule as the note's history (historyAuthor): 「你」 only for the signed-in person, never for an author with no name.
  const author = (v: BlockVersion): { label: string; tone: "agent" | "system" | "member" | "self" } | null => {
    if (!v.changedAt) return null;
    const who = historyAuthor(v.actorKind, v.actorName, selfName, v.onAnotherDevice);
    return { label: who.text, tone: who.tone === "session" ? "member" : who.tone };
  };

  const change = shown && current ? describeChange(shown.text, current.text) : null;
  const sentence = !change ? "" : change.kind === "same" ? t("This is the current text")
    : change.kind === "added" ? t("Compared with this version, the text now has this more: “{text}”", { text: clip(change.added) })
    : change.kind === "removed" ? t("Compared with this version, the text now lacks: “{text}”", { text: clip(change.removed) })
    : change.kind === "both" ? t("Compared with this version, the text now has “{added}” and lacks “{removed}”", { added: clip(change.added), removed: clip(change.removed) })
    : t("This version words the whole sentence differently");

  const badge = shown && author(shown);
  const body = () => {
    if (loaded.status === "loading") return <p className="bh-note" role="status">{t("Loading…")}</p>;
    if (loaded.status === "failed") return <p className="bh-note" role="alert">{t("Couldn't load this paragraph's history")}</p>;
    if (!shown || !current) return <p className="bh-note">{t("This part has no history to show")}</p>;
    return (
      <>
        <div className="bh-nav">
          <Pressable type="button" className="bh-step" disabled={index === 0} onClick={() => setIndex(index - 1)}>
            <ChevronLeft size={16} aria-hidden="true" />{t("Older")}
          </Pressable>
          <div className="bh-which" aria-live="polite">
            <span className="bh-when">{whenLabel(shown)}</span>
            <span className="bh-meta">
              {badge && <span className={`bh-actor bh-actor--${badge.tone}`}>{badge.label}</span>}
              <span>{index + 1} / {entries.length}</span>
              {shown.created && <span className="bh-created">{t("Written here first")}</span>}
            </span>
          </div>
          <Pressable type="button" className="bh-step" disabled={index === entries.length - 1} onClick={() => setIndex(index + 1)}>
            {t("Newer")}<ChevronRight size={16} aria-hidden="true" />
          </Pressable>
        </div>
        <p className="bh-change" data-user-content>{sentence}</p>
        <div className="bh-actions">
          {onOpenNoteHistory && (
            <Button variant="secondary" onClick={() => onOpenNoteHistory(shown.versionId)}>{t("See the whole note as it was")}</Button>
          )}
          {canUse && !shown.current && (
            <Button variant="primary" onClick={() => onUse(shown.text, whenLabel(shown))}>{t("Use this version")}</Button>
          )}
        </div>
      </>
    );
  };

  return (
    <ShellDialog sheet label={t("History of this part")} className="block-history-sheet" onClose={onClose}>
      <header className="bh-head">
        <div className="bh-titles">
          <h2 className="bh-title">{t("History of this part")}</h2>
          {loaded.status === "ready" && entries.length > 0 && (
            <p className="bh-sub" data-user-content>
              {heading ? t("Under “{heading}” · {n} versions", { heading: clip(heading), n: entries.length }) : t("{n} versions", { n: entries.length })}
            </p>
          )}
        </div>
        <Button variant="secondary" onClick={onClose}>{t("Done")}</Button>
      </header>
      {body()}
    </ShellDialog>
  );
}
