import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { useTagRows, useAllNodes } from "../../lib/appStore";
import { useT } from "../../lib/i18n";
import { tagPath } from "../../lib/data";
import { isSystemTag } from "../../lib/systemNodes";
import { isTagShown, listsAsNote } from "../../lib/nodeTags";
import { isEnterKey, isEscapeKey, isImeComposing } from "../../lib/keys";
import { tagSuggestions } from "../../lib/tagSuggestions";
import { Popover, useInlinePopover } from "../../components/ui";
import ParentPicker from "../../components/ParentPicker";
import type { ContentNode, Tag } from "../../lib/api";
import type { RssDestination } from "./useRssUnread";
import { displayTitle } from "../../lib/noteLabel";
import "../../components/ObsidianImport.css";
import "../../components/NoteRelations.css";
import "./RssSheets.css";
import { isListNavKey, stepActive } from "../../lib/listNav";
import { Pressable, TextField, keepFocus } from "../../components/ui";

// 「存到」 — where a saved article goes: tags used like folders, and an
// optional parent NOTE (never a tag: the picker lists notes only, the server
// refuses anything else). Edits a destination in place; saving it is the
// caller's (the save sheet, a feed's settings, the module default).
// The tag field is TitleTagRow's finder (lib/tagSuggestions) over existing tags;
// the parent field is the note ParentPicker, offered notes only.

type Props = {
  value: RssDestination;
  onChange: (next: RssDestination) => void;
  /** One-tap extra tags offered under the field (other feeds' folders). */
  quickTagIds?: readonly string[];
  disabled?: boolean;
};

const NO_TAGS: Tag[] = [];
/** ParentPicker picks a parent for a note; the article is not one yet, so it
 *  stands in as a note with no children. */
const NEW_ARTICLE_ID = "rss-new-article";

export default function RssDestinationFields({ value, onChange, quickTagIds = [], disabled }: Props) {
  const t = useT();
  const tags = useTagRows() ?? NO_TAGS;
  const nodes = useAllNodes();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [picking, setPicking] = useState(false);

  const visible = useMemo(() => tags.filter((tag) => !isSystemTag(tag)), [tags]);
  const chosen = new Set(value.tagIds);
  const suggestions = query ? tagSuggestions(visible.filter((tag) => !chosen.has(tag.id)), query, 6) : [];
  // One-tap tags: never a hidden one (lib/nodeTags isTagShown).
  const quick = quickTagIds.filter((id) => !chosen.has(id) && visible.some((tag) => tag.id === id && isTagShown(tag))).slice(0, 6);
  const label = (id: string) => tagPath(tags, id) || t("(deleted tag)");
  // The list hangs under the input and leaves focus in it (the input owns ↑/↓/Enter/Esc).
  const options = useInlinePopover<HTMLInputElement>({ open: suggestions.length > 0, onClose: () => setQuery(""), placement: "bottom-start" });

  const parent = value.parentId ? nodes.find((n) => n.id === value.parentId) ?? null : null;
  // A parent is a note, never a tag (or a board): only notes are offered.
  const notes = useMemo(() => nodes.filter(listsAsNote), [nodes]);
  const article = { id: NEW_ARTICLE_ID, parent_id: value.parentId } as ContentNode;

  function addTag(id: string) {
    if (chosen.has(id)) return;
    onChange({ ...value, tagIds: [...value.tagIds, id] });
    setQuery("");
    setActive(0);
  }

  return (
    <div className="rss-dest">
      <div className="rss-dest-row">
        <span className="rss-sheet-label" id="rss-dest-tags">{t("Tags")}</span>
        <div className="obsidian-prop-strip rss-dest-tags" aria-labelledby="rss-dest-tags">
          {value.tagIds.map((id) => (
            <span key={id} className="prop-tag prop-tag--applied">
              <span className="prop-tag-name">#{label(id)}</span>
              <Pressable type="button" className="prop-tag-remove" disabled={disabled}
                aria-label={t("Remove #{name}", { name: label(id) })}
                onClick={() => onChange({ ...value, tagIds: value.tagIds.filter((tagId) => tagId !== id) })}>
                <X size={11} />
              </Pressable>
            </span>
          ))}
          <span className="title-tag-add">
            <TextField
              ref={options.anchor}
              className="title-tag-input rss-dest-input"
              value={query}
              disabled={disabled}
              placeholder={t("Add a tag…")}
              aria-label={t("Add a tag")}
              role="combobox"
              aria-expanded={suggestions.length > 0}
              aria-controls="rss-dest-tag-options"
              onChange={(e) => { setQuery(e.target.value); setActive(0); }}
              onKeyDown={(e) => {
                if (isImeComposing(e)) return;
                if (isEscapeKey(e) && query) { e.preventDefault(); e.stopPropagation(); setQuery(""); }
                else if (isListNavKey(e.key)) { e.preventDefault(); setActive((i) => stepActive(e.key, i, suggestions.length)!); }
                else if (isEnterKey(e) && suggestions.length) { e.preventDefault(); addTag(suggestions[Math.min(active, suggestions.length - 1)]!.id); }
              }}
            />
            {suggestions.length > 0 && (
              <Popover popover={options} label={t("Suggestions")} role="group" className="title-tag-popover">
              <ul id="rss-dest-tag-options" className="title-tag-options" role="listbox">
                {suggestions.map((tag, i) => (
                  <li key={tag.id} role="option" aria-selected={i === active} className={i === active ? "active" : undefined}
                    onMouseDown={(e) => { keepFocus(e); addTag(tag.id); }}>#{label(tag.id)}</li>
                ))}
              </ul>
              </Popover>
            )}
          </span>
        </div>
        {quick.length > 0 && (
          <div className="rss-dest-quick" role="group" aria-label={t("Quick tags")}>
            {quick.map((id) => (
              <Pressable key={id} type="button" className="rss-dest-chip" disabled={disabled} onClick={() => addTag(id)}>+ #{label(id)}</Pressable>
            ))}
          </div>
        )}
      </div>

      <div className="rss-dest-row">
        <span className="rss-sheet-label" id="rss-dest-parent">{t("Inside note")}</span>
        <div className="rss-dest-parent" aria-labelledby="rss-dest-parent">
          <span className="rss-dest-parent-value">
            {value.parentId ? (displayTitle(parent?.title)) : t("Top level (no parent note)")}
          </span>
          {value.parentId && (
            <Pressable type="button" className="rss-dest-link" disabled={disabled} onClick={() => onChange({ ...value, parentId: null })}>
              {t("Top level")}
            </Pressable>
          )}
          {!picking && (
            <Pressable type="button" className="rss-dest-link" disabled={disabled} onClick={() => setPicking(true)}>
              {t("Choose a note…")}
            </Pressable>
          )}
        </div>
        {picking && (
          <ParentPicker node={article} nodes={notes}
            onPick={(parentId) => onChange({ ...value, parentId })}
            onClose={() => setPicking(false)} />
        )}
      </div>
    </div>
  );
}

/** "#新聞/科技 · 在「閱讀」裡" — a destination in one short line. */
export function destinationLabel(
  dest: RssDestination & { parentTitle?: string | null },
  tags: Parameters<typeof tagPath>[0],
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const tagText = dest.tagIds.map((id) => tagPath(tags, id)).filter(Boolean).map((p) => `#${p}`).join(" ");
  const parentText = dest.parentId ? t("in “{title}”", { title: displayTitle(dest.parentTitle) }) : "";
  return [tagText, parentText].filter(Boolean).join(" · ") || t("Top level");
}
