import { useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n";
import { isEscapeKey, isImeComposing } from "../lib/keys";
import { useFieldDraft } from "../hooks/useFieldDraft";
import { Pressable, TextArea } from "./ui";

// A tag's description is its own body (the class_tag node's markdown), shown
// under the title on its page and as the row's line on 全部標籤. The owner
// edits it in place: click, type, leave the box (or ⌘/Ctrl+Enter) to save,
// Esc to put it back. Others read it; an empty one is not shown to them.
// A description of more than three lines folds to three, with 「展開」 / 「收起」.

type Props = {
  markdown: string;
  canEdit: boolean;
  /** Save the new body; `base` is the body the edit started from (the
   *  server merges it like any note body). */
  onSave: (markdown: string, base: string) => Promise<void> | void;
};

/** More than three lines (or long enough to wrap past them) folds. */
const FOLD_LINES = 3;
const FOLD_CHARS = 180;
const isLong = (text: string) => text.trim().split("\n").length > FOLD_LINES || text.trim().length > FOLD_CHARS;

export default function TagDescription({ markdown, canEdit, onSave }: Props) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  // The text typed so far; saved when the box is left, the tag page goes away or the page is hidden (useFieldDraft).
  const draft = useFieldDraft<Props["onSave"]>({
    target: onSave, targetKey: "description", committed: markdown,
    commit: (save, text, { base }) => save(text, base),
  });
  const [expanded, setExpanded] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (editing) box.current?.focus(); }, [editing]);

  const folded = isLong(markdown) && !expanded;
  const foldToggle = isLong(markdown) && (
    <Pressable type="button" className="tag-description-fold" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
      {t(expanded ? "Fold description" : "Unfold description")}
    </Pressable>
  );
  if (!canEdit) return markdown.trim() ? <><p className={`tag-description${folded ? " is-folded" : ""}`}>{markdown.trim()}</p>{foldToggle}</> : null;

  function start() { setEditing(true); }
  function finish(save: boolean) {
    setEditing(false);
    if (save) void draft.flush();
    else draft.discard();
  }

  return editing ? (
    <TextArea ref={box} className="tag-description tag-description-input" value={draft.text} rows={Math.min(8, Math.max(2, draft.text.split("\n").length + 1))}
      aria-label={t("Description")} placeholder={t("What this tag is for, in a sentence or two.")}
      onChange={(e) => draft.edit(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (isImeComposing(e)) return;
        if (isEscapeKey(e)) { e.preventDefault(); e.stopPropagation(); finish(false); }
        else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true); }
      }} />
  ) : (
    <>
      <Pressable type="button" className={`tag-description tag-description-edit${markdown.trim() ? "" : " is-empty"}${folded ? " is-folded" : ""}`} onClick={start}
        aria-label={markdown.trim() ? t("Edit the description") : undefined} title={t("The description is this tag's own text. Click to edit it.")}>
        {markdown.trim() || t("No description yet. Click to add one.")}
      </Pressable>
      {foldToggle}
    </>
  );
}
