import { useMemo } from "react";
import ShellDialog from "../../components/ShellDialog";
import ParentPicker from "../../components/ParentPicker";
import { Button } from "../../components/ui";
import { useAllNodes } from "../../lib/appStore";
import type { ContentNode } from "../../lib/api";
import { useT } from "../../lib/i18n";
import "./RssSheets.css";
import { listsAsNote } from "../../lib/nodeTags";

// Pick the note a quote (or 「寫點什麼」's text) is appended to: the same
// note picker as 「存到」's 「在筆記裡」 (RssDestinationFields → ParentPicker),
// notes only, in a sheet. Picking closes it; the caller appends.

type Props = {
  /** The sheet's title (「引用到…」 / 「加到現有筆記…」). */
  title: string;
  /** What will be added, in one line (the quote, or the article title). */
  subtitle: string;
  onPick: (noteId: string) => void;
  onClose: () => void;
};

const PICKING = { id: "rss-quote-target" } as ContentNode;

export default function RssNotePickSheet({ title, subtitle, onPick, onClose }: Props) {
  const t = useT();
  const nodes = useAllNodes();
  const notes = useMemo(() => nodes.filter(listsAsNote), [nodes]);
  return (
    <ShellDialog sheet className="rss-sheet rss-pick-sheet" label={title} onClose={onClose}>
      <div className="rss-sheet-head">
        <h3 className="rss-sheet-title">{title}</h3>
        <p className="rss-sheet-sub">{subtitle}</p>
      </div>
      <div className="rss-sheet-section">
        <ParentPicker node={PICKING} nodes={notes} onPick={(id) => { if (id) onPick(id); }} onClose={() => {}} />
      </div>
      <div className="rss-sheet-actions rss-sheet-foot">
        <Button type="button" variant="ghost" onClick={onClose}>{t("Cancel")}</Button>
      </div>
    </ShellDialog>
  );
}
