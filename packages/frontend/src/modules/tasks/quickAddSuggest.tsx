// Quick-add: the lists that open under the box when the word being typed starts with # (a tag) or
// @ (the note to write the task into). One place decides what is offered and what choosing writes
// into the text; the sheet only renders the list and routes the keys.
//
//   #  → tagSuggestions (the same names the note's tag row offers)
//   @  → reads.notes.search (the one note search; with nothing typed yet, the latest notes)
//
// A chosen @note keeps its id: the text holds a readable "@title", the id travels beside it, so a
// mistyped name can no longer point at some other note.

import { useEffect, useMemo, useState } from "react";
import { Popover, keepFocus, useInlinePopover } from "../../components/ui";
import { useTagRows, useAllNodes } from "../../lib/appStore";
import { reads } from "../../lib/data";
import { useT } from "../../lib/i18n";
import { displayTitle } from "../../lib/noteLabel";
import { listsAsNote } from "../../lib/nodeTags";
import { byUpdatedDesc } from "../../lib/noteOrder";
import { tagSuggestions } from "../../lib/tagSuggestions";
import { classNames } from "../../lib/utils";

export type SuggestToken = { trigger: "#" | "@"; /** What follows the sign so far. */ query: string; /** Where the sign is. */ start: number; /** The end of the word. */ end: number };

/** The #/@ word the caret is in (a sign that starts the text or follows a space), or null. */
export function suggestToken(text: string, caret: number): SuggestToken | null {
  const found = /(?:^|\s)([#@])([^\s#@]*)$/.exec(text.slice(0, caret));
  if (!found) return null;
  const query = found[2]!;
  const start = caret - query.length - 1;
  const after = /^[^\s#@]*/.exec(text.slice(caret))![0];
  return { trigger: found[1] as "#" | "@", query: query + after, start, end: caret + after.length };
}

/** A note in the text: whitespace in its title would end the @word, so it is joined with "_". */
export const mentionWord = (title: string): string => displayTitle(title).trim().replace(/\s+/g, "_");

export type SuggestItem = { key: string; label: string; insert: string; note: { id: string; title: string } | null };

/** What choosing an item does to the text: the word replaced by the item, then a space. */
export function applySuggestion(text: string, token: SuggestToken, item: SuggestItem): { text: string; caret: number } {
  const tail = text.slice(token.end).replace(/^\s+/, "");
  const head = `${text.slice(0, token.start)}${item.insert} `;
  return { text: head + tail, caret: head.length };
}

const limit = 6; // rows per list

export function useSuggestItems(token: SuggestToken | null): SuggestItem[] {
  const tags = useTagRows();
  const nodes = useAllNodes();
  const trigger = token?.trigger ?? null;
  const query = token?.query ?? "";
  const [found, setFound] = useState<{ query: string; items: SuggestItem[] } | null>(null);

  const tagItems = useMemo<SuggestItem[]>(() => {
    if (trigger !== "#") return [];
    const usable = (tags ?? []).filter((tag) => !tag.view_module && !/\s/.test(tag.name));
    return tagSuggestions(usable, query, limit).map((tag) => ({ key: tag.id, label: `#${tag.name}`, insert: `#${tag.name}`, note: null }));
  }, [trigger, tags, query]);

  const recent = useMemo<SuggestItem[]>(() => (trigger === "@" && query === ""
    ? nodes.filter((n) => listsAsNote(n)).sort(byUpdatedDesc).slice(0, limit).map(noteItem) : []), [trigger, query, nodes]);

  useEffect(() => {
    if (trigger !== "@" || query === "") return;
    let current = true;
    const wait = setTimeout(() => {
      reads.notes.search(query).then(({ rows }) => {
        if (current) setFound({ query, items: rows.filter((row) => listsAsNote(row)).slice(0, limit).map(noteItem) });
      }, () => { if (current) setFound({ query, items: [] }); });
    }, 150);
    return () => { current = false; clearTimeout(wait); };
  }, [trigger, query]);

  if (trigger === "#") return tagItems;
  if (trigger === "@") return query === "" ? recent : found?.query === query ? found.items : [];
  return [];
}

const noteItem = (note: { id: string; title: string }): SuggestItem =>
  ({ key: note.id, label: displayTitle(note.title), insert: `@${mentionWord(note.title)}`, note: { id: note.id, title: note.title } });

/** The list under the box; focus stays in the box, which owns ↑ ↓ Enter Esc. */
export function SuggestList({ anchorState, items, active, onChoose }: {
  anchorState: ReturnType<typeof useInlinePopover<HTMLInputElement>>;
  items: SuggestItem[];
  active: number;
  onChoose: (item: SuggestItem) => void;
}) {
  const t = useT();
  return (
    <Popover popover={anchorState} label={t("Suggestions")} role="group" className="quick-add-suggest-popover">
      <ul id="quick-add-suggest" className="quick-add-suggest" role="listbox">
        {items.map((item, i) => (
          <li key={item.key} role="option" aria-selected={i === active} className={classNames("quick-add-suggest-item", i === active && "is-active")}
            // a press must not move focus out of the box
            onMouseDown={(event) => { keepFocus(event); onChoose(item); }}>{item.label}</li>
        ))}
      </ul>
    </Popover>
  );
}
